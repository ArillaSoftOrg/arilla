"""Trend eslestirme isi - gercek yerel Postgres (kuru kosu, yazim, idempotans, esik temizligi)."""

from __future__ import annotations

from collections.abc import Iterator

import psycopg
import pytest

import curate.trends as trends_mod
from curate.selection import MIN_PUBLIC_PRODUCTS, Profile
from curate.trends import is_local_url, run
from db.connection import database_url

pytestmark = pytest.mark.integration

SLUG = "test-curate-trend"
SLUG_FEW = "test-curate-few"
PREFIX = "test-curate"
PROFILES = {
    SLUG: Profile(SLUG, core=("kurasyon kazak",), categories=()),
    SLUG_FEW: Profile(SLUG_FEW, core=("kurasyon esarp",), categories=()),
}


@pytest.fixture
def conn(monkeypatch: pytest.MonkeyPatch) -> Iterator[psycopg.Connection]:
    try:
        connection = psycopg.connect(database_url("DATABASE_URL_OWNER"))
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")

    def clean() -> None:
        connection.rollback()
        with connection.cursor() as cur:
            cur.execute("DELETE FROM trend WHERE slug LIKE %s", (f"{PREFIX}%",))
            cur.execute(
                "DELETE FROM offer WHERE merchant_id IN (SELECT id FROM merchant WHERE slug = %s)",
                (f"{PREFIX}-m",),
            )
            cur.execute("DELETE FROM product WHERE slug LIKE %s", (f"{PREFIX}%",))
            cur.execute("DELETE FROM merchant WHERE slug = %s", (f"{PREFIX}-m",))
        connection.commit()

    try:
        to_skip = False
        with connection.cursor() as cur:
            cur.execute("SELECT to_regclass('trend') IS NULL")
            to_skip = bool(cur.fetchone()[0])
        if to_skip:
            pytest.skip("trend tablosu yok (0056 uygulanmamis)")
        clean()
        with connection.cursor() as cur:
            cur.execute(
                "INSERT INTO merchant (slug, name, domain, source_type) "
                "VALUES (%s, 'Test', 'test-curate.example', 'user_discovered') RETURNING id",
                (f"{PREFIX}-m",),
            )
            merchant_id = cur.fetchone()[0]
            for i in range(6):
                cur.execute(
                    "INSERT INTO product "
                    "(slug, title, primary_image_url, min_price, in_stock_count, offer_count) "
                    "VALUES (%s, %s, %s, %s, 1, 1) RETURNING id",
                    (
                        f"{PREFIX}-p{i}",
                        f"Kurasyon Kazak model{chr(97 + i)} desen{i}" + (" Yün" if i == 0 else ""),
                        f"https://img.test.example/{i}.jpg",
                        10_000 + i,
                    ),
                )
                product_id = cur.fetchone()[0]
                cur.execute(
                    "INSERT INTO offer "
                    "(merchant_id, product_id, external_id, url, title_raw, current_price) "
                    "VALUES (%s, %s, %s, 'https://test-curate.example/x', 't', %s)",
                    (merchant_id, product_id, f"ext{i}", 10_000 + i),
                )
            # Stokta olmayan ve gorselsiz urun aday olmaz.
            cur.execute(
                "INSERT INTO product (slug, title, primary_image_url, min_price, in_stock_count) "
                "VALUES (%s, 'Kurasyon Kazak stoksuz', 'https://img.test.example/s.jpg', 100, 0)",
                (f"{PREFIX}-sold-out",),
            )
            cur.execute(
                "INSERT INTO trend (slug, title, description, category, status) VALUES "
                "(%s, 'Test', 'Test.', 'moda', 'published'), "
                "(%s, 'Az', 'Az.', 'moda', 'published')",
                (SLUG, SLUG_FEW),
            )
            # Az urunlu trendin eski baglari temizlenmeli.
            cur.execute(
                "INSERT INTO trend_product (trend_id, product_id, sort_order) "
                "SELECT t.id, p.id, 0 FROM trend t, product p WHERE t.slug = %s AND p.slug = %s",
                (SLUG_FEW, f"{PREFIX}-p1"),
            )
        connection.commit()
        monkeypatch.setattr(trends_mod, "BY_SLUG", PROFILES)
        yield connection
    finally:
        clean()
        connection.close()


def links(conn: psycopg.Connection, slug: str) -> list[str]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT p.slug FROM trend_product tp JOIN trend t ON t.id = tp.trend_id "
            "JOIN product p ON p.id = tp.product_id WHERE t.slug = %s ORDER BY tp.sort_order",
            (slug,),
        )
        return [row[0] for row in cur.fetchall()]


def test_dry_run_writes_nothing(conn: psycopg.Connection):
    results = run(conn, apply=False, slugs=[SLUG])
    assert results[0].count == 6
    assert links(conn, SLUG) == []


def test_apply_orders_by_score_excludes_unfit_and_is_idempotent(conn: psycopg.Connection):
    run(conn, apply=True, slugs=[SLUG])
    first = links(conn, SLUG)
    assert len(first) == 6
    assert first[0] == f"{PREFIX}-p0"  # "Yun" boost'u olan en iyi eslesme
    assert f"{PREFIX}-sold-out" not in first
    run(conn, apply=True, slugs=[SLUG])
    assert links(conn, SLUG) == first


def test_below_threshold_clears_stale_links(conn: psycopg.Connection):
    assert links(conn, SLUG_FEW) == [f"{PREFIX}-p1"]
    results = run(conn, apply=True, slugs=[SLUG_FEW])
    assert results[0].count == 0
    assert links(conn, SLUG_FEW) == []
    assert MIN_PUBLIC_PRODUCTS == 4


def test_is_local_url():
    assert is_local_url("postgresql://u:p@localhost:5432/db")
    assert is_local_url("postgresql://u:p@127.0.0.1/db")
    assert not is_local_url("postgresql://u:p@aws-1-eu-west-1.pooler.supabase.com:5432/postgres")
    assert not is_local_url("not a url")
