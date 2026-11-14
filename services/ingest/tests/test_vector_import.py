"""Kontrol noktasi -> `product_text_embedding_d1024` iceri aktarimi (karar 0195).

Gercek yerel PostgreSQL (migration 0114 uygulanmis). Gercek model/BGE vektoru gerekmez: sozlesme
(model, revizyon, ozet, SHA-256, norm, idempotans, devam) deterministik vektorlerle sinanir.
"""

from __future__ import annotations

import json
import math
import random
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path

import psycopg
import pytest

from db import job_run
from db.connection import database_url
from enrich import vector_import as vi
from enrich.offline_embed import CheckpointStore, pack_f16, sha256_bytes
from enrich.product_text import TEXT_VERSION, build_product_text, content_hash, source_hash
from enrich.registry import registry

pytestmark = pytest.mark.integration

PREFIX = "test-vi-"
MODEL = "bge-m3-5617a9f6"
DIM = 1024


def _owner() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL_OWNER"))


def _app() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL"))


def _unit_vector(seed: int) -> list[float]:
    rng = random.Random(seed)
    raw = [rng.gauss(0, 1) for _ in range(DIM)]
    norm = math.sqrt(sum(x * x for x in raw))
    return [x / norm for x in raw]


@dataclass
class Product:
    id: int
    title: str
    brand: str | None


@dataclass
class World:
    owner: psycopg.Connection
    app: psycopg.Connection
    tmp: Path
    serial: int = 0

    def product(self, title: str, brand: str | None = None) -> Product:
        self.serial += 1
        brand_id = None
        with self.owner.cursor() as cur:
            if brand:
                cur.execute(
                    "INSERT INTO brand (slug, name, name_norm) VALUES (%s, %s, %s) RETURNING id",
                    (f"{PREFIX}b{self.serial}", brand, brand.lower()),
                )
                (brand_id,) = cur.fetchone()
            cur.execute(
                """INSERT INTO product (slug, title, brand_id, offer_count)
                   VALUES (%s, %s, %s, 1) RETURNING id""",
                (f"{PREFIX}{self.serial}", title, brand_id),
            )
            (product_id,) = cur.fetchone()
        self.owner.commit()
        return Product(int(product_id), title, brand)

    def set_title(self, product: Product, title: str) -> None:
        with self.owner.cursor() as cur:
            cur.execute("UPDATE product SET title = %s WHERE id = %s", (title, product.id))
        self.owner.commit()

    def delete(self, product: Product) -> None:
        with self.owner.cursor() as cur:
            cur.execute("DELETE FROM product WHERE id = %s", (product.id,))
        self.owner.commit()

    def checkpoint(
        self,
        items: Sequence[Product],
        *,
        per_part: int = 2,
        meta_override: dict | None = None,
    ) -> CheckpointStore:
        spec = registry().get(MODEL)
        store = CheckpointStore(self.tmp / "ckpt")
        store.ensure()
        ordered = sorted(items, key=lambda p: p.id)
        scanned = 0
        for seq, lo in enumerate(range(0, len(ordered), per_part), start=1):
            chunk = ordered[lo : lo + per_part]
            ids = b"".join(p.id.to_bytes(8, "little") for p in chunk)
            hashes = b""
            vectors: list[list[float]] = []
            for p in chunk:
                text = build_product_text(p.title, p.brand)
                hashes += content_hash(spec.id, text) + source_hash(p.title, p.brand)
                vectors.append(_unit_vector(p.id))
            meta = {
                "format": 1,
                "model": spec.id,
                "revision": spec.source["revision"],
                "dimensions": spec.dimensions,
                "normalization": spec.normalization,
                "pooling": spec.pooling,
                "preprocessing_version": spec.preprocessing_version,
                "text_version": TEXT_VERSION,
                "seq": seq,
                "first_id": chunk[0].id,
                "last_id": chunk[-1].id,
                "rows": len(chunk),
                "scanned_after": scanned,
                "scanned_through": chunk[-1].id,
                "unique_texts": len(chunk),
                "rejected_ids": [],
                **(meta_override or {}),
            }
            scanned = chunk[-1].id
            store.write_part(seq, ids, hashes, pack_f16(vectors, DIM), meta)
        return store

    def db_rows(self) -> dict[int, tuple[bytes, str]]:
        with self.owner.cursor() as cur:
            cur.execute(
                """SELECT e.product_id, e.content_hash, e.embedding::text
                     FROM product_text_embedding_d1024 e JOIN product p ON p.id = e.product_id
                    WHERE p.slug LIKE %s AND e.model_version = %s""",
                (PREFIX + "%", MODEL),
            )
            found = {int(r[0]): (bytes(r[1]), r[2]) for r in cur.fetchall()}
        self.owner.commit()
        return found

    def usage(self) -> int:
        with self.owner.cursor() as cur:
            cur.execute(
                "SELECT count(*) FROM api_usage WHERE operation = %s AND model_version = %s",
                (vi.USAGE_OPERATION, MODEL),
            )
            (n,) = cur.fetchone()
        self.owner.commit()
        return int(n)

    def run(self, store: CheckpointStore, **kwargs: object) -> vi.ImportCounts:
        dry = bool(kwargs.pop("dry_run", False))
        should_stop = kwargs.pop("should_stop", lambda: False)
        governor = kwargs.pop("governor", None)
        options = vi.Options(dry_run=dry, **kwargs)  # type: ignore[arg-type]
        spec = registry().get(MODEL)
        return vi.VectorImporter(
            self.app,
            store,
            spec,
            options,
            governor=governor,  # type: ignore[arg-type]
            should_stop=should_stop,  # type: ignore[arg-type]
        ).run()


def _cleanup(cur: psycopg.Cursor) -> None:
    cur.execute("DELETE FROM product WHERE slug LIKE %s", (PREFIX + "%",))
    cur.execute("DELETE FROM brand WHERE slug LIKE %s", (PREFIX + "%",))
    cur.execute(
        "DELETE FROM api_usage WHERE operation = %s AND model_version = %s",
        (vi.USAGE_OPERATION, MODEL),
    )


@pytest.fixture
def world(tmp_path: Path) -> Iterator[World]:
    try:
        owner = _owner()
    except psycopg.OperationalError:
        pytest.skip("yerel PostgreSQL yok")
    app = _app()
    with owner.cursor() as cur:
        _cleanup(cur)
    owner.commit()
    try:
        yield World(owner=owner, app=app, tmp=tmp_path)
    finally:
        app.rollback()
        with owner.cursor() as cur:
            _cleanup(cur)
        owner.commit()
        app.close()
        owner.close()


def _five(world: World) -> list[Product]:
    return [
        world.product(f"Kablosuz Kulaklik Model {i}", "Acme" if i % 2 else None) for i in range(5)
    ]


# --- temel akis ---------------------------------------------------------------------------------


def test_first_import_writes_every_row_exactly_and_rerun_is_a_noop(world: World) -> None:
    items = _five(world)
    store = world.checkpoint(items)
    counts = world.run(store)
    assert (counts.written, counts.present, counts.stale, counts.missing) == (5, 0, 0, 0)
    assert vi.decide_outcome(counts) == ("completed", None)
    rows = world.db_rows()
    assert set(rows) == {p.id for p in items}
    for p in items:
        got = [float(x) for x in rows[p.id][1].strip("[]").split(",")]
        want = _unit_vector(p.id)
        assert max(abs(a - b) for a, b in zip(got, want, strict=True)) < 1e-3
    before = world.db_rows()
    again = world.run(store)
    assert (again.written, again.present) == (0, 5)
    assert vi.decide_outcome(again) == ("no_input", "up_to_date")
    assert world.db_rows() == before  # satirlar degismedi (embedded_at dahil degil: ayni vektor)


def test_dry_run_writes_nothing(world: World) -> None:
    store = world.checkpoint(_five(world))
    counts = world.run(store, dry_run=True)
    assert counts.written == 5  # yazilacak sayi
    assert world.db_rows() == {}
    assert world.usage() == 0


def test_text_changed_product_is_stale_and_not_written(world: World) -> None:
    items = _five(world)
    store = world.checkpoint(items)
    world.set_title(items[1], "Tamamen Baska Bir Baslik")
    counts = world.run(store)
    assert (counts.written, counts.stale) == (4, 1)
    assert items[1].id not in world.db_rows()


def test_deleted_product_is_missing_not_an_error(world: World) -> None:
    items = _five(world)
    store = world.checkpoint(items)
    world.delete(items[2])
    counts = world.run(store)
    assert (counts.written, counts.missing, counts.failed) == (4, 1, 0)
    assert vi.decide_outcome(counts)[0] == "completed"


def test_batch_size_and_max_rows_limit(world: World) -> None:
    store = world.checkpoint(_five(world), per_part=5)
    counts = world.run(store, batch=2, max_rows=2)
    assert counts.written == 2 and counts.limit_reached
    assert vi.decide_outcome(counts) == ("completed", "limit_reached")
    assert len(world.db_rows()) == 2
    rest = world.run(store, batch=2)
    assert (rest.written, rest.present) == (3, 2)
    assert len(world.db_rows()) == 5


def test_interrupted_run_resumes_without_rewriting(world: World) -> None:
    items = [world.product(f"Urun {i} Kablosuz Mouse") for i in range(6)]
    store = world.checkpoint(items, per_part=2)
    calls = {"n": 0}

    def stop_after_first_part() -> bool:
        calls["n"] += 1
        return calls["n"] > 2  # ilk parca bitince (dongu basinda 2 kontrol) durdur

    first = world.run(store, should_stop=stop_after_first_part)
    assert first.interrupted and 0 < first.written < 6
    assert vi.decide_outcome(first) == ("partial", "interrupted")
    second = world.run(store)
    assert second.present == first.written and second.written == 6 - first.written
    assert len(world.db_rows()) == 6


def test_usage_is_recorded_once_per_part_with_new_rows(world: World) -> None:
    store = world.checkpoint(_five(world), per_part=2)  # 3 parca
    world.run(store)
    assert world.usage() == 3
    world.run(store)  # yeni satir yok -> yeni kullanim satiri yok
    assert world.usage() == 3


def test_wal_backpressure_stops_the_run_before_writing(world: World) -> None:
    class Stopped:
        stopped_reason = "lag_high"

        def before_batch(self) -> bool:
            return False

    store = world.checkpoint(_five(world))
    counts = world.run(store, governor=Stopped())
    assert counts.wal_stopped == "lag_high" and counts.written == 0
    assert vi.decide_outcome(counts) == ("partial", "wal_backpressure")
    assert world.db_rows() == {}


def test_existing_jina_table_is_untouched(world: World) -> None:
    with world.owner.cursor() as cur:
        cur.execute("SELECT count(*) FROM product_text_embedding")
        (before,) = cur.fetchone()
    world.owner.commit()
    world.run(world.checkpoint(_five(world)))
    with world.owner.cursor() as cur:
        cur.execute("SELECT count(*) FROM product_text_embedding")
        (after,) = cur.fetchone()
    world.owner.commit()
    assert before == after


# --- sozlesme reddi: hicbir sey yazilmaz ----------------------------------------------------------


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("model", "bge-m3-other"),
        ("revision", "0" * 40),
        ("dimensions", 768),
        ("normalization", "none"),
        ("pooling", "mean"),
        ("preprocessing_version", "product-text-v2"),
        ("text_version", 2),
        ("format", 2),
    ],
)
def test_metadata_mismatch_rejects_the_whole_run(world: World, key: str, value: object) -> None:
    store = world.checkpoint(_five(world), meta_override={key: value})
    counts = world.run(store)
    assert counts.incompatible and key in counts.incompatible
    assert counts.written == 0 and world.db_rows() == {}
    assert vi.decide_outcome(counts) == ("failed", "incompatible_checkpoint")


def test_corrupted_vector_file_is_rejected_by_checksum(world: World) -> None:
    store = world.checkpoint(_five(world), per_part=5)
    path = store.path(1, "f16")
    data = bytearray(path.read_bytes())
    data[10] ^= 0xFF
    path.write_bytes(bytes(data))
    counts = world.run(store)
    assert counts.incompatible and "SHA-256" in counts.incompatible
    assert world.db_rows() == {}


def test_non_unit_or_non_finite_vectors_are_rejected(world: World) -> None:
    items = _five(world)
    store = world.checkpoint(items, per_part=5)
    bad = pack_f16([[0.5] * DIM] + [_unit_vector(p.id) for p in items[1:]], DIM)
    store.path(1, "f16").write_bytes(bad)
    meta_path = store.path(1, "json")
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta["sha256"]["f16"] = sha256_bytes(bad)  # ozet tutarli, norm bozuk
    meta_path.write_text(json.dumps(meta), encoding="utf-8")
    counts = world.run(store)
    assert counts.incompatible and "norm" in counts.incompatible
    assert world.db_rows() == {}


def test_content_hash_of_another_model_is_stale_not_written(world: World) -> None:
    """Ozet model kimligini de tasir: baska modelin kontrol noktasi urune baglanamaz."""
    items = _five(world)
    store = world.checkpoint(items, per_part=5)
    hashes = store.path(1, "hash")
    data = bytearray(hashes.read_bytes())
    data[0] ^= 0x01
    hashes.write_bytes(bytes(data))
    meta_path = store.path(1, "json")
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta["sha256"]["hash"] = sha256_bytes(bytes(data))
    meta_path.write_text(json.dumps(meta), encoding="utf-8")
    counts = world.run(store)
    assert counts.stale == 1 and counts.written == 4


# --- dogrulama --------------------------------------------------------------------------------


def test_verify_detects_tampered_database_vector(world: World) -> None:
    items = _five(world)
    store = world.checkpoint(items)
    world.run(store)
    spec = registry().get(MODEL)
    ok = vi.verify_import(world.app, store, spec, sample=50)
    world.app.rollback()
    assert ok["ok"] and ok["sampled"] == 5 and ok["sample_mismatched"] == 0
    with world.owner.cursor() as cur:
        cur.execute(
            "UPDATE product_text_embedding_d1024 SET embedding = %s::halfvec(1024)"
            " WHERE product_id = %s AND model_version = %s",
            ("[" + ",".join(["0.01"] * DIM) + "]", items[0].id, MODEL),
        )
    world.owner.commit()
    bad = vi.verify_import(world.app, store, spec, sample=50)
    world.app.rollback()
    assert not bad["ok"] and bad["sample_mismatched"] == 1


# --- komut satiri guvenligi -------------------------------------------------------------------


def test_cli_refuses_remote_database_without_allow_remote(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = world.checkpoint(_five(world))
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@db.example.com:5432/arilla")
    code = vi.main(["run", "--ckpt", str(store.root), "--model", MODEL, "--execute"])
    assert code == 2


def test_cli_plan_is_dry_and_writes_nothing(world: World) -> None:
    store = world.checkpoint(_five(world))
    code = vi.main(["plan", "--ckpt", str(store.root), "--model", MODEL])
    assert code == job_run.outcome("completed").exit_code
    assert world.db_rows() == {}
