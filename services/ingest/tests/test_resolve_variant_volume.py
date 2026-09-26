"""Metin yolunda hacim uyumu (docs/decisions/0033).

Urun ailesi != satilabilir varyant: 60/100 ml satan bir urune, barkodu olmayan
"... 50 ml" teklifi metinle yaklasabilir ama otomatik birlesmez (REVIEW).
Ayni hacim (100 ml) otomatik kabul edilebilir.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import UTC, datetime

import psycopg
import pytest

from collect.records import NormalizedOffer, NormalizedVariant
from collect.writer import OfferWriter
from db.connection import database_url
from resolve.pipeline import resolve_offers

pytestmark = pytest.mark.integration

BRAND = "Testhacimmarka"
DOMAINS = ("test-hacim-a.example", "test-hacim-b.example")
TITLE = f"{BRAND} Hyaluronic Calming Rescue Mist"


def _owner() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL_OWNER"))


def _cleanup(cur: psycopg.Cursor) -> None:
    offers = """SELECT o.id FROM offer o JOIN merchant m ON m.id = o.merchant_id
                 WHERE m.domain = ANY(%(d)s)"""
    cur.execute(
        f"""CREATE TEMP TABLE IF NOT EXISTS _tp AS
            SELECT DISTINCT product_id FROM offer WHERE id IN ({offers})""",
        {"d": list(DOMAINS)},
    )
    cur.execute(f"DELETE FROM match_candidate WHERE offer_id IN ({offers})", {"d": list(DOMAINS)})
    cur.execute(f"DELETE FROM price_point WHERE offer_id IN ({offers})", {"d": list(DOMAINS)})
    cur.execute(f"DELETE FROM offer WHERE id IN ({offers})", {"d": list(DOMAINS)})
    cur.execute("DELETE FROM product WHERE id IN (SELECT product_id FROM _tp)")
    cur.execute("DROP TABLE _tp")
    cur.execute("DELETE FROM merchant WHERE domain = ANY(%s)", (list(DOMAINS),))
    cur.execute("DELETE FROM brand WHERE name = %s", (BRAND,))


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
                    """INSERT INTO merchant (slug, name, domain, source_type, feed_config)
                       VALUES (%s, %s, %s, 'shopify', %s) RETURNING id""",
                    (f"test-hacim-{index}", f"Test {index}", domain, json.dumps({})),
                )
                ids.append(int(cur.fetchone()[0]))
        owner.commit()
        yield ids[0], ids[1]
        with owner.cursor() as cur:
            _cleanup(cur)
        owner.commit()


def _write(conn, merchant_id: int, external_id: str, title: str, variants=()) -> int:
    offer = NormalizedOffer(
        external_id=external_id,
        url=f"https://{DOMAINS[0]}/p/{external_id}",
        title_raw=title,
        current_price=100000,
        list_price=None,
        in_stock=True,
        brand_raw=BRAND,
        currency="TRY",
        variants=tuple(variants),
    )
    return OfferWriter(conn, merchant_id=merchant_id, observed_at=datetime.now(UTC)).write(offer)


def _status(conn, offer_id: int) -> str | None:
    row = conn.execute(
        "SELECT status FROM match_candidate WHERE offer_id = %s", (offer_id,)
    ).fetchone()
    return row[0] if row else None


def test_text_match_to_unsold_volume_goes_to_review(merchants: tuple[int, int]) -> None:
    merchant_a, merchant_b = merchants
    with _owner() as conn:
        _write(
            conn,
            merchant_a,
            "A1",
            TITLE,
            variants=[
                NormalizedVariant("1", "60ml", "60ml", True),
                NormalizedVariant("2", "100ml", "100ml", True),
            ],
        )
        conn.commit()
        resolve_offers(conn, merchant_id=merchant_a)
        conn.commit()

        # 50 ml once cozulur: 100 ml once baglansaydi ayni merchant dislamasi
        # 50 ml'yi zaten adaydan cikarirdi (baska bir kural).
        other_volume = _write(conn, merchant_b, "B50", f"{TITLE} 50 ml")
        same_volume = _write(conn, merchant_b, "B100", f"{TITLE} 100 ml")
        conn.commit()
        resolve_offers(conn, merchant_id=merchant_b)
        conn.commit()

        assert _status(conn, same_volume) == "auto_accepted"
        assert _status(conn, other_volume) == "pending"
