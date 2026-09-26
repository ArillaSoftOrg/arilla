"""Insanin reddettigi eslesme bir daha onerilmez ve baglanmaz (docs/decisions/0040).

Bulunan ariza: `/yonetim/eslestirme`'de reddedilen (offer, urun) cifti bir
sonraki `resolve` kosusunda ayni kanaldan yine en iyi aday cikiyordu.
`UPSERT_CANDIDATE` insan kararini ezmedigi icin satir `rejected` kaliyordu,
ama skor otomatik kabul kademesindeyse `LINK_OFFER` yine calisiyor ve offer
reddedilen urune BAGLANIYORDU; degilse offer sonsuza dek eslesmemis kaliyordu.
"""

from __future__ import annotations

from collections.abc import Iterator

import psycopg
import pytest

from db.connection import database_url
from resolve.pipeline import resolve_offers

pytestmark = pytest.mark.integration

DOMAIN = "test-resolve-red.example"
BRAND_SLUG = "test-resolve-red-marka"
PRODUCT_SLUG = "test-resolve-red-urun"
TITLE = "Quorvex Test Deri Omuz Cantasi Siyah"

CLEANUP = (
    """DELETE FROM match_candidate WHERE offer_id IN (
        SELECT o.id FROM offer o JOIN merchant m ON m.id = o.merchant_id
         WHERE m.domain = %(domain)s)""",
    """CREATE TEMP TABLE IF NOT EXISTS _p AS SELECT o.product_id FROM offer o
        JOIN merchant m ON m.id = o.merchant_id WHERE m.domain = %(domain)s""",
    "DELETE FROM offer WHERE merchant_id IN (SELECT id FROM merchant WHERE domain = %(domain)s)",
    """DELETE FROM product WHERE id IN (SELECT product_id FROM _p WHERE product_id IS NOT NULL)
        OR slug = %(product_slug)s""",
    "DROP TABLE _p",
    "DELETE FROM merchant WHERE domain = %(domain)s",
    "DELETE FROM brand WHERE slug = %(brand_slug)s",
)
PARAMS = {"domain": DOMAIN, "product_slug": PRODUCT_SLUG, "brand_slug": BRAND_SLUG}


def _owner() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL_OWNER"))


@pytest.fixture
def seeded() -> Iterator[tuple[int, int, int]]:
    """(merchant_id, offer_id, reddedilen product_id)."""
    try:
        owner = _owner()
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")
    with owner:
        with owner.cursor() as cur:
            for statement in CLEANUP:
                cur.execute(statement, PARAMS)
            cur.execute(
                """INSERT INTO brand (slug, name, name_norm)
                   VALUES (%s, 'Quorvex', 'quorvex') RETURNING id""",
                (BRAND_SLUG,),
            )
            brand_id = int(cur.fetchone()[0])  # type: ignore[index]
            cur.execute(
                "INSERT INTO product (slug, title, brand_id) VALUES (%s, %s, %s) RETURNING id",
                (PRODUCT_SLUG, TITLE, brand_id),
            )
            product_id = int(cur.fetchone()[0])  # type: ignore[index]
            cur.execute(
                """INSERT INTO merchant (slug, name, domain, source_type)
                   VALUES ('test-resolve-red', 'Test', %s, 'xml_feed') RETURNING id""",
                (DOMAIN,),
            )
            merchant_id = int(cur.fetchone()[0])  # type: ignore[index]
            cur.execute(
                """INSERT INTO offer (merchant_id, external_id, url, title_raw, brand_raw,
                                      current_price, in_stock)
                   VALUES (%s, 'red-1', %s, %s, 'Quorvex', 150000, TRUE) RETURNING id""",
                (merchant_id, f"https://{DOMAIN}/red-1", TITLE),
            )
            offer_id = int(cur.fetchone()[0])  # type: ignore[index]
        owner.commit()
        yield merchant_id, offer_id, product_id
        with owner.cursor() as cur:
            for statement in CLEANUP:
                cur.execute(statement, PARAMS)
        owner.commit()


def _state(conn: psycopg.Connection, offer_id: int, product_id: int) -> tuple[int | None, str]:
    with conn.cursor() as cur:
        cur.execute("SELECT product_id FROM offer WHERE id = %s", (offer_id,))
        linked = cur.fetchone()[0]  # type: ignore[index]
        cur.execute(
            "SELECT status FROM match_candidate WHERE offer_id = %s AND product_id = %s",
            (offer_id, product_id),
        )
        row = cur.fetchone()
    return (int(linked) if linked is not None else None), (row[0] if row else "")


def test_unrejected_pair_matches_the_product(seeded: tuple[int, int, int]) -> None:
    """Kontrol: red yokken ayni veri reddedilecek urunle eslesir (test anlamli)."""
    merchant_id, offer_id, product_id = seeded
    with _owner() as conn:
        counts = resolve_offers(conn, merchant_id=merchant_id)
        conn.commit()
        linked, status = _state(conn, offer_id, product_id)
    assert counts.products_created == 0
    assert status in {"auto_accepted", "pending"}
    if status == "auto_accepted":
        assert linked == product_id


def test_rejected_pair_is_never_proposed_or_linked_again(seeded: tuple[int, int, int]) -> None:
    merchant_id, offer_id, product_id = seeded
    with _owner() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO match_candidate (offer_id, product_id, score, method, status)
                   VALUES (%s, %s, 0.9, 'text', 'rejected')""",
                (offer_id, product_id),
            )
        conn.commit()

        counts = resolve_offers(conn, merchant_id=merchant_id)
        conn.commit()
        linked, status = _state(conn, offer_id, product_id)

        # Ikinci kosu: offer artik bagli, yeniden secilmez; yeni aday da uretilmez.
        again = resolve_offers(conn, merchant_id=merchant_id)
        conn.commit()

    assert status == "rejected", "insan karari ezilmemeli"
    assert linked is not None and linked != product_id, "reddedilen urune baglanmamali"
    assert counts.products_created == 1 and counts.auto_accepted == 0 and counts.queued == 0
    assert again.considered == 0
