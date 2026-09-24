"""Ayni magazanin iki kaydi ayni urune baglanmaz (docs/decisions/0027).

Bootstrap katalogunda gorulen hata: Shopify renk kardesleri ve tekil parcalar
(ayni baslikli iki hali) baslik benzerligiyle tek urune birlesiyordu.
"""

from __future__ import annotations

from collections.abc import Iterator

import psycopg
import pytest

from db.connection import database_url
from resolve.pipeline import resolve_offers

pytestmark = pytest.mark.integration

DOMAIN = "test-resolve-ayni-magaza.example"
CLEANUP = (
    """DELETE FROM match_candidate WHERE offer_id IN (
        SELECT o.id FROM offer o JOIN merchant m ON m.id = o.merchant_id
         WHERE m.domain = %(domain)s)""",
    """CREATE TEMP TABLE IF NOT EXISTS _p AS SELECT o.product_id FROM offer o
        JOIN merchant m ON m.id = o.merchant_id WHERE m.domain = %(domain)s""",
    "DELETE FROM offer WHERE merchant_id IN (SELECT id FROM merchant WHERE domain = %(domain)s)",
    "DELETE FROM product WHERE id IN (SELECT product_id FROM _p WHERE product_id IS NOT NULL)",
    "DROP TABLE _p",
    "DELETE FROM merchant WHERE domain = %(domain)s",
)


def _owner() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL_OWNER"))


@pytest.fixture
def merchant_id() -> Iterator[int]:
    try:
        owner = _owner()
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")
    with owner:
        with owner.cursor() as cur:
            for statement in CLEANUP:
                cur.execute(statement, {"domain": DOMAIN})
            cur.execute(
                """INSERT INTO merchant (slug, name, domain, source_type)
                   VALUES ('test-ayni-magaza', 'Test', %s, 'shopify') RETURNING id""",
                (DOMAIN,),
            )
            row = cur.fetchone()
            assert row is not None
            mid = int(row[0])
            for external_id in ("rug-1", "rug-2"):
                cur.execute(
                    """INSERT INTO offer (merchant_id, external_id, url, title_raw,
                                          brand_raw, current_price, in_stock)
                       VALUES (%s, %s, %s, 'Zygarde Test El Dokuma Kilim 120x180',
                               'Zygarde', 100000, TRUE)""",
                    (mid, external_id, f"https://{DOMAIN}/{external_id}"),
                )
        owner.commit()
        yield mid
        with owner.cursor() as cur:
            for statement in CLEANUP:
                cur.execute(statement, {"domain": DOMAIN})
        owner.commit()


def test_same_title_offers_of_one_merchant_become_separate_products(merchant_id: int) -> None:
    with _owner() as conn:
        counts = resolve_offers(conn, merchant_id=merchant_id)
        conn.commit()
        with conn.cursor() as cur:
            cur.execute(
                "SELECT count(DISTINCT product_id) FROM offer WHERE merchant_id = %s",
                (merchant_id,),
            )
            row = cur.fetchone()

    assert counts.auto_accepted == 0 and counts.queued == 0
    assert counts.products_created == 2
    assert row is not None and row[0] == 2
