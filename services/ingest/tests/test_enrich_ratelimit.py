"""Token butcesi ve Jina istemcisinin yeniden deneme davranisi.

Sahte saat ve sahte uyku: hicbir test gercek zamanda beklemez, aga cikmaz.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from email.utils import format_datetime

import httpx
import pytest

from enrich.client import (
    DIMENSIONS,
    MAX_ATTEMPTS,
    RETRY_AFTER_CAP,
    EmbeddingError,
    JinaEmbeddingClient,
    backoff_seconds,
    retry_after_seconds,
)
from enrich.ratelimit import DEFAULT_TOKENS_PER_MINUTE, TokenBudget, tokens_per_minute_from_env


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0
        self.slept: list[float] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.now += seconds


def _budget(tpm: int = 10_000) -> tuple[TokenBudget, FakeClock]:
    clock = FakeClock()
    return TokenBudget(tokens_per_minute=tpm, clock=clock, sleep=clock.sleep), clock


# --- TokenBudget --------------------------------------------------------------


def test_requests_under_budget_do_not_wait() -> None:
    budget, clock = _budget()
    for _ in range(5):
        budget.acquire(2000)
    assert clock.slept == []
    assert budget.used() == 10_000


def test_request_over_budget_waits_for_oldest_to_leave_window() -> None:
    budget, clock = _budget()
    budget.acquire(6000)
    clock.now += 10
    budget.acquire(4000)
    clock.now += 5
    # Pencere dolu (10.000). Yeni 3.000 icin ilk kaydin (t=1000) dusmesi lazim.
    budget.acquire(3000)
    assert clock.now == pytest.approx(1060.0)
    assert sum(clock.slept) == pytest.approx(45.0)
    assert budget.used() == 7000


def test_sliding_window_never_exceeds_budget() -> None:
    budget, clock = _budget(tpm=80_000)
    sent: list[tuple[float, int]] = []
    for _ in range(60):
        budget.acquire(32_000)
        sent.append((clock.now, 32_000))
        clock.now += 1.5  # istek suresi
    for at, _tokens in sent:
        in_window = sum(t for when, t in sent if at - 60 < when <= at)
        assert in_window <= 80_000


def test_settle_replaces_estimate_with_actual_usage() -> None:
    budget, clock = _budget()
    entry = budget.acquire(9000)
    budget.settle(entry, 2000)
    budget.acquire(8000)
    assert clock.slept == []


def test_single_request_larger_than_budget_passes_when_window_is_empty() -> None:
    budget, clock = _budget(tpm=1000)
    budget.acquire(5000)
    assert clock.slept == []
    budget.acquire(10)
    assert sum(clock.slept) == pytest.approx(60.0)


def test_pause_blocks_next_request() -> None:
    budget, clock = _budget()
    budget.pause(7)
    budget.acquire(1)
    assert sum(clock.slept) == pytest.approx(7.0)
    assert budget.waited == pytest.approx(7.0)


def test_tpm_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("JINA_TOKENS_PER_MINUTE", "50000")
    assert tokens_per_minute_from_env() == 50_000
    monkeypatch.setenv("JINA_TOKENS_PER_MINUTE", "abc")
    assert tokens_per_minute_from_env() == DEFAULT_TOKENS_PER_MINUTE
    monkeypatch.setenv("JINA_TOKENS_PER_MINUTE", "-5")
    assert tokens_per_minute_from_env() == DEFAULT_TOKENS_PER_MINUTE


# --- Retry-After ve geri cekilme ---------------------------------------------


def test_retry_after_parsing() -> None:
    assert retry_after_seconds("12") == 12.0
    assert retry_after_seconds(None) is None
    assert retry_after_seconds("yarin") is None
    now = datetime(2026, 9, 24, 12, 0, 0, tzinfo=UTC)
    date = format_datetime(now + timedelta(seconds=30), usegmt=True)
    assert retry_after_seconds(date, now=now.timestamp()) == pytest.approx(30.0)


def test_backoff_is_exponential_and_capped() -> None:
    assert [backoff_seconds(n) for n in range(4)] == [2.0, 4.0, 8.0, 16.0]
    assert backoff_seconds(20) == 60.0


# --- istemci + butce ----------------------------------------------------------


def _ok(count: int, tokens: int) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "data": [{"index": i, "embedding": [0.01] * DIMENSIONS} for i in range(count)],
            "usage": {"total_tokens": tokens},
        },
    )


@pytest.fixture(autouse=True)
def _api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("JINA_API_KEY", "test-key")


def _jina(handler, budget: TokenBudget, clock: FakeClock) -> JinaEmbeddingClient:
    return JinaEmbeddingClient(
        client=httpx.Client(transport=httpx.MockTransport(handler)),
        budget=budget,
        sleep=clock.sleep,
    )


def test_429_respects_retry_after_then_succeeds() -> None:
    budget, clock = _budget(tpm=100_000)
    responses = [httpx.Response(429, headers={"retry-after": "7"}), _ok(1, 4000)]

    client = _jina(lambda _r: responses.pop(0), budget, clock)
    batch = client.embed_images(["data:image/jpeg;base64,AA"], estimated_tokens=4000)

    assert batch.total_tokens == 4000
    assert client.rate_limited == 1
    assert client.retries == 1
    assert sum(clock.slept) == pytest.approx(7.0)


def test_429_without_retry_after_uses_backoff() -> None:
    budget, clock = _budget(tpm=100_000)
    responses = [httpx.Response(429), httpx.Response(429), _ok(1, 4000)]

    client = _jina(lambda _r: responses.pop(0), budget, clock)
    client.embed_images(["x"], estimated_tokens=10)
    assert clock.slept == [2.0, 4.0]


def test_retry_after_is_capped() -> None:
    budget, clock = _budget(tpm=100_000)
    responses = [httpx.Response(429, headers={"retry-after": "99999"}), _ok(1, 1)]
    _jina(lambda _r: responses.pop(0), budget, clock).embed_images(["x"], estimated_tokens=1)
    assert sum(clock.slept) == pytest.approx(RETRY_AFTER_CAP)


def test_retries_are_bounded() -> None:
    """Sonsuz deneme yok: MAX_ATTEMPTS istekten sonra EmbeddingError."""
    budget, clock = _budget(tpm=100_000)
    attempts = {"n": 0}

    def handler(_request: httpx.Request) -> httpx.Response:
        attempts["n"] += 1
        return httpx.Response(429)

    client = _jina(handler, budget, clock)
    with pytest.raises(EmbeddingError, match="429"):
        client.embed_images(["x"], estimated_tokens=1)
    assert attempts["n"] == MAX_ATTEMPTS
    assert len(clock.slept) == MAX_ATTEMPTS - 1


def test_transport_error_is_retried() -> None:
    budget, clock = _budget(tpm=100_000)
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            raise httpx.ReadTimeout("yavas", request=request)
        return _ok(1, 5)

    batch = _jina(handler, budget, clock).embed_texts(["x"])
    assert batch.total_tokens == 5
    assert calls["n"] == 2


def test_server_error_is_retried_client_error_is_not() -> None:
    budget, clock = _budget(tpm=100_000)
    responses = [httpx.Response(503), _ok(1, 5)]
    _jina(lambda _r: responses.pop(0), budget, clock).embed_texts(["x"])
    assert clock.slept == [2.0]


def test_budget_is_corrected_with_actual_usage() -> None:
    """Tahmin 40.000 ama saglayici 4.000 saydi: pencerede 4.000 kalir."""
    budget, clock = _budget(tpm=50_000)
    client = _jina(lambda _r: _ok(1, 4000), budget, clock)
    client.embed_images(["x"], estimated_tokens=40_000)
    assert budget.used() == 4000
    # Duzeltme olmasaydi bu ikinci istek beklerdi.
    client.embed_images(["x"], estimated_tokens=40_000)
    assert clock.slept == []


def test_client_paces_itself_under_the_budget() -> None:
    """Butce 8.000/dk, her istek 4.000: ucuncu istek pencere acilana kadar bekler."""
    budget, clock = _budget(tpm=8000)
    seen: list[float] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(clock.now)
        count = len(json.loads(request.content)["input"])
        return _ok(count, 4000)

    client = _jina(handler, budget, clock)
    for _ in range(3):
        client.embed_images(["x"], estimated_tokens=4000)
    assert seen[2] - seen[0] >= 60.0
