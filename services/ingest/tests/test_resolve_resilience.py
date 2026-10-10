"""Eslestirme kosusu tek bir teklifin hatasindan ve es zamanli ikinci kosudan korunur
(AI denetimi A7)."""

from __future__ import annotations

from collections.abc import Iterator

import psycopg
import pytest

from db.connection import database_url
from resolve import pipeline
from resolve.pipeline import resolve_offers

pytestmark = pytest.mark.integration

DOMAIN = "test-resolve-dayaniklilik.example"
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
TITLES = ("Zorlu Test Bardak 1", "Zorlu Test Bardak 2", "Zorlu Test Bardak 3")


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
                   VALUES ('test-dayaniklilik', 'Test', %s, 'xml_feed') RETURNING id""",
                (DOMAIN,),
            )
            row = cur.fetchone()
            assert row is not None
            mid = int(row[0])
            for index, title in enumerate(TITLES):
                cur.execute(
                    """INSERT INTO offer (merchant_id, external_id, url, title_raw,
                                          brand_raw, current_price, in_stock)
                       VALUES (%s, %s, %s, %s, 'Zorlu', 100000, TRUE)""",
                    (mid, f"bardak-{index}", f"https://{DOMAIN}/{index}", title),
                )
        owner.commit()
        yield mid
        with owner.cursor() as cur:
            for statement in CLEANUP:
                cur.execute(statement, {"domain": DOMAIN})
        owner.commit()


def _linked(merchant_id: int) -> dict[str, int | None]:
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT title_raw, product_id FROM offer WHERE merchant_id = %s", (merchant_id,)
        )
        return {title: product_id for title, product_id in cur.fetchall()}


def test_one_failing_offer_does_not_poison_the_rest_of_the_run(
    merchant_id: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    original = pipeline.products.create_from_offer

    def flaky(conn: psycopg.Connection, **kwargs):  # type: ignore[no-untyped-def]
        if kwargs["title"] == TITLES[1]:
            # Islemi "aborted" duruma sokan gercek bir veritabani hatasi.
            conn.execute("SELECT 1 / 0")
        return original(conn, **kwargs)

    monkeypatch.setattr(pipeline.products, "create_from_offer", flaky)

    with _owner() as conn:
        counts = resolve_offers(conn, merchant_id=merchant_id)
        conn.commit()  # eskiden sessiz rollback: tum kosu kaybolurdu

    linked = _linked(merchant_id)
    assert len(counts.errors) == 1
    assert counts.products_created == 2
    assert linked[TITLES[0]] is not None
    assert linked[TITLES[1]] is None  # yalniz bozuk teklif baglanmadi, sonraki kosu alir
    assert linked[TITLES[2]] is not None


def test_an_overlapping_run_does_nothing_while_another_holds_the_lock(merchant_id: int) -> None:
    with _owner() as holder, holder.cursor() as cur:
        cur.execute("SELECT pg_advisory_xact_lock(%s)", (pipeline.RESOLVE_LOCK_KEY,))

        with _owner() as other:
            counts = resolve_offers(other, merchant_id=merchant_id)
            other.commit()

        assert counts.considered == 0
        assert counts.products_created == 0
        assert counts.errors and "kosu" in counts.errors[0]
        holder.rollback()

    assert all(product_id is None for product_id in _linked(merchant_id).values())

    with _owner() as conn:
        again = resolve_offers(conn, merchant_id=merchant_id)
        conn.commit()
    assert again.products_created == len(TITLES)
