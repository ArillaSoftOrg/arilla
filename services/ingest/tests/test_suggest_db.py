"""Hibrit oneri hattinin gercek PostgreSQL ile salt okunurlugu (karar 0155).

Dogrulananlar: veritabanindan okuma (kimlik sirasi, magaza filtresi, mevcut kategori bilgisi),
baglanti salt okunur (yazma denemesi reddedilir), kosu bitince urun kategorisi, siniflandirma
kayitlari, `classifier_scope` ve `job_run` AYNEN kalir (hicbir sey yazilmaz).
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import psycopg
import pytest
from test_classify_dynamic_db import PRODUCTS, SLUG, _app, world  # noqa: F401
from test_suggest import FakeEmbedder

from classify.dynamic import DynamicIndex
from classify.scope import trendyol_scopes
from classify.suggest.batch import Runner, db_batches
from classify.suggest.engine import CategoryRow, Suggester, TreeIndex, tree_version

pytestmark = pytest.mark.integration


def _snapshot(conn: psycopg.Connection) -> tuple:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, category_id FROM product WHERE title LIKE %s ORDER BY id", ("%Battery%",)
        )
        products = cur.fetchall()
        cur.execute("SELECT count(*) FROM product_classification")
        classified = cur.fetchone()[0]  # type: ignore[index]
        cur.execute("SELECT count(*) FROM classifier_scope")
        scopes = cur.fetchone()[0]  # type: ignore[index]
        cur.execute("SELECT coalesce(max(id), 0) FROM job_run")
        jobs = cur.fetchone()[0]  # type: ignore[index]
    conn.rollback()
    return products, classified, scopes, jobs


def test_oneri_kosusu_salt_okunur_ve_kategori_degistirmez(
    world: dict[str, int],
    tmp_path: Path,  # noqa: F811
) -> None:
    with _app() as conn:
        conn.read_only = True
        before = _snapshot(conn)
        with conn.cursor() as cur:
            cur.execute("SELECT id, path, name FROM category")
            rows = [CategoryRow(int(r[0]), str(r[1]), str(r[2])) for r in cur.fetchall()]
        conn.rollback()
        emb = FakeEmbedder()
        index = TreeIndex.build(rows, emb)
        index.calibrate(emb.encode([t for _, t, _ in PRODUCTS] + ["Random Item", "Other Thing"]))
        dyn = DynamicIndex([(r.path, r.name) for r in rows], trendyol_scopes(conn))
        runner = Runner(
            tmp_path / "out",
            Suggester(index, dyn, emb),
            model_version="fake-1",
            tree_version=tree_version(rows),
        )
        summary = runner.run(
            lambda after: db_batches(conn, after_id=after, size=2, merchant_slug=SLUG)
        )
        assert summary["toplam"] == len(PRODUCTS)

        # Salt okunur baglanti: yazma denemesi veritabanindan reddedilir.
        with pytest.raises(psycopg.errors.ReadOnlySqlTransaction), conn.cursor() as cur:
            cur.execute("UPDATE product SET title = title WHERE id = %s", (world["batt"],))
        conn.rollback()
        after = _snapshot(conn)
    assert before == after

    recs = [
        json.loads(x)
        for x in (tmp_path / "out" / "suggestions.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    assert sorted(r["product_id"] for r in recs) == sorted(
        world[k] for k in ("batt", "laptop", "plain", "manual")
    )
    by_id = {r["product_id"]: r for r in recs}
    # Mevcut (elle) kategori yalniz bilgi olarak tasinir; oneri onu degistirmez.
    assert by_id[world["manual"]]["current_category_id"] == world["mutfak"]
    assert by_id[world["batt"]]["current_category_id"] is None
    assert all(r["status"] in {"guclu", "orta", "inceleme"} for r in recs)
    assert all(len(r["candidates"]) <= 3 for r in recs)
    assert np.isclose(float(np.linalg.norm(emb.encode(["x"])[0])), 1.0)


def test_db_partileri_kimlik_sirasiyla_ve_kaldigi_yerden(world: dict[str, int]) -> None:  # noqa: F811
    with _app() as conn:
        conn.read_only = True
        ids = [
            r.product_id
            for b in db_batches(conn, after_id=0, size=2, merchant_slug=SLUG)
            for r in b
        ]
        assert ids == sorted(ids) and len(ids) == len(PRODUCTS)
        tail = [
            r.product_id
            for b in db_batches(conn, after_id=ids[1], size=2, merchant_slug=SLUG)
            for r in b
        ]
        assert tail == ids[2:]
