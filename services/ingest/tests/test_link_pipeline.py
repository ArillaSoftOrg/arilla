"""Kabul kriteri: bilinmeyen bir magaza linki kataloga kalici olarak girer.

Kurulum ve temizlik SAHIP rolle, cozumleme UYGULAMA rolu (`arilla_app`) ile —
B1'deki ayrimin aynisi.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import httpx
import psycopg
import pytest

from collect.link.resolver import ResolutionFailed, resolve_url
from collect.link.robots import RobotsCache
from db.connection import database_url

pytestmark = pytest.mark.integration

DOMAIN = "test-link-magaza.example"
FIXTURES = Path(__file__).parent / "fixtures" / "link"

CLEANUP_STATEMENTS = (
    """DELETE FROM price_point WHERE offer_id IN (
        SELECT o.id FROM offer o JOIN merchant m ON m.id = o.merchant_id
         WHERE m.domain = %(domain)s)""",
    "DELETE FROM offer WHERE merchant_id IN (SELECT id FROM merchant WHERE domain = %(domain)s)",
    """DELETE FROM ingest_run WHERE merchant_id IN (
        SELECT id FROM merchant WHERE domain = %(domain)s)""",
    "DELETE FROM merchant WHERE domain = %(domain)s",
)


def _owner() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL_OWNER"))


def _app() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL"))


def _page_client(page: str = "product_jsonld.html") -> httpx.Client:
    """robots.txt'e izin veren, urun sayfasini donduren sahte site."""
    body = (FIXTURES / page).read_text(encoding="utf-8")

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/robots.txt":
            return httpx.Response(200, text="User-agent: *\nAllow: /\n")
        return httpx.Response(200, text=body, headers={"content-type": "text/html; charset=utf-8"})

    return httpx.Client(transport=httpx.MockTransport(handler))


@pytest.fixture
def clean_domain() -> Iterator[None]:
    try:
        owner = _owner()
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")

    with owner:
        with owner.cursor() as cur:
            for statement in CLEANUP_STATEMENTS:
                cur.execute(statement, {"domain": DOMAIN})
        owner.commit()

        yield

        with owner.cursor() as cur:
            for statement in CLEANUP_STATEMENTS:
                cur.execute(statement, {"domain": DOMAIN})
        owner.commit()


def _count_price_points() -> int:
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT count(*) FROM price_point pp
              JOIN offer o ON o.id = pp.offer_id
              JOIN merchant m ON m.id = o.merchant_id
             WHERE m.domain = %s
            """,
            (DOMAIN,),
        )
        row = cur.fetchone()
    return int(row[0]) if row else 0


def test_unknown_domain_enters_the_catalogue(clean_domain: None) -> None:
    """Kabul kriteri: bir merchant urun URL'si verildiginde yeni bir offer olusuyor."""
    client = _page_client()
    with _app() as conn:
        resolved = resolve_url(
            conn,
            f"https://{DOMAIN}/urun/deri-canta?utm_source=instagram",
            client=client,
            robots=RobotsCache(client=client),
        )
        conn.commit()

    assert resolved.merchant_created is True
    assert resolved.offer_created is True
    assert resolved.title == "Deri Omuz Cantasi Siyah"
    assert resolved.price == 189990  # 1899.90 TL -> kurus
    assert resolved.source_layer == "json_ld"
    assert resolved.low_confidence is False

    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT m.source_type, m.affiliate_status, o.discovery_source, o.external_id,
                   o.attributes_raw ->> 'gtin'
              FROM offer o JOIN merchant m ON m.id = o.merchant_id
             WHERE m.domain = %s
            """,
            (DOMAIN,),
        )
        row = cur.fetchone()

    assert row is not None
    source_type, affiliate_status, discovery_source, external_id, gtin = row
    assert source_type == "user_discovered"
    assert affiliate_status == "none"
    assert discovery_source == "user_link"
    assert external_id == "/urun/deri-canta"
    # `offer` tablosunda gtin kolonu yok; barkod attributes_raw icinde yasar.
    assert gtin == "8680000000123"
    assert _count_price_points() == 1


def test_same_link_with_different_tracking_does_not_duplicate(clean_domain: None) -> None:
    """Idempotentlik: ayni urun, farkli izleme parametresi -> yeni offer YOK."""
    client = _page_client()
    robots = RobotsCache(client=client)

    with _app() as conn:
        first = resolve_url(
            conn, f"https://{DOMAIN}/urun/deri-canta?utm_source=x", client=client, robots=robots
        )
        conn.commit()
    with _app() as conn:
        second = resolve_url(
            conn,
            f"https://www.{DOMAIN}/urun/deri-canta/?fbclid=y#yorumlar",
            client=client,
            robots=robots,
        )
        conn.commit()

    assert first.offer_created is True
    assert second.offer_created is False
    assert first.offer_id == second.offer_id
    assert second.merchant_created is False
    # Fiyat gecmisi yine de buyudu: her cozumleme bir gozlemdir.
    assert _count_price_points() == 2


def test_robots_disallow_stops_resolution(clean_domain: None) -> None:
    """Site yasakliyorsa cozumleme reddedilir ve kataloga HICBIR SEY yazilmaz."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/robots.txt":
            return httpx.Response(200, text="User-agent: *\nDisallow: /urun/\n")
        raise AssertionError("robots yasaklarken sayfa getirilmemeliydi")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    with _app() as conn:
        with pytest.raises(ResolutionFailed, match="robots"):
            resolve_url(
                conn,
                f"https://{DOMAIN}/urun/deri-canta",
                client=client,
                robots=RobotsCache(client=client),
            )
        conn.rollback()

    with _owner() as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM merchant WHERE domain = %s", (DOMAIN,))
        row = cur.fetchone()
    assert row is not None
    assert row[0] == 0


def test_last_resort_extraction_is_flagged(clean_domain: None) -> None:
    client = _page_client("product_bare.html")
    with _app() as conn:
        resolved = resolve_url(
            conn,
            f"https://{DOMAIN}/urun/triko-kazak",
            client=client,
            robots=RobotsCache(client=client),
        )
        conn.commit()

    assert resolved.source_layer == "heuristic"
    assert resolved.low_confidence is True
    assert resolved.price == 124950  # "1.249,50 TL"

    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT o.attributes_raw FROM offer o JOIN merchant m ON m.id = o.merchant_id
             WHERE m.domain = %s
            """,
            (DOMAIN,),
        )
        row = cur.fetchone()
    assert row is not None
    assert row[0]["low_confidence"] == "true"
