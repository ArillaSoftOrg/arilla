"""`write_many` (parti) ile `write` (teklif teklif) ayni veritabani durumunu uretir (Faz 3).

Iki ayri magazaya ayni katalog iki gozlemde yazilir: biri tek tek, digeri tek
partide. Ikinci gozlemde fiyat, stok, gorsel ve baslik degisir; teklif, varyant,
fiyat noktasi, stok/fiyat olaylari ve sayaclar karsilastirilir.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import asdict, replace
from datetime import UTC, datetime, timedelta

import psycopg
import pytest

from collect.records import NormalizedOffer, NormalizedVariant
from collect.writer import OfferWriter
from db.connection import database_url

pytestmark = pytest.mark.integration

DOMAINS = ("test-writer-batch-a.example", "test-writer-batch-b.example")


def _owner() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL_OWNER"))


def _cleanup(cur: psycopg.Cursor) -> None:
    offers = """SELECT o.id FROM offer o JOIN merchant m ON m.id = o.merchant_id
                 WHERE m.domain = ANY(%(d)s)"""
    cur.execute(f"DELETE FROM price_point WHERE offer_id IN ({offers})", {"d": list(DOMAINS)})
    cur.execute(f"DELETE FROM offer WHERE id IN ({offers})", {"d": list(DOMAINS)})
    cur.execute("DELETE FROM merchant WHERE domain = ANY(%s)", (list(DOMAINS),))


@pytest.fixture
def merchants() -> Iterator[tuple[int, int]]:
    try:
        owner = _owner()
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")
    with owner:
        with owner.cursor() as cur:
            _cleanup(cur)
            ids = []
            for index, domain in enumerate(DOMAINS):
                cur.execute(
                    """INSERT INTO merchant (slug, name, domain, source_type)
                       VALUES (%s, 'Test', %s, 'shopify') RETURNING id""",
                    (f"test-writer-batch-{index}", domain),
                )
                ids.append(int(cur.fetchone()[0]))  # type: ignore[index]
        owner.commit()
        yield ids[0], ids[1]
        with owner.cursor() as cur:
            _cleanup(cur)
        owner.commit()


def _catalogue(second: bool) -> list[NormalizedOffer]:
    offers = []
    for index in range(12):
        suffix = "-b" if second and index == 5 else ""
        variants = (
            tuple(
                NormalizedVariant(
                    external_id=f"v{size}",
                    size_label=str(size),
                    size_norm=str(size),
                    in_stock=not (second and size == 38 and index % 2 == 0),
                    price_override=(
                        None if size != 40 else 50_000 + index + (500 if second else 0)
                    ),
                )
                for size in (38, 39, 40)
            )
            if index % 3
            else ()
        )
        offers.append(
            NormalizedOffer(
                external_id=f"p{index}",
                url=f"https://shop.example/p{index}",
                title_raw=f"Urun {index}" + (" Yeni" if second and index == 4 else ""),
                current_price=40_000 + index * 10 - (100 if second and index % 4 == 0 else 0),
                list_price=None,
                in_stock=True,
                currency="TRY",
                brand_raw="Marka",
                image_url=f"https://cdn.example/p{index}{suffix}.jpg",
                gtin=None,
                attributes_raw={"renk": "siyah"},
                variants=variants,
            )
        )
    return offers


def _snapshot(merchant_id: int) -> dict[str, object]:
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT external_id, url, title_raw, image_url, attributes_raw, current_price,
                      in_stock, is_active, last_seen_at
                 FROM offer WHERE merchant_id = %s ORDER BY external_id""",
            (merchant_id,),
        )
        offers = cur.fetchall()
        cur.execute(
            """SELECT o.external_id, v.external_id, v.in_stock, v.price_override, v.last_seen_at
                 FROM offer_variant v JOIN offer o ON o.id = v.offer_id
                WHERE o.merchant_id = %s ORDER BY 1, 2""",
            (merchant_id,),
        )
        variants = cur.fetchall()
        cur.execute(
            """SELECT o.external_id, pp.observed_at, pp.price, pp.in_stock
                 FROM price_point pp JOIN offer o ON o.id = pp.offer_id
                WHERE o.merchant_id = %s ORDER BY 1, 2""",
            (merchant_id,),
        )
        points = cur.fetchall()
        cur.execute(
            """SELECT o.external_id, v.external_id, e.in_stock, e.observed_at
                 FROM variant_stock_event e JOIN offer_variant v ON v.id = e.variant_id
                 JOIN offer o ON o.id = v.offer_id WHERE o.merchant_id = %s ORDER BY 1, 2, 4""",
            (merchant_id,),
        )
        stock = cur.fetchall()
        cur.execute(
            """SELECT o.external_id, v.external_id, e.price, e.observed_at
                 FROM variant_price_event e JOIN offer_variant v ON v.id = e.variant_id
                 JOIN offer o ON o.id = v.offer_id WHERE o.merchant_id = %s ORDER BY 1, 2, 4""",
            (merchant_id,),
        )
        prices = cur.fetchall()
    return {
        "offers": offers,
        "variants": variants,
        "points": points,
        "stock": stock,
        "prices": prices,
    }


def test_batch_and_single_writes_produce_the_same_state(merchants: tuple[int, int]) -> None:
    single_id, batch_id = merchants
    first_at = datetime(2026, 10, 10, 8, tzinfo=UTC)
    counts = {}
    for label, merchant_id in (("single", single_id), ("batch", batch_id)):
        totals = []
        for step, observed_at in enumerate((first_at, first_at + timedelta(days=1))):
            offers = _catalogue(second=step == 1)
            with psycopg.connect(database_url()) as conn:
                writer = OfferWriter(conn, merchant_id=merchant_id, observed_at=observed_at)
                if label == "single":
                    ids = [writer.write(offer) for offer in offers]
                else:
                    ids = writer.write_many(offers)
                assert len(ids) == len(offers) == len(set(ids))
                writer.refresh_aggregates()
                conn.commit()
            totals.append(asdict(writer.counts))
        counts[label] = totals

    assert _snapshot(batch_id) == _snapshot(single_id)
    assert counts["batch"] == counts["single"]
    second = counts["batch"][1]
    assert second["offers_updated"] == 12
    assert second["stock_events_written"] > 0
    assert second["variant_price_events_written"] > 0


def test_duplicate_external_ids_in_a_batch_are_rejected(merchants: tuple[int, int]) -> None:
    offer = _catalogue(second=False)[0]
    with psycopg.connect(database_url()) as conn:
        writer = OfferWriter(conn, merchant_id=merchants[0], observed_at=datetime.now(UTC))
        with pytest.raises(ValueError, match="tekrarli"):
            writer.write_many([offer, replace(offer, url="https://shop.example/other")])
        conn.rollback()
