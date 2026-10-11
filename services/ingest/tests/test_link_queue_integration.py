"""Karar 0107: Vercel Queues isleyicisinin gercek Postgres uzerindeki davranisi.

Kuyruk ve SDK simule edilir (`handle_message`i dogrudan cagiririz); veritabani
gercektir: atomik sahiplenme, yeniden teslimatta takili satir, bitmis satirin
atlanmasi ve sitenin durumunun (robots) yeniden denenmemesi dogrulanir.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

import httpx
import psycopg
import pytest

from collect.link import queue_handler as qh
from collect.link import worker
from collect.link.robots import RobotsCache
from db.connection import database_url

pytestmark = pytest.mark.integration

DOMAIN = "test-link-queue-magaza.example"
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


@contextmanager
def _app() -> Iterator[psycopg.Connection]:
    with psycopg.connect(database_url("DATABASE_URL")) as conn:
        yield conn


def _clients(client: httpx.Client) -> SimpleNamespace:
    return SimpleNamespace(
        page_client=client,
        image_client=client,
        robots=RobotsCache(client=client),
        embedder=None,
    )


def _page_client() -> httpx.Client:
    body = (FIXTURES / "product_jsonld.html").read_text(encoding="utf-8")

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/robots.txt":
            return httpx.Response(200, text="User-agent: *\nAllow: /\n")
        return httpx.Response(200, text=body, headers={"content-type": "text/html; charset=utf-8"})

    return httpx.Client(transport=httpx.MockTransport(handler))


def _handle(payload: object, delivery_count: int, client: httpx.Client) -> qh.Outcome:
    shared = _clients(client)
    return qh.handle_message(
        payload,
        delivery_count,
        connect=_app,
        clients=lambda: shared,  # type: ignore[arg-type,return-value]
    )


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


def _insert_request(url_raw: str) -> str:
    with _app() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO link_resolution_request (url_raw, session_id)"
            " VALUES (%s, 'test-session') RETURNING id",
            (url_raw,),
        )
        row = cur.fetchone()
    assert row is not None
    return str(row[0])


def _row(request_id: str) -> tuple[str, int | None, str | None, str | None]:
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT status, offer_id, error_code, error_text FROM link_resolution_request"
            " WHERE id = %s",
            (request_id,),
        )
        row = cur.fetchone()
    assert row is not None
    return row[0], row[1], row[2], row[3]


def _offer_count() -> int:
    with _owner() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM offer o JOIN merchant m ON m.id = o.merchant_id"
            " WHERE m.domain = %s",
            (DOMAIN,),
        )
        row = cur.fetchone()
    assert row is not None
    return int(row[0])


URL = f"https://{DOMAIN}/urun/deri-canta"


def test_claim_is_atomic_and_never_touches_finished_rows(clean_domain: None) -> None:
    request_id = _insert_request(URL)
    with _app() as conn:
        assert worker.claim_request(conn, request_id) == (URL, "test-session", None)
        # Ikinci (es zamanli) teslimat kaybeder.
        assert worker.claim_request(conn, request_id) is None
        # Yalnizca yeniden teslimatta takili 'processing' satir alinabilir.
        assert worker.claim_request(conn, request_id, reclaim_processing=True) is not None
        worker._mark(conn, request_id, status="resolved", finished=True)
        assert worker.claim_request(conn, request_id, reclaim_processing=True) is None


def test_message_resolves_the_row(clean_domain: None) -> None:
    request_id = _insert_request(URL)
    outcome = _handle({"request_id": request_id}, 1, _page_client())
    assert outcome is qh.Outcome.RESOLVED_OR_FAILED
    status, offer_id, error_code, _ = _row(request_id)
    assert (status, error_code) == ("resolved", None)
    assert offer_id is not None


def test_duplicate_delivery_is_a_noop(clean_domain: None) -> None:
    request_id = _insert_request(URL)
    client = _page_client()
    _handle({"request_id": request_id}, 1, client)
    assert _handle({"request_id": request_id}, 2, client) is qh.Outcome.SKIPPED
    assert _offer_count() == 1


def test_crashed_attempt_is_recovered_by_the_redelivery(
    clean_domain: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    request_id = _insert_request(URL)
    client = _page_client()
    real = qh.resolve_claimed
    calls = {"n": 0}

    def flaky(*args: object, **kwargs: object) -> None:
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("fonksiyon dustu")
        real(*args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(qh, "resolve_claimed", flaky)

    with pytest.raises(qh.TransientFailure):
        _handle({"request_id": request_id}, 1, client)
    assert _row(request_id)[0] == "processing"  # takili kaldi, 'failed' degil

    assert _handle({"request_id": request_id}, 2, client) is qh.Outcome.RESOLVED_OR_FAILED
    assert _row(request_id)[0] == "resolved"
    assert _offer_count() == 1  # yeniden teslimat ikinci offer yaratmadi


def test_exhausted_retries_leave_a_failed_row_not_a_poison_message(
    clean_domain: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    request_id = _insert_request(URL)

    def always(*args: object, **kwargs: object) -> None:
        raise RuntimeError("kalici altyapi hatasi")

    monkeypatch.setattr(qh, "resolve_claimed", always)
    client = _page_client()

    for attempt in range(1, qh.MAX_ATTEMPTS):
        with pytest.raises(qh.TransientFailure):
            _handle({"request_id": request_id}, attempt, client)
    assert _handle({"request_id": request_id}, qh.MAX_ATTEMPTS, client) is qh.Outcome.GAVE_UP
    status, _, error_code, _ = _row(request_id)
    assert (status, error_code) == ("failed", "unexpected")


def test_site_refusal_is_a_final_result_and_is_not_retried(clean_domain: None) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/robots.txt":
            return httpx.Response(200, text="User-agent: *\nDisallow: /urun/\n")
        raise AssertionError("robots yasaklarken sayfa getirilmemeliydi")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    request_id = _insert_request(URL)

    # TransientFailure FIRLATMAZ: mesaj onaylanir, siteye tekrar gidilmez.
    assert _handle({"request_id": request_id}, 1, client) is qh.Outcome.RESOLVED_OR_FAILED
    status, offer_id, error_code, error_text = _row(request_id)
    assert status == "failed"
    assert offer_id is None
    assert error_code == "robots_disallowed"
    assert error_text is not None
