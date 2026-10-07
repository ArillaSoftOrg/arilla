"""Urun fiyat ozeti (`min_price`, `max_price`, `offer_count`, `in_stock_count`)
teklifi yazan islemle birlikte yenilenir; elle `similarity --prices` beklemez.

Uretim hatasi: toplama/eslestirme yeni urunu `offer_count = 0`,
`min_price = NULL` ile birakiyordu; kart fiyat gosterip "0 magaza" diyor,
butce aramasi urunu hic gormuyordu.

Kurulum SAHIP rolle, boru hatti ve yenileme UYGULAMA rolu (`arilla_app`) ile.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from pathlib import Path

import psycopg
import pytest

from collect.pipeline import run_ingest
from db import product_aggregates
from db.connection import database_url
from resolve.pipeline import resolve_offers

pytestmark = pytest.mark.integration

FEED_SLUG = "test-ozet-feed"
SIDE_SLUG = "test-ozet-yan"
SLUGS = [FEED_SLUG, SIDE_SLUG]
PRODUCT_PREFIX = "test-ozet-"

CLEANUP = (
    """CREATE TEMP TABLE IF NOT EXISTS _ozet_p AS
        SELECT o.product_id FROM offer o JOIN merchant m ON m.id = o.merchant_id
         WHERE m.slug = ANY(%(slugs)s) AND o.product_id IS NOT NULL""",
    """DELETE FROM variant_stock_event WHERE variant_id IN (
        SELECT v.id FROM offer_variant v JOIN offer o ON o.id = v.offer_id
          JOIN merchant m ON m.id = o.merchant_id WHERE m.slug = ANY(%(slugs)s))""",
    """DELETE FROM variant_price_event WHERE variant_id IN (
        SELECT v.id FROM offer_variant v JOIN offer o ON o.id = v.offer_id
          JOIN merchant m ON m.id = o.merchant_id WHERE m.slug = ANY(%(slugs)s))""",
    """DELETE FROM offer_variant WHERE offer_id IN (
        SELECT o.id FROM offer o JOIN merchant m ON m.id = o.merchant_id
         WHERE m.slug = ANY(%(slugs)s))""",
    """DELETE FROM price_point WHERE offer_id IN (
        SELECT o.id FROM offer o JOIN merchant m ON m.id = o.merchant_id
         WHERE m.slug = ANY(%(slugs)s))""",
    """DELETE FROM match_candidate WHERE offer_id IN (
        SELECT o.id FROM offer o JOIN merchant m ON m.id = o.merchant_id
         WHERE m.slug = ANY(%(slugs)s))""",
    "DELETE FROM offer WHERE merchant_id IN (SELECT id FROM merchant WHERE slug = ANY(%(slugs)s))",
    """DELETE FROM ingest_run
        WHERE merchant_id IN (SELECT id FROM merchant WHERE slug = ANY(%(slugs)s))""",
    """DELETE FROM product WHERE slug LIKE 'test-ozet-%%'
        OR id IN (SELECT product_id FROM _ozet_p)""",
    "DROP TABLE _ozet_p",
    "DELETE FROM merchant WHERE slug = ANY(%(slugs)s)",
)

AGGREGATES = """
SELECT offer_count, min_price, max_price, in_stock_count FROM product WHERE id = %s
"""


def _owner() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL_OWNER"))


def _app() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL"))


def _cleanup(cur: psycopg.Cursor) -> None:
    for statement in CLEANUP:
        cur.execute(statement, {"slugs": SLUGS})


def _feed(tmp_path: Path, source: Path, *, drop=(), out_of_stock=()) -> Path:
    """`source` feed'inin kopyasi: `drop` kayitlari cikarilir, `out_of_stock`
    kayitlarinin tum bedenleri stok disi olur."""
    text = source.read_text(encoding="utf-8")

    def edit(match: re.Match[str]) -> str:
        item = match.group(0)
        sku = re.search(r"<g:id>(.*?)</g:id>", item)
        assert sku is not None
        if sku.group(1) in drop:
            return ""
        if sku.group(1) in out_of_stock:
            item = item.replace(">in stock<", ">out of stock<")
        return item

    path = tmp_path / f"feed-{len(list(tmp_path.iterdir()))}.xml"
    path.write_text(re.sub(r"<item>.*?</item>", edit, text, flags=re.S), encoding="utf-8")
    return path


@pytest.fixture
def merchants(feed_v1: Path, xml_feed_config: dict) -> Iterator[dict[str, int]]:
    try:
        owner = _owner()
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")
    config = {**xml_feed_config, "full_dump": True}
    with owner:
        with owner.cursor() as cur:
            _cleanup(cur)
            ids: dict[str, int] = {}
            for slug, feed in ((FEED_SLUG, str(feed_v1)), (SIDE_SLUG, None)):
                cur.execute(
                    """INSERT INTO merchant (slug, name, domain, source_type, feed_url, feed_config)
                       VALUES (%s, 'Test Ozet', %s, 'xml_feed', %s, %s) RETURNING id""",
                    (slug, f"{slug}.example", feed, json.dumps(config)),
                )
                row = cur.fetchone()
                assert row is not None
                ids[slug] = int(row[0])
            for name in ("a", "b", "baska"):
                cur.execute(
                    "INSERT INTO product (slug, title) VALUES (%s, %s) RETURNING id",
                    (f"{PRODUCT_PREFIX}{name}", f"Test ozet {name}"),
                )
                row = cur.fetchone()
                assert row is not None
                ids[name] = int(row[0])
        owner.commit()
        yield ids
        with owner.cursor() as cur:
            _cleanup(cur)
        owner.commit()


def _set_feed(merchant_id: int, path: Path) -> None:
    with _owner() as owner, owner.cursor() as cur:
        cur.execute("UPDATE merchant SET feed_url = %s WHERE id = %s", (str(path), merchant_id))


def _link(merchant_id: int, sku: str, product_id: int) -> None:
    """Gecmiste eslesmis teklif: ozet KASITLI olarak yenilenmez (bayat kalir)."""
    with _owner() as owner, owner.cursor() as cur:
        cur.execute(
            "UPDATE offer SET product_id = %s WHERE merchant_id = %s AND external_id = %s",
            (product_id, merchant_id, sku),
        )
        assert cur.rowcount == 1


def _offer_price(merchant_id: int, sku: str) -> int:
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT current_price FROM offer WHERE merchant_id = %s AND external_id = %s",
            (merchant_id, sku),
        )
        row = cur.fetchone()
        assert row is not None
        return int(row[0])


def _aggregates(product_id: int) -> tuple:
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(AGGREGATES, (product_id,))
        row = cur.fetchone()
        assert row is not None
        return tuple(row)


def _insert_offer(merchant_id: int, sku: str, price: int, product_id: int | None) -> None:
    with _owner() as owner, owner.cursor() as cur:
        cur.execute(
            """INSERT INTO offer (merchant_id, external_id, url, title_raw, current_price,
                                  in_stock, product_id)
               VALUES (%s, %s, %s, %s, %s, TRUE, %s)""",
            (merchant_id, sku, f"https://yan.example/{sku}", f"Test {sku}", price, product_id),
        )


def test_ingest_refreshes_price_of_linked_product(merchants: dict[str, int], feed_v2) -> None:
    feed = merchants[FEED_SLUG]
    with _app() as conn:
        run_ingest(conn, FEED_SLUG)
    _link(feed, "SKU-0005", merchants["a"])
    assert _aggregates(merchants["a"])[0] == 0  # bayat: baglandi ama ozet yok

    with _app() as conn:
        run_ingest(conn, FEED_SLUG)
    before = _offer_price(feed, "SKU-0005")
    assert _aggregates(merchants["a"]) == (1, before, before, 1)

    # v2'de SKU-0005'in fiyati dustu: min/max ayni kosuda izler.
    _set_feed(feed, feed_v2)
    with _app() as conn:
        run_ingest(conn, FEED_SLUG)
    after = _offer_price(feed, "SKU-0005")
    assert after < before
    assert _aggregates(merchants["a"]) == (1, after, after, 1)


def test_ingest_refreshes_stock_and_deactivation(
    merchants: dict[str, int], feed_v1: Path, tmp_path: Path
) -> None:
    feed = merchants[FEED_SLUG]
    with _app() as conn:
        run_ingest(conn, FEED_SLUG)
    _link(feed, "SKU-0001", merchants["a"])
    _link(feed, "SKU-0002", merchants["b"])
    with _app() as conn:
        run_ingest(conn, FEED_SLUG)
    assert _aggregates(merchants["a"])[3] == 1

    _set_feed(feed, _feed(tmp_path, feed_v1, out_of_stock={"SKU-0001"}))
    with _app() as conn:
        run_ingest(conn, FEED_SLUG)
    price = _offer_price(feed, "SKU-0001")
    assert _aggregates(merchants["a"]) == (1, price, price, 0)  # fiyat var, stok yok

    # Tam dokumde gorunmeyen teklif pasiflesir: urun sifirlanir.
    _set_feed(feed, _feed(tmp_path, feed_v1, drop={"SKU-0002"}))
    with _app() as conn:
        result = run_ingest(conn, FEED_SLUG)
    assert result.deactivated == 1
    assert _aggregates(merchants["b"]) == (0, None, None, 0)


def test_resolve_gives_new_product_aggregates_and_budget_visibility(
    merchants: dict[str, int],
) -> None:
    side = merchants[SIDE_SLUG]
    _insert_offer(side, "zqv-1", 123400, None)
    with _app() as conn:
        counts = resolve_offers(conn, merchant_id=side)
        conn.commit()
    assert counts.considered == 1
    assert counts.aggregates_updated == 1

    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT product_id FROM offer WHERE merchant_id = %s AND external_id = 'zqv-1'",
            (side,),
        )
        row = cur.fetchone()
        assert row is not None and row[0] is not None
        product_id = int(row[0])
        # Aramanin butce ve "teklifi var" kosulu (search-sql.ts, find-alternatives).
        cur.execute(
            """SELECT 1 FROM product p
                WHERE p.id = %s AND p.offer_count > 0
                  AND p.min_price >= 100000 AND p.min_price <= 150000""",
            (product_id,),
        )
        assert cur.fetchone() is not None
    offer_count, min_price, _, in_stock = _aggregates(product_id)
    assert offer_count >= 1 and in_stock >= 1 and min_price <= 123400


def test_counts_distinct_active_stores_only(merchants: dict[str, int]) -> None:
    side, feed = merchants[SIDE_SLUG], merchants[FEED_SLUG]
    product = merchants["a"]
    _insert_offer(side, "s-1", 50000, product)
    _insert_offer(side, "s-2", 70000, product)  # ayni magaza, ikinci kayit
    _insert_offer(feed, "f-1", 30000, product)
    with _app() as conn:
        product_aggregates.refresh_products(conn, [product])
        conn.commit()
    assert _aggregates(product) == (2, 30000, 70000, 2)

    # Pasif magazanin teklifi aramada kullanilamaz; ozete de girmez.
    with _owner() as owner, owner.cursor() as cur:
        cur.execute("UPDATE merchant SET is_active = FALSE WHERE id = %s", (feed,))
    with _app() as conn:
        product_aggregates.refresh_products(conn, [product])
        conn.commit()
    assert _aggregates(product) == (1, 50000, 70000, 1)


def test_scoped_refresh_leaves_other_products_untouched(merchants: dict[str, int]) -> None:
    side = merchants[SIDE_SLUG]
    _insert_offer(side, "a-1", 40000, merchants["a"])
    _insert_offer(side, "x-1", 90000, merchants["baska"])
    with _owner() as owner, owner.cursor() as cur:
        cur.execute("SELECT updated_at FROM product WHERE id = %s", (merchants["baska"],))
        row = cur.fetchone()
        assert row is not None
        untouched_at = row[0]

    with _app() as conn:
        updated = product_aggregates.refresh_products(conn, [merchants["a"]])
        again = product_aggregates.refresh_products(conn, [merchants["a"]])
        conn.commit()
    assert (updated, again) == (1, 0)
    assert _aggregates(merchants["a"]) == (1, 40000, 40000, 1)
    # Ayni magazada teklifi olan ama kapsamda olmayan urun okunmaz/yazilmaz.
    assert _aggregates(merchants["baska"]) == (0, None, None, 0)
    with _owner() as conn, conn.cursor() as cur:
        cur.execute("SELECT updated_at FROM product WHERE id = %s", (merchants["baska"],))
        row = cur.fetchone()
        assert row is not None and row[0] == untouched_at


def test_full_repair_is_idempotent(merchants: dict[str, int]) -> None:
    _insert_offer(merchants[SIDE_SLUG], "r-1", 61000, merchants["baska"])
    with _app() as conn:
        first = product_aggregates.refresh_all(conn)
        second = product_aggregates.refresh_all(conn)
        conn.commit()
    assert first >= 1
    assert second == 0
    assert _aggregates(merchants["baska"]) == (1, 61000, 61000, 1)
