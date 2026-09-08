"""Kabul kriteri: idempotentlik, uctan uca, gercek veritabanina.

Kurulum ve temizlik SAHIP rolle, boru hatti UYGULAMA rolu (`arilla_app`) ile
calisir. Bu ayrim kasitli:

  * `arilla_app` `price_point` satirlarini SILEMEZ (migrations/0010), yani
    temizlik baska turlu zaten yapilamaz;
  * boru hattinin gercekten uygulama yetkileriyle yettigi kanitlanir.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path

import psycopg
import pytest

from collect.pipeline import run_ingest
from db.connection import database_url

pytestmark = pytest.mark.integration

MERCHANT_SLUG = "test-fixture-merchant"

# psycopg3 tek bir execute() icinde parametreli COK IFADE calistiramaz;
# bagimlilik sirasina gore tek tek gider.
CLEANUP_STATEMENTS = (
    """DELETE FROM variant_stock_event WHERE variant_id IN (
        SELECT v.id FROM offer_variant v
          JOIN offer o ON o.id = v.offer_id
          JOIN merchant m ON m.id = o.merchant_id
         WHERE m.slug = %(slug)s)""",
    """DELETE FROM offer_variant WHERE offer_id IN (
        SELECT o.id FROM offer o JOIN merchant m ON m.id = o.merchant_id
         WHERE m.slug = %(slug)s)""",
    """DELETE FROM price_point WHERE offer_id IN (
        SELECT o.id FROM offer o JOIN merchant m ON m.id = o.merchant_id
         WHERE m.slug = %(slug)s)""",
    "DELETE FROM offer WHERE merchant_id IN (SELECT id FROM merchant WHERE slug = %(slug)s)",
    "DELETE FROM ingest_run WHERE merchant_id IN (SELECT id FROM merchant WHERE slug = %(slug)s)",
    "DELETE FROM merchant WHERE slug = %(slug)s",
)

INSERT_MERCHANT = """
INSERT INTO merchant (slug, name, domain, source_type, feed_url, feed_config)
VALUES (%s, 'Test Fixture Magaza', 'test-fixture.example', 'xml_feed', %s, %s)
RETURNING id
"""

OFFERS = "SELECT count(*) FROM offer WHERE merchant_id = %s"

PRICE_POINTS = """
SELECT count(*) FROM price_point pp
  JOIN offer o ON o.id = pp.offer_id
 WHERE o.merchant_id = %s
"""

STOCK_EVENTS = """
SELECT count(*) FROM variant_stock_event e
  JOIN offer_variant v ON v.id = e.variant_id
  JOIN offer o ON o.id = v.offer_id
 WHERE o.merchant_id = %s
"""


def _owner() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL_OWNER"))


def _app() -> psycopg.Connection:
    """Boru hattinin kullandigi baglanti: uygulama rolu."""
    return psycopg.connect(database_url("DATABASE_URL"))


@pytest.fixture
def merchant(feed_v1: Path, xml_feed_config: dict) -> Iterator[int]:
    try:
        owner = _owner()
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")

    with owner:
        with owner.cursor() as cur:
            for statement in CLEANUP_STATEMENTS:
                cur.execute(statement, {"slug": MERCHANT_SLUG})
            cur.execute(INSERT_MERCHANT, (MERCHANT_SLUG, str(feed_v1), json.dumps(xml_feed_config)))
            row = cur.fetchone()
            assert row is not None
            merchant_id = int(row[0])
        owner.commit()

        yield merchant_id

        with owner.cursor() as cur:
            for statement in CLEANUP_STATEMENTS:
                cur.execute(statement, {"slug": MERCHANT_SLUG})
        owner.commit()


def _set_feed(merchant_id: int, path: Path) -> None:
    with _owner() as owner:
        with owner.cursor() as cur:
            cur.execute("UPDATE merchant SET feed_url = %s WHERE id = %s", (str(path), merchant_id))
        owner.commit()


def _count(sql: str, merchant_id: int) -> int:
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(sql, (merchant_id,))
        row = cur.fetchone()
        return int(row[0]) if row else 0


def test_first_run_writes_one_hundred_offers(merchant: int) -> None:
    with _app() as conn:
        result = run_ingest(conn, MERCHANT_SLUG)

    assert result.status == "success"
    assert result.offers_seen == 100
    assert result.counts.offers_created == 100
    assert result.counts.offers_updated == 0
    assert result.counts.price_points_written == 100
    assert _count(OFFERS, merchant) == 100
    assert _count(PRICE_POINTS, merchant) == 100


def test_second_run_is_idempotent_but_price_history_grows(merchant: int) -> None:
    """Kabul kriterinin ta kendisi.

    Ayni feed ikinci kez islendiginde YENI OFFER OLUSMAZ ama her teklif bir
    `price_point` daha alir — fiyat degismemis olsa bile. Surekliligin kendisi
    veridir.
    """
    with _app() as conn:
        first = run_ingest(conn, MERCHANT_SLUG)
    with _app() as conn:
        second = run_ingest(conn, MERCHANT_SLUG)

    assert first.counts.offers_created == 100
    assert second.counts.offers_created == 0
    assert second.counts.offers_updated == 100

    assert _count(OFFERS, merchant) == 100
    assert _count(PRICE_POINTS, merchant) == 200
    assert second.counts.price_points_written == 100


def test_stock_events_only_on_change(merchant: int, feed_v2: Path) -> None:
    """`variant_stock_event` yalnizca durum DEGISTIGINDE yazilir."""
    with _app() as conn:
        run_ingest(conn, MERCHANT_SLUG)
    after_first = _count(STOCK_EVENTS, merchant)
    # Ilk gorulme de bir olaydir: 100 urun x 3 beden.
    assert after_first == 300

    # Ayni feed tekrar: hicbir bedende durum degismedi -> yeni olay YOK.
    with _app() as conn:
        run_ingest(conn, MERCHANT_SLUG)
    assert _count(STOCK_EVENTS, merchant) == after_first

    # Degisen feed: yalnizca stogu degisen bedenler olay uretir.
    _set_feed(merchant, feed_v2)
    with _app() as conn:
        run_ingest(conn, MERCHANT_SLUG)
    delta = _count(STOCK_EVENTS, merchant) - after_first
    assert 0 < delta < 300


def test_price_changes_are_recorded(merchant: int, feed_v2: Path) -> None:
    with _app() as conn:
        run_ingest(conn, MERCHANT_SLUG)
    _set_feed(merchant, feed_v2)
    with _app() as conn:
        run_ingest(conn, MERCHANT_SLUG)

    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT count(*) FROM (
                SELECT pp.offer_id FROM price_point pp
                  JOIN offer o ON o.id = pp.offer_id
                 WHERE o.merchant_id = %s
                 GROUP BY pp.offer_id HAVING count(DISTINCT pp.price) > 1
            ) changed
            """,
            (merchant,),
        )
        row = cur.fetchone()
    assert row is not None
    # Fixture'da her 5. urunun fiyati dustu.
    assert row[0] == 20


def test_ingest_run_is_always_recorded(merchant: int) -> None:
    """Sessiz basarisizlik kabul edilmez: her kosu bir satir birakir."""
    with _app() as conn:
        run_ingest(conn, MERCHANT_SLUG)
    with _app() as conn:
        run_ingest(conn, MERCHANT_SLUG)

    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT status, offers_seen, offers_created, offers_updated, price_points_written
              FROM ingest_run WHERE merchant_id = %s ORDER BY started_at
            """,
            (merchant,),
        )
        runs = cur.fetchall()

    assert len(runs) == 2
    assert [run[0] for run in runs] == ["success", "success"]
    assert runs[0][2] == 100
    assert runs[0][3] == 0
    assert runs[1][2] == 0
    assert runs[1][3] == 100
    assert all(run[4] == 100 for run in runs)


def test_pipeline_cannot_update_price_point(merchant: int) -> None:
    """Append-only kurali motorda: uygulama rolu fiyat gecmisini degistiremez."""
    with _app() as conn:
        run_ingest(conn, MERCHANT_SLUG)

    with _app() as conn, conn.cursor() as cur, pytest.raises(psycopg.errors.InsufficientPrivilege):
        cur.execute("UPDATE price_point SET price = 1 WHERE false")
