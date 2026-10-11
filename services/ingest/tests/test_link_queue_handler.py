"""Karar 0107: Vercel Queues mesaj isleyicisi (veritabani ve SDK gerektirmez).

Dogrulanan: mesaj dogrulama, sahiplenme/yeniden teslimat, kalici sonuc ile gecici
hata ayrimi, son teslimatta zehirli mesaj birakmama, geri cekilme suresi ve
Jina butcesinin ornekler arasi bolunmesi. Cozumleme mantiginin kendisi
(`resolve_claimed`: SSRF, robots, esik) mevcut link testlerindedir.
"""

from __future__ import annotations

from contextlib import contextmanager
from types import SimpleNamespace
from typing import Any

import pytest

from collect.link import queue_handler as qh

REQUEST_ID = "0b6d5e3e-7a5b-4c58-9d5e-3f2a1c9e8d11"


class FakeConn:
    def __init__(self) -> None:
        self.rollbacks = 0

    def rollback(self) -> None:
        self.rollbacks += 1


class Harness:
    """`queue_handler`in dis bagimliliklarini kaydeden sahte ortam."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.conn = FakeConn()
        self.claims: list[tuple[str, bool]] = []
        self.claim_result: tuple[str, str, int | None] | None = ("https://x.example/u", "s", None)
        self.resolve_error: Exception | None = None
        self.resolve_calls: list[dict[str, Any]] = []
        self.marks: list[dict[str, Any]] = []
        self.mark_error: Exception | None = None
        self.connect_error: Exception | None = None
        self.connects = 0
        self.shared = SimpleNamespace(
            page_client="page", image_client="image", robots="robots", embedder="embedder"
        )

        def claim(conn: Any, request_id: str, *, reclaim_processing: bool = False) -> Any:
            self.claims.append((request_id, reclaim_processing))
            return self.claim_result

        def resolve(
            conn: Any, request_id: str, url_raw: str, session_id: str, user_id: Any, **kw: Any
        ) -> None:
            self.resolve_calls.append({"request_id": request_id, "url": url_raw, **kw})
            if self.resolve_error is not None:
                raise self.resolve_error

        def mark(conn: Any, request_id: str, **kw: Any) -> None:
            if self.mark_error is not None:
                raise self.mark_error
            self.marks.append({"request_id": request_id, **kw})

        monkeypatch.setattr(qh, "claim_request", claim)
        monkeypatch.setattr(qh, "resolve_claimed", resolve)
        monkeypatch.setattr(qh, "_mark", mark)

    @contextmanager
    def connect(self):  # type: ignore[no-untyped-def]
        self.connects += 1
        if self.connect_error is not None:
            raise self.connect_error
        yield self.conn

    def run(self, payload: object, delivery_count: int = 1) -> qh.Outcome:
        return qh.handle_message(
            payload,
            delivery_count,
            connect=self.connect,
            clients=lambda: self.shared,  # type: ignore[arg-type,return-value]
        )


@pytest.fixture
def h(monkeypatch: pytest.MonkeyPatch) -> Harness:
    return Harness(monkeypatch)


# --- mesaj dogrulama -----------------------------------------------------------


@pytest.mark.parametrize(
    "payload",
    [
        None,
        "x",
        3,
        [],
        {},
        {"request_id": 5},
        {"request_id": "not-a-uuid"},
        {"request_id": REQUEST_ID + "x"},
    ],
)
def test_invalid_payload_is_acknowledged_without_touching_the_database(
    h: Harness, payload: object
) -> None:
    assert h.run(payload) is qh.Outcome.INVALID
    assert h.connects == 0


def test_request_id_is_normalised_to_lower_case() -> None:
    assert qh.parse_request_id({"request_id": REQUEST_ID.upper()}) == REQUEST_ID


# --- sahiplenme / idempotans -----------------------------------------------------


def test_first_delivery_only_claims_queued_rows(h: Harness) -> None:
    h.run({"request_id": REQUEST_ID}, delivery_count=1)
    assert h.claims == [(REQUEST_ID, False)]


def test_redelivery_may_reclaim_a_stuck_processing_row(h: Harness) -> None:
    h.run({"request_id": REQUEST_ID}, delivery_count=2)
    assert h.claims == [(REQUEST_ID, True)]


def test_finished_or_unknown_row_is_skipped_without_resolving(h: Harness) -> None:
    h.claim_result = None
    assert h.run({"request_id": REQUEST_ID}) is qh.Outcome.SKIPPED
    assert h.resolve_calls == []
    assert h.marks == []


def test_successful_resolution_uses_the_shared_clients(h: Harness) -> None:
    assert h.run({"request_id": REQUEST_ID}) is qh.Outcome.RESOLVED_OR_FAILED
    (call,) = h.resolve_calls
    assert call["request_id"] == REQUEST_ID
    assert call["url"] == "https://x.example/u"
    assert (call["client"], call["robots"], call["embedder"], call["image_http"]) == (
        "page",
        "robots",
        "embedder",
        "image",
    )


# --- hata ve yeniden deneme ------------------------------------------------------


def test_transient_error_before_the_last_attempt_requests_a_retry(h: Harness) -> None:
    h.resolve_error = RuntimeError("beklenmeyen")
    with pytest.raises(qh.TransientFailure) as raised:
        h.run({"request_id": REQUEST_ID}, delivery_count=1)
    assert raised.value.delay == qh.RETRY_BASE_SECONDS
    assert h.conn.rollbacks == 1
    # Satir 'processing' kalir (yeniden teslimat sahiplenebilir); failed yazilmaz.
    assert h.marks == []


def test_last_attempt_marks_failed_and_acknowledges_instead_of_retrying(h: Harness) -> None:
    h.resolve_error = RuntimeError("beklenmeyen")
    outcome = h.run({"request_id": REQUEST_ID}, delivery_count=qh.MAX_ATTEMPTS)
    assert outcome is qh.Outcome.GAVE_UP
    assert h.marks == [
        {
            "request_id": REQUEST_ID,
            "status": "failed",
            "error_code": "unexpected",
            "finished": True,
        }
    ]


def test_last_attempt_that_cannot_even_mark_the_row_still_acknowledges(h: Harness) -> None:
    h.resolve_error = RuntimeError("beklenmeyen")
    h.mark_error = RuntimeError("baglanti koptu")
    assert h.run({"request_id": REQUEST_ID}, delivery_count=qh.MAX_ATTEMPTS) is qh.Outcome.GAVE_UP


def test_connection_failure_retries_then_gives_up(h: Harness) -> None:
    h.connect_error = RuntimeError("baglanti kurulamadi")
    with pytest.raises(qh.TransientFailure):
        h.run({"request_id": REQUEST_ID}, delivery_count=1)
    assert h.run({"request_id": REQUEST_ID}, delivery_count=qh.MAX_ATTEMPTS) is qh.Outcome.GAVE_UP


def test_retry_delays_back_off_and_stay_inside_the_wait_window() -> None:
    delays = [qh.retry_delay(n) for n in range(1, 6)]
    assert delays == [15, 30, 60, 60, 60]
    # Tum teslimatlarin bekleme toplami 2 dk'lik kullanici penceresini (IN_FLIGHT_TTL) asmaz.
    assert sum(qh.retry_delay(n) for n in range(1, qh.MAX_ATTEMPTS)) <= 120


# --- maliyet kontrolu ------------------------------------------------------------


def test_jina_budget_is_split_across_concurrent_instances(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(qh, "tokens_per_minute_from_env", lambda: 80_000)
    assert qh.instance_tokens_per_minute() == 80_000 // qh.MAX_CONCURRENCY
    monkeypatch.setattr(qh, "tokens_per_minute_from_env", lambda: 1)
    assert qh.instance_tokens_per_minute() == 1


def test_embedder_is_absent_without_an_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(qh, "env", lambda name, default=None: None)
    assert qh.build_embedder() is None


def test_embedder_uses_the_per_instance_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        qh, "env", lambda name, default=None: "key" if name == "JINA_API_KEY" else None
    )
    monkeypatch.setattr(qh, "tokens_per_minute_from_env", lambda: 80_000)
    embedder = qh.build_embedder()
    assert embedder is not None
    assert embedder.budget is not None
    assert embedder.budget.tokens_per_minute == 80_000 // qh.MAX_CONCURRENCY
    assert embedder.max_attempts == qh.EMBED_ATTEMPTS


# --- SDK koprusu -----------------------------------------------------------------


def test_subscriber_translates_transient_failures_into_retry_after(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("vercel.queue")
    from vercel.queue import RetryAfter

    from collect.link import subscriber

    def boom(payload: object, delivery_count: int) -> qh.Outcome:
        raise qh.TransientFailure(30, RuntimeError("x"))

    monkeypatch.setattr(subscriber, "handle_message", boom)
    message = SimpleNamespace(
        payload={"request_id": REQUEST_ID}, metadata=SimpleNamespace(delivery_count=1)
    )
    with pytest.raises(RetryAfter):
        subscriber.resolve_link(message)  # type: ignore[arg-type]


def test_subscriber_acknowledges_on_normal_return(monkeypatch: pytest.MonkeyPatch) -> None:
    pytest.importorskip("vercel.queue")
    from collect.link import subscriber

    seen: list[tuple[object, int]] = []
    monkeypatch.setattr(
        subscriber,
        "handle_message",
        lambda payload, count: seen.append((payload, count)) or qh.Outcome.SKIPPED,
    )
    message = SimpleNamespace(
        payload={"request_id": REQUEST_ID}, metadata=SimpleNamespace(delivery_count=2)
    )
    assert subscriber.resolve_link(message) is None  # type: ignore[arg-type]
    assert seen == [({"request_id": REQUEST_ID}, 2)]


def test_subscription_is_registered_with_the_agreed_topic_and_limits() -> None:
    pytest.importorskip("vercel.queue")
    from vercel.queue import get_subscriptions

    from collect.link import subscriber  # noqa: F401  (kayit yan etkisi)

    topics = {str(getattr(s, "topic", s)) for s in get_subscriptions()}
    assert any(qh.LINK_TOPIC in topic for topic in topics)
