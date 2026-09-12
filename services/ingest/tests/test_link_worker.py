"""D4: Redis kuyrugundan tetiklenen `process_one`'in Postgres tarafi.

Redis'in kendisi burada devrede degil - kuyruktan okuma `run_worker`'da,
tek satirlik test hedefi degil (BRPOP gercek bir Redis ister). Burada
dogrulanan: `link_resolution_request` satiri dogru gecislerden geciyor mu.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import httpx
import psycopg
import pytest

from collect.link.robots import RobotsCache
from collect.link.worker import process_one
from db.connection import database_url

pytestmark = pytest.mark.integration

DOMAIN = "test-link-worker-magaza.example"
FIXTURES = Path(__file__).parent / "fixtures" / "link"

CLEANUP_STATEMENTS = (
    "DELETE FROM link_resolution_request WHERE url_raw LIKE %(pattern)s",
    """DELETE FROM price_point WHERE offer_id IN (
        SELECT o.id FROM offer o JOIN merchant m ON m.id = o.merchant_id
         WHERE m.domain = %(domain)s)""",
    "DELETE FROM offer WHERE merchant_id IN (SELECT id FROM merchant WHERE domain = %(domain)s)",
    "DELETE FROM merchant WHERE domain = %(domain)s",
)


def _owner() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL_OWNER"))


def _app() -> psycopg.Connection:
    return psycopg.connect(database_url("DATABASE_URL"))


def _page_client(page: str = "product_jsonld.html") -> httpx.Client:
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

    params = {"domain": DOMAIN, "pattern": f"https://{DOMAIN}%"}
    with owner:
        with owner.cursor() as cur:
            for statement in CLEANUP_STATEMENTS:
                cur.execute(statement, params)
        owner.commit()

        yield

        with owner.cursor() as cur:
            for statement in CLEANUP_STATEMENTS:
                cur.execute(statement, params)
        owner.commit()


def _insert_request(conn: psycopg.Connection, url_raw: str) -> str:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO link_resolution_request (url_raw, session_id)
            VALUES (%s, 'test-session')
            RETURNING id
            """,
            (url_raw,),
        )
        row = cur.fetchone()
    conn.commit()
    assert row is not None
    return str(row[0])


def _fetch_request(conn: psycopg.Connection, request_id: str) -> tuple[str, int | None, str | None]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT status, offer_id, error_text FROM link_resolution_request WHERE id = %s",
            (request_id,),
        )
        row = cur.fetchone()
    assert row is not None
    return row[0], row[1], row[2]


def test_queued_request_resolves_to_an_offer(clean_domain: None) -> None:
    client = _page_client()
    robots = RobotsCache(client=client)
    url = f"https://{DOMAIN}/urun/deri-canta"

    with _app() as conn:
        request_id = _insert_request(conn, url)
        process_one(conn, request_id, client=client, robots=robots)

    with _owner() as conn:
        status, offer_id, error_text = _fetch_request(conn, request_id)
    assert status == "resolved"
    assert offer_id is not None
    assert error_text is None


def test_robots_disallow_marks_request_failed(clean_domain: None) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/robots.txt":
            return httpx.Response(200, text="User-agent: *\nDisallow: /urun/\n")
        raise AssertionError("robots yasaklarken sayfa getirilmemeliydi")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    url = f"https://{DOMAIN}/urun/deri-canta"

    with _app() as conn:
        request_id = _insert_request(conn, url)
        process_one(conn, request_id, client=client, robots=RobotsCache(client=client))

    with _owner() as conn:
        status, offer_id, error_text = _fetch_request(conn, request_id)
    assert status == "failed"
    assert offer_id is None
    assert error_text is not None and "robots" in error_text


def test_already_processed_request_is_left_untouched(clean_domain: None) -> None:
    """Redis'in en-az-bir-kez teslimati: ayni mesaj iki kez gelebilir."""
    client = _page_client()
    robots = RobotsCache(client=client)
    url = f"https://{DOMAIN}/urun/deri-canta"

    with _app() as conn:
        request_id = _insert_request(conn, url)
        process_one(conn, request_id, client=client, robots=robots)
        process_one(conn, request_id, client=client, robots=robots)  # ikinci teslimat

    with _owner() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT count(*) FROM offer o JOIN merchant m ON m.id = o.merchant_id
             WHERE m.domain = %s
            """,
            (DOMAIN,),
        )
        row = cur.fetchone()
    assert row is not None
    assert row[0] == 1  # ikinci cagri yeni bir offer YARATMADI
