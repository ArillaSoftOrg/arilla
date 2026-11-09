"""Embedding indeks yasam dongusu (karar 0181): kayit, golge, atomik gecis, rollback, kapsam.

Yerel test veritabani ister (migration 0110). Her test `embedding_index`'i tohum durumuna
(yalniz `jina-embeddings-v3` active) geri getirir.
"""

from __future__ import annotations

import json
from collections.abc import Iterator

import psycopg
import pytest

from db.connection import database_url
from enrich import index, products
from enrich.client import FakeEmbeddingClient
from enrich.registry import REGISTRY_PATH, parse_registry

pytestmark = pytest.mark.integration

E5 = "e5-small-int8-0bcc8ca76950"
V3 = "jina-embeddings-v3"
PREFIX = "test-eidx-"


def _ready_registry():
    """e5 kayit defterinde uretime hazirmis gibi (yalniz test): etkinlestirme yolu sinanir."""
    raw = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    for model in raw["models"]:
        if model["id"] == E5:
            model["state"] = "shadow"
            model["license_verified"] = True
    return parse_registry(raw)


def _reset(owner: psycopg.Connection) -> None:
    with owner.cursor() as cur:
        cur.execute("DELETE FROM product WHERE slug LIKE %s", (PREFIX + "%",))
        cur.execute("DELETE FROM api_usage WHERE model_version IN (%s, %s)", (E5, V3))
        cur.execute("DELETE FROM embedding_index WHERE model_version <> %s", (V3,))
        cur.execute(
            """UPDATE embedding_index
                  SET state = 'active', activated_at = coalesce(activated_at, now()),
                      retired_at = NULL
                WHERE target = 'product_text' AND model_version = %s""",
            (V3,),
        )
    owner.commit()


@pytest.fixture
def conns() -> Iterator[tuple[psycopg.Connection, psycopg.Connection]]:
    try:
        owner = psycopg.connect(database_url("DATABASE_URL_OWNER"))
    except psycopg.OperationalError:
        pytest.skip("yerel PostgreSQL yok")
    app = psycopg.connect(database_url("DATABASE_URL"))
    _reset(owner)
    try:
        yield owner, app
    finally:
        app.rollback()
        _reset(owner)
        app.close()
        owner.close()


def _states(app: psycopg.Connection) -> dict[str, str]:
    found = {row.model_version: row.state for row in index.rows(app)}
    app.rollback()
    return found


def _products(owner: psycopg.Connection, count: int) -> list[int]:
    ids = []
    with owner.cursor() as cur:
        for i in range(count):
            cur.execute(
                "INSERT INTO product (slug, title, offer_count) VALUES (%s, %s, 1) RETURNING id",
                (f"{PREFIX}{i}", f"Index Test Product {i} Mouse"),
            )
            ids.append(int(cur.fetchone()[0]))
    owner.commit()
    return ids


def test_seed_row_marks_current_production_index_active(conns) -> None:
    _, app = conns
    assert _states(app) == {V3: "active"}


def test_dry_run_changes_nothing(conns) -> None:
    _, app = conns
    plan = index.run(app, "register", model=E5)
    assert plan.detail["storage_table"] == "product_text_embedding_d384"
    assert _states(app) == {V3: "active"}


def test_register_rejects_models_without_storage_or_disabled(conns) -> None:
    _, app = conns
    with pytest.raises(index.IndexTransitionError):
        index.run(app, "register", model="bge-m3", execute=True)
    with pytest.raises(index.IndexTransitionError):
        index.run(app, "register", model="jina-clip-v2", execute=True)
    assert _states(app) == {V3: "active"}


def test_full_lifecycle_atomic_switch_and_rollback(conns) -> None:
    owner, app = conns
    reg = _ready_registry()
    ids = _products(owner, 3)
    # Backfill: aktif indekse dokunmadan aday tabloya yazar.
    client = FakeEmbeddingClient(model=E5, dimensions=384)
    counts = products.embed_products(app, client, products.Options(dry_run=False, ids=ids))
    assert counts.written == 3

    index.run(app, "register", model=E5, execute=True, reg=reg)
    assert _states(app) == {V3: "active", E5: "building"}
    with pytest.raises(index.IndexTransitionError, match="yalniz shadow"):
        index.run(app, "activate", model=E5, execute=True, reg=reg, min_coverage=0.0)

    index.run(app, "shadow", model=E5, execute=True, reg=reg)
    # Kapsam esigi: seed urunlerinin vektoru yok, %100 istenirse reddedilir.
    with pytest.raises(index.IndexTransitionError, match="kapsam"):
        index.run(app, "activate", model=E5, execute=True, reg=reg, min_coverage=1.0)
    assert _states(app) == {V3: "active", E5: "shadow"}

    plan = index.run(app, "activate", model=E5, execute=True, reg=reg, min_coverage=0.0)
    assert plan.detail["previous"] == V3 and plan.detail["covered"] == 3
    assert _states(app) == {V3: "retired", E5: "active"}

    plan = index.run(app, "rollback", execute=True, reg=reg)
    assert plan.detail == {"model": V3, "previous": E5}
    assert _states(app) == {V3: "active", E5: "retired"}

    with pytest.raises(index.IndexTransitionError, match="emekli edilemez"):
        index.run(app, "retire", model=V3, execute=True, reg=reg)


def test_pilot_model_cannot_be_activated_with_shipped_registry(conns) -> None:
    _, app = conns
    reg = _ready_registry()
    index.run(app, "register", model=E5, execute=True, reg=reg)
    index.run(app, "shadow", model=E5, execute=True, reg=reg)
    with pytest.raises(index.IndexTransitionError, match="uretime hazir degil"):
        index.run(app, "activate", model=E5, execute=True, min_coverage=0.0)
    assert _states(app)[V3] == "active"


def test_database_allows_only_one_active_per_target(conns) -> None:
    owner, app = conns
    index.run(app, "register", model=E5, execute=True, reg=_ready_registry())
    with owner.cursor() as cur, pytest.raises(psycopg.errors.UniqueViolation):
        cur.execute(
            """UPDATE embedding_index SET state = 'active', activated_at = now()
                WHERE model_version = %s""",
            (E5,),
        )
    owner.rollback()


def test_app_role_cannot_delete_index_rows(conns) -> None:
    _, app = conns
    with app.cursor() as cur, pytest.raises(psycopg.errors.InsufficientPrivilege):
        cur.execute("DELETE FROM embedding_index")
    app.rollback()


def test_compare_reports_neighbour_overlap(conns) -> None:
    owner, app = conns
    reg = _ready_registry()
    ids = _products(owner, 6)
    opts = products.Options(dry_run=False, ids=ids)
    products.embed_products(app, FakeEmbeddingClient(model=V3), opts)
    products.embed_products(app, FakeEmbeddingClient(model=E5, dimensions=384), opts)
    index.run(app, "register", model=E5, execute=True, reg=reg)
    result = index.compare(app, E5, sample=6, k=3, reg=reg)
    assert result["active"] == V3 and result["candidate"] == E5
    assert result["sampled"] == 6 and 0.0 <= result["jaccard_mean"] <= 1.0
    assert _states(app) == {V3: "active", E5: "building"}
