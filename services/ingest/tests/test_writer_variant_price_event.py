"""Varyant fiyat olaylari yalnizca ilk gorulmede ve degisimde (0026, 0037)."""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import replace
from datetime import UTC, datetime, timedelta

import psycopg
import pytest

from collect.records import NormalizedOffer, NormalizedVariant
from collect.writer import OfferWriter
from db.connection import database_url

pytestmark = pytest.mark.integration

DOMAIN = "test-varyant-fiyat.example"


def _owner() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL_OWNER"))


def _cleanup(cur: psycopg.Cursor) -> None:
    offers = """SELECT o.id FROM offer o JOIN merchant m ON m.id = o.merchant_id
                 WHERE m.domain = %(d)s"""
    cur.execute(f"DELETE FROM price_point WHERE offer_id IN ({offers})", {"d": DOMAIN})
    cur.execute(f"DELETE FROM offer WHERE id IN ({offers})", {"d": DOMAIN})
    cur.execute("DELETE FROM merchant WHERE domain = %s", (DOMAIN,))


@pytest.fixture
def merchant_id() -> Iterator[int]:
    try:
        owner = _owner()
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")
    with owner:
        with owner.cursor() as cur:
            _cleanup(cur)
            cur.execute(
                """INSERT INTO merchant (slug, name, domain, source_type)
                   VALUES ('test-varyant-fiyat', 'Test', %s, 'shopify') RETURNING id""",
                (DOMAIN,),
            )
            row = cur.fetchone()
        owner.commit()
        assert row is not None
        yield int(row[0])
        with owner.cursor() as cur:
            _cleanup(cur)
        owner.commit()


def _offer(price_100: int) -> NormalizedOffer:
    return NormalizedOffer(
        external_id="mist",
        url=f"https://{DOMAIN}/mist",
        title_raw="Rescue Mist",
        current_price=67_000,
        list_price=None,
        in_stock=True,
        currency="TRY",
        variants=(
            NormalizedVariant("60", "60ml", "60ml", True, price_override=67_000),
            NormalizedVariant("100", "100ml", "100ml", True, price_override=price_100),
        ),
    )


def _events(conn: psycopg.Connection) -> list[tuple[str, int]]:
    return conn.execute(
        """SELECT ov.size_label, e.price FROM variant_price_event e
             JOIN offer_variant ov ON ov.id = e.variant_id
             JOIN offer o ON o.id = ov.offer_id JOIN merchant m ON m.id = o.merchant_id
            WHERE m.domain = %s ORDER BY e.observed_at, ov.size_label""",
        (DOMAIN,),
    ).fetchall()


def test_price_events_only_on_first_sight_and_change(merchant_id: int) -> None:
    t0 = datetime(2026, 9, 20, 8, tzinfo=UTC)
    with _owner() as conn:
        OfferWriter(conn, merchant_id=merchant_id, observed_at=t0).write(_offer(111_800))
        conn.commit()
        # Ayni fiyatla yeniden toplama: yeni olay YOK.
        again = OfferWriter(conn, merchant_id=merchant_id, observed_at=t0 + timedelta(days=1))
        again.write(_offer(111_800))
        conn.commit()
        assert again.counts.variant_price_events_written == 0
        # Yalnizca 100 ml degisir: yalnizca onun olayi.
        changed = OfferWriter(conn, merchant_id=merchant_id, observed_at=t0 + timedelta(days=2))
        changed.write(replace(_offer(105_000)))
        conn.commit()
        assert changed.counts.variant_price_events_written == 1

        assert _events(conn) == [("100ml", 111_800), ("60ml", 67_000), ("100ml", 105_000)]
