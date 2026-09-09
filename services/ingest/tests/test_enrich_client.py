"""Jina istemcisi — istek govdesi, yanit dogrulama, geri cekilme.

Anahtar olmadigi icin gercek API hic cagrilmadi; bu testler istegin
BICIMINI ve hata yollarini sabitler. Ilk gercek kosuda yanit alan adlari
teyit edilecek (bkz. docs/decisions/0015, acik maddeler).
"""

from __future__ import annotations

import httpx
import pytest

from enrich.client import (
    DIMENSIONS,
    EmbeddingError,
    FakeEmbeddingClient,
    JinaEmbeddingClient,
)


def _ok(count: int, dimensions: int = DIMENSIONS, tokens: int = 42) -> dict:
    return {
        "data": [{"index": index, "embedding": [0.01] * dimensions} for index in range(count)],
        "usage": {"total_tokens": tokens},
    }


def _client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


@pytest.fixture(autouse=True)
def _api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("JINA_API_KEY", "test-key")


def test_request_body_shape() -> None:
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        import json

        seen.update(json.loads(request.content))
        seen["auth"] = request.headers.get("Authorization")
        return httpx.Response(200, json=_ok(1))

    JinaEmbeddingClient(client=_client(handler)).embed_images(["data:image/png;base64,AAA"])

    assert seen["model"] == "jina-clip-v2"
    assert seen["dimensions"] == 768
    # Kosinus mesafesi normalize vektorlerde dogru calisir.
    assert seen["normalized"] is True
    assert seen["input"] == [{"image": "data:image/png;base64,AAA"}]
    assert seen["auth"] == "Bearer test-key"


def test_text_input_shape() -> None:
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        import json

        seen.update(json.loads(request.content))
        return httpx.Response(200, json=_ok(2))

    JinaEmbeddingClient(client=_client(handler)).embed_texts(["siyah bot", "bej canta"])
    assert seen["input"] == [{"text": "siyah bot"}, {"text": "bej canta"}]


def test_missing_api_key_fails_before_any_request(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("JINA_API_KEY", raising=False)

    def handler(_request: httpx.Request) -> httpx.Response:
        raise AssertionError("anahtar yokken istek atilmamaliydi")

    with pytest.raises(EmbeddingError, match="JINA_API_KEY"):
        JinaEmbeddingClient(client=_client(handler)).embed_texts(["x"])


def test_wrong_dimension_is_rejected() -> None:
    """Yanlis boyutlu vektor sessizce yazilmaz — sema vector(768) taahhut ediyor."""

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_ok(1, dimensions=1024))

    with pytest.raises(EmbeddingError, match="vektor boyutu"):
        JinaEmbeddingClient(client=_client(handler)).embed_texts(["x"])


def test_result_count_mismatch_is_rejected() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_ok(1))

    with pytest.raises(EmbeddingError, match="beklenen bicimde degil"):
        JinaEmbeddingClient(client=_client(handler)).embed_texts(["a", "b"])


def test_results_are_ordered_by_index() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "data": [
                    {"index": 1, "embedding": [0.2] * DIMENSIONS},
                    {"index": 0, "embedding": [0.1] * DIMENSIONS},
                ],
                "usage": {"total_tokens": 3},
            },
        )

    batch = JinaEmbeddingClient(client=_client(handler)).embed_texts(["a", "b"])
    assert batch.vectors[0][0] == pytest.approx(0.1)
    assert batch.vectors[1][0] == pytest.approx(0.2)


def test_client_error_is_not_retried() -> None:
    attempts = {"n": 0}

    def handler(_request: httpx.Request) -> httpx.Response:
        attempts["n"] += 1
        return httpx.Response(400, text="bad input")

    with pytest.raises(EmbeddingError, match="400"):
        JinaEmbeddingClient(client=_client(handler)).embed_texts(["x"])
    assert attempts["n"] == 1


def test_empty_input_makes_no_request() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        raise AssertionError("bos girdide istek atilmamaliydi")

    batch = JinaEmbeddingClient(client=_client(handler)).embed_texts([])
    assert batch.vectors == []
    assert batch.total_tokens == 0


# --- sahte istemci ----------------------------------------------------------


def test_fake_client_is_deterministic_and_normalised() -> None:
    fake = FakeEmbeddingClient()
    first = fake.embed_texts(["siyah bot"]).vectors[0]
    second = fake.embed_texts(["siyah bot"]).vectors[0]
    assert first == second
    assert len(first) == DIMENSIONS
    # Gercek istemci normalized=True donuyor; sahte de donmeli.
    assert sum(value * value for value in first) == pytest.approx(1.0, rel=1e-6)


def test_fake_client_separates_distinct_inputs() -> None:
    fake = FakeEmbeddingClient()
    vectors = fake.embed_texts(["siyah bot", "bej canta"]).vectors
    assert vectors[0] != vectors[1]


def test_fake_client_counts_calls() -> None:
    fake = FakeEmbeddingClient()
    fake.embed_texts(["a"])
    fake.embed_texts(["b"])
    fake.embed_texts([])
    assert fake.calls == 2
