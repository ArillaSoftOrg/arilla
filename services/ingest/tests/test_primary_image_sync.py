"""product.primary_image_url kaynak offer'i izler (karar 0073)."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime

import psycopg
import pytest

from collect.records import NormalizedOffer
from collect.writer import OfferWriter
from db.connection import database_url

pytestmark = pytest.mark.integration

DOMAINS = ("test-sync-a.example", "test-sync-b.example")


@pytest.fixture
def env() -> Iterator[tuple[psycopg.Connection, int, int]]:
    try:
        conn = psycopg.connect(database_url("DATABASE_URL_OWNER"))
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")

    def clean() -> None:
        conn.rollback()
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM price_point WHERE offer_id IN (SELECT o.id FROM offer o "
                "JOIN merchant m ON m.id = o.merchant_id WHERE m.domain = ANY(%s))",
                (list(DOMAINS),),
            )
            cur.execute(
                "DELETE FROM offer WHERE merchant_id IN "
                "(SELECT id FROM merchant WHERE domain = ANY(%s))",
                (list(DOMAINS),),
            )
            cur.execute("DELETE FROM product WHERE slug LIKE 'test-sync-%'")
            cur.execute("DELETE FROM merchant WHERE domain = ANY(%s)", (list(DOMAINS),))
        conn.commit()

    clean()
    ids = []
    with conn.cursor() as cur:
        for slug, domain in zip(("test-sync-a", "test-sync-b"), DOMAINS, strict=True):
            cur.execute(
                "INSERT INTO merchant (slug, name, domain, source_type) "
                "VALUES (%s, 'T', %s, 'shopify') RETURNING id",
                (slug, domain),
            )
            ids.append(int(cur.fetchone()[0]))
    conn.commit()
    yield conn, ids[0], ids[1]
    clean()
    conn.close()


def _offer(external_id: str, image_url: str | None) -> NormalizedOffer:
    return NormalizedOffer(
        external_id=external_id,
        url="https://x.example/p",
        title_raw="Urun",
        current_price=1000,
        list_price=None,
        in_stock=True,
        currency="TRY",
        image_url=image_url,
    )


def _write(conn, merchant_id: int, offer: NormalizedOffer) -> int:
    offer_id = OfferWriter(conn, merchant_id, datetime(2026, 10, 7, tzinfo=UTC)).write(offer)
    conn.commit()
    return offer_id


def _attach(conn, offer_id: int, slug: str, primary: str | None) -> int:
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO product (slug, title, primary_image_url) "
            "VALUES (%s, 'P', %s) RETURNING id",
            (slug, primary),
        )
        product_id = int(cur.fetchone()[0])
        cur.execute("UPDATE offer SET product_id = %s WHERE id = %s", (product_id, offer_id))
    conn.commit()
    return product_id


def _primary(conn, product_id: int) -> str | None:
    with conn.cursor() as cur:
        cur.execute("SELECT primary_image_url FROM product WHERE id = %s", (product_id,))
        return cur.fetchone()[0]


def test_product_follows_its_source_offer_image_change(env) -> None:
    conn, a, _ = env
    offer_id = _write(conn, a, _offer("p1", "https://cdn.example/old.jpg"))
    product_id = _attach(conn, offer_id, "test-sync-1", "https://cdn.example/old.jpg")
    _write(conn, a, _offer("p1", "https://cdn.example/new.jpg"))
    assert _primary(conn, product_id) == "https://cdn.example/new.jpg"


def test_unchanged_image_does_not_touch_product(env) -> None:
    conn, a, _ = env
    offer_id = _write(conn, a, _offer("p1", "https://cdn.example/x.jpg"))
    product_id = _attach(conn, offer_id, "test-sync-1", "https://cdn.example/x.jpg")
    with conn.cursor() as cur:
        cur.execute("SELECT xmin::text FROM product WHERE id = %s", (product_id,))
        before = cur.fetchone()[0]
    _write(conn, a, _offer("p1", "https://cdn.example/x.jpg"))
    with conn.cursor() as cur:
        cur.execute("SELECT xmin::text FROM product WHERE id = %s", (product_id,))
        assert cur.fetchone()[0] == before


def test_other_merchants_offer_does_not_change_the_products_image(env) -> None:
    conn, a, b = env
    offer_a = _write(conn, a, _offer("p1", "https://cdn.example/a.jpg"))
    product_id = _attach(conn, offer_a, "test-sync-1", "https://cdn.example/a.jpg")
    offer_b = _write(conn, b, _offer("p9", "https://cdn.example/b-old.jpg"))
    with conn.cursor() as cur:
        cur.execute("UPDATE offer SET product_id = %s WHERE id = %s", (product_id, offer_b))
    conn.commit()
    _write(conn, b, _offer("p9", "https://cdn.example/b-new.jpg"))
    assert _primary(conn, product_id) == "https://cdn.example/a.jpg"
    _write(conn, a, _offer("p1", "https://cdn.example/a-new.jpg"))
    assert _primary(conn, product_id) == "https://cdn.example/a-new.jpg"


def test_manually_set_or_foreign_primary_is_left_alone(env) -> None:
    conn, a, _ = env
    offer_id = _write(conn, a, _offer("p1", "https://cdn.example/old.jpg"))
    product_id = _attach(conn, offer_id, "test-sync-1", "https://cdn.example/curated.jpg")
    _write(conn, a, _offer("p1", "https://cdn.example/new.jpg"))
    assert _primary(conn, product_id) == "https://cdn.example/curated.jpg"


def test_unmatched_offer_and_missing_image_are_ignored(env) -> None:
    conn, a, _ = env
    _write(conn, a, _offer("p1", "https://cdn.example/old.jpg"))
    _write(conn, a, _offer("p1", "https://cdn.example/new.jpg"))  # urun yok: hata yok
    offer_id = _write(conn, a, _offer("p2", "https://cdn.example/k.jpg"))
    product_id = _attach(conn, offer_id, "test-sync-2", "https://cdn.example/k.jpg")
    _write(conn, a, _offer("p2", None))  # kaynak gorseli kaldirdi: urunun gorseli silinmez
    assert _primary(conn, product_id) == "https://cdn.example/k.jpg"
