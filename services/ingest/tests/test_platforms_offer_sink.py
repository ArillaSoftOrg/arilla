"""CanonicalListing -> mevcut OfferWriter koprusu (Shopify pilotu, karar 0164).

Birim kismi veritabanisizdir; entegrasyon kismi yerel veritabaninda idempotentligi
(`(merchant_id, external_id)`) dogrular.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime

import psycopg
import pytest

from db.connection import database_url
from platforms.contract import CanonicalListing, Checkpoint
from platforms.flow import run_source
from platforms.offer_sink import STOCK_UNKNOWN, OfferWriterSink, to_normalized_offer
from platforms.shopify_sources import shopify_store_definition

NOW = datetime(2026, 11, 7, 12, 0, tzinfo=UTC)


def _listing(listing_id: str = "1", **over) -> CanonicalListing:
    values = {
        "platform": "test-shopify-sink",
        "listing_id": listing_id,
        "title": "Termos 500 ml",
        "url": f"https://shop.example/products/termos-{listing_id}",
        "currency": "TRY",
        "observed_at": NOW,
        "price": 210_000,
        "list_price": 250_000,
        "in_stock": True,
        "brand": "Stanley",
        "category_path": ("Mutfak", "Termos"),
        "image_urls": ("https://cdn.example/a.jpg", "https://cdn.example/b.jpg"),
    }
    values.update(over)
    return CanonicalListing(**values)


def test_conversion_keeps_seen_fields() -> None:
    offer = to_normalized_offer(_listing(options={"renk": "Siyah"}))
    assert offer.external_id == "1"
    assert (offer.current_price, offer.list_price, offer.currency) == (210_000, 250_000, "TRY")
    assert offer.brand_raw == "Stanley"
    assert offer.category_raw == "Mutfak > Termos"
    assert offer.image_url == "https://cdn.example/a.jpg"
    assert [i.source_url for i in offer.images][:2] == [
        "https://cdn.example/a.jpg",
        "https://cdn.example/b.jpg",
    ]
    assert offer.attributes_raw == {"renk": "Siyah"}
    assert offer.in_stock is True


def test_unknown_stock_follows_0130_convention() -> None:
    offer = to_normalized_offer(_listing(in_stock=None))
    assert offer.in_stock is False
    assert offer.attributes_raw["stock_state"] == STOCK_UNKNOWN


def test_empty_optional_fields_stay_empty() -> None:
    offer = to_normalized_offer(_listing(brand=None, category_path=(), image_urls=()))
    assert (offer.brand_raw, offer.category_raw, offer.image_url, offer.images) == (
        None,
        None,
        None,
        (),
    )


# --- entegrasyon ------------------------------------------------------------------

DOMAIN = "test-shopify-sink.example"


def _cleanup(cur: psycopg.Cursor) -> None:
    offers = "SELECT o.id FROM offer o JOIN merchant m ON m.id = o.merchant_id WHERE m.domain = %s"
    cur.execute(f"DELETE FROM offer_image WHERE offer_id IN ({offers})", (DOMAIN,))
    cur.execute(f"DELETE FROM price_point WHERE offer_id IN ({offers})", (DOMAIN,))
    cur.execute(
        "DELETE FROM offer WHERE merchant_id IN (SELECT id FROM merchant WHERE domain = %s)",
        (DOMAIN,),
    )
    cur.execute("DELETE FROM merchant WHERE domain = %s", (DOMAIN,))


@pytest.fixture
def merchant_id() -> Iterator[int]:
    try:
        owner = psycopg.connect(database_url("DATABASE_URL_OWNER"))
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")
    with owner:
        with owner.cursor() as cur:
            _cleanup(cur)
            cur.execute(
                """INSERT INTO merchant (slug, name, domain, source_type)
                   VALUES ('test-shopify-sink', 'Test', %s, 'shopify') RETURNING id""",
                (DOMAIN,),
            )
            row = cur.fetchone()
        owner.commit()
        assert row is not None
        yield int(row[0])
        with owner.cursor() as cur:
            _cleanup(cur)
        owner.commit()


class _Adapter:
    platform = "test-shopify-sink"
    kind = "api"

    def __init__(self, listings: list[CanonicalListing]) -> None:
        self.listings = listings
        self.checkpoint = Checkpoint()

    def fetch(self, checkpoint: Checkpoint | None = None):
        start = checkpoint.cursor.get("offset", 0) if checkpoint and checkpoint.cursor else 0
        for index, item in enumerate(self.listings[start:], start=start):
            self.checkpoint = Checkpoint({"offset": index + 1}, index + 1)
            yield item


class _Store:
    def __init__(self) -> None:
        self.data: dict[str, Checkpoint] = {}

    def load(self, key: str) -> Checkpoint | None:
        return self.data.get(key)

    def save(self, key: str, checkpoint: Checkpoint) -> None:
        self.data[key] = checkpoint


def _run(conn: psycopg.Connection, merchant_id: int, listings: list[CanonicalListing]):
    constraints = shopify_store_definition(
        slug="test-shopify-sink", name="Test", domain="shop.example"
    ).constraints
    sink = OfferWriterSink(conn, merchant_id)
    result = run_source(
        _Adapter(listings),
        sink,
        constraints,
        store=_Store(),
        clock=lambda: 0.0,
        sleep=lambda _s: None,
    )
    return result, sink


@pytest.mark.integration
def test_rerun_creates_no_duplicate_offers(merchant_id: int) -> None:
    listings = [_listing("1"), _listing("2", in_stock=None), _listing("3", price=99_900)]
    with psycopg.connect(database_url("DATABASE_URL")) as conn:
        result, first = _run(conn, merchant_id, listings)
        assert result.status == "completed"
        assert (first.created, first.updated) == (3, 0)
        _, second = _run(conn, merchant_id, listings)
        assert (second.created, second.updated) == (0, 3)
        with conn.cursor() as cur:
            cur.execute(
                """SELECT external_id, current_price, in_stock, attributes_raw->>'stock_state',
                          brand_raw, product_id
                     FROM offer WHERE merchant_id = %s ORDER BY external_id""",
                (merchant_id,),
            )
            rows = cur.fetchall()
    assert rows == [
        ("1", 210_000, True, None, "Stanley", None),
        ("2", 210_000, False, "unknown", "Stanley", None),
        ("3", 99_900, True, None, "Stanley", None),
    ]
