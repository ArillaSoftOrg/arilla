"""Saglayici sozlesmesi (karar 0180): uzak API, sahte ve yerel saglayici ayni kapidan gecer."""

from __future__ import annotations

import math

import httpx
import numpy as np
import pytest

from enrich.client import EmbeddingBatch, EmbeddingError, FakeEmbeddingClient, JinaEmbeddingClient
from enrich.providers import (
    LOCAL_MAX_BATCH,
    EmbeddingInvalid,
    LocalOnnxTextProvider,
    build_text_provider,
    validate_batch,
    validate_for,
)
from enrich.registry import RegistryError, registry

E5 = "e5-small-int8-0bcc8ca76950"


@pytest.fixture(autouse=True)
def _api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("JINA_API_KEY", "test-key")


def _unit(dim: int, seed: int = 1) -> list[float]:
    raw = [((seed * (i + 3)) % 17) - 8.0 for i in range(dim)]
    norm = math.sqrt(sum(v * v for v in raw))
    return [v / norm for v in raw]


class _StubEmbedder:
    """`classify.suggest.model.Embedder` sozlesmesi: ONNX'siz, deterministik, normalize ETMEZ."""

    def __init__(
        self, model_version: str = E5, dim: int = 384, prefix: str = "", pooling: str = "mean"
    ) -> None:
        self.model_version = model_version
        self.pooling = pooling
        self.dim = dim
        self.prefix = prefix
        self.seen: list[str] = []
        self.fail = False

    def with_prefix(self, prefix: str) -> _StubEmbedder:
        clone = _StubEmbedder(self.model_version, self.dim, prefix, self.pooling)
        clone.seen = self.seen
        clone.fail = self.fail
        return clone

    def encode(self, texts):
        if self.fail:
            raise RuntimeError("onnx patladi")
        self.seen.extend(self.prefix + t for t in texts)
        return np.array([[float(len(t) + i + 1) for i in range(self.dim)] for t in texts])


# --- Ortak kapi ----------------------------------------------------------------------------


def test_valid_batch_passes_unchanged() -> None:
    batch = EmbeddingBatch([_unit(768)], "m", 5)
    out = validate_batch(batch, expected=1, dimensions=768, normalization="provider_l2")
    assert out.vectors == batch.vectors and out.total_tokens == 5


@pytest.mark.parametrize(
    ("vectors", "expected", "message"),
    [
        ([_unit(768)], 2, "2 girdi icin 1"),
        ([_unit(384)], 1, "boyut 768"),
        ([[float("nan")] + _unit(768)[1:]], 1, "sonlu olmayan"),
        ([[0.0] * 768], 1, "sifir norm"),
        ([[0.5] * 768], 1, "normalize degil"),
    ],
)
def test_invalid_batches_rejected(vectors, expected, message) -> None:
    with pytest.raises(EmbeddingInvalid, match=message):
        validate_batch(
            EmbeddingBatch(vectors, "m", 1),
            expected=expected,
            dimensions=768,
            normalization="provider_l2",
        )


def test_invalid_is_an_embedding_error() -> None:
    # Cagiranlar (enrich.products) EmbeddingError'u partiyi yazmadan atlar.
    assert issubclass(EmbeddingInvalid, EmbeddingError)


def test_l2_normalization_applied_for_local_models() -> None:
    out = validate_batch(
        EmbeddingBatch([[3.0, 4.0]], "m", 1), expected=1, dimensions=2, normalization="l2"
    )
    assert out.vectors == [[0.6, 0.8]]


# --- Uzak API (Jina) -----------------------------------------------------------------------


def test_jina_provider_built_from_registry() -> None:
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        import json

        seen.update(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "data": [{"index": 0, "embedding": _unit(768)}],
                "usage": {"total_tokens": 7},
            },
        )

    spec = registry().default("product_text")
    provider = build_text_provider(spec, purpose="passage", batch_size=32)
    assert isinstance(provider, JinaEmbeddingClient)
    provider.client = httpx.Client(transport=httpx.MockTransport(handler))
    batch = validate_for(spec, provider.embed_texts(["Logitech mouse"]), 1)
    assert seen["model"] == "jina-embeddings-v3"
    assert seen["task"] == "retrieval.passage"
    assert seen["dimensions"] == 768
    assert seen["input"] == ["Logitech mouse"]
    assert provider.text_batch_size == 32
    assert batch.model_version == spec.id


def test_jina_query_purpose_uses_query_task() -> None:
    provider = build_text_provider(registry().default("product_text"), purpose="query")
    assert isinstance(provider, JinaEmbeddingClient) and provider.task == "retrieval.query"


def test_unknown_purpose_rejected() -> None:
    with pytest.raises(RegistryError, match="amac"):
        build_text_provider(registry().default("product_text"), purpose="classify")


def test_fake_client_satisfies_gate() -> None:
    spec = registry().default("product_text")
    fake = FakeEmbeddingClient(model=f"{spec.id}-fake", dimensions=spec.dimensions)
    validate_for(spec, fake.embed_texts(["a", "b"]), 2)


# --- Yerel CPU -----------------------------------------------------------------------------


def _local(**kwargs) -> tuple[LocalOnnxTextProvider, _StubEmbedder]:
    embedder = kwargs.pop("embedder", _StubEmbedder())
    provider = LocalOnnxTextProvider(spec=registry().get(E5), embedder=embedder, **kwargs)
    return provider, embedder


def test_local_provider_prefixes_normalizes_and_times() -> None:
    provider, embedder = _local(purpose="passage")
    batch = provider.embed_texts(["Logitech mouse", "Kablosuz klavye"])
    assert embedder.seen == ["passage: Logitech mouse", "passage: Kablosuz klavye"]
    assert len(batch.vectors) == 2 and all(len(v) == 384 for v in batch.vectors)
    assert all(abs(math.sqrt(sum(x * x for x in v)) - 1) < 1e-9 for v in batch.vectors)
    assert batch.model_version == E5 and batch.total_tokens > 0
    assert len(provider.latencies_ms) == 1


def test_local_query_prefix() -> None:
    provider, embedder = _local(purpose="query")
    provider.embed_texts(["mouse"])
    assert embedder.seen == ["query: mouse"]


def test_local_model_dir_version_must_match_registry() -> None:
    with pytest.raises(RegistryError, match="kayit defteri"):
        _local(embedder=_StubEmbedder(model_version="e5-small-int8-ffffffffffff"))


def test_local_wrong_dimension_fails_closed() -> None:
    provider, _ = _local(embedder=_StubEmbedder(dim=768))
    with pytest.raises(EmbeddingInvalid, match="boyut 384"):
        provider.embed_texts(["x"])


def test_local_runtime_error_becomes_embedding_error() -> None:
    embedder = _StubEmbedder()
    embedder.fail = True
    provider, _ = _local(embedder=embedder)
    with pytest.raises(EmbeddingError, match="yerel model hatasi"):
        provider.embed_texts(["x"])


def test_local_batch_size_bounded() -> None:
    provider, _ = _local(batch_size=10_000)
    assert provider.text_batch_size == LOCAL_MAX_BATCH


def test_local_provider_rejects_api_spec() -> None:
    with pytest.raises(RegistryError, match="yerel ONNX"):
        LocalOnnxTextProvider(spec=registry().default("product_text"), embedder=_StubEmbedder())


def test_local_build_requires_model_dir() -> None:
    with pytest.raises(RegistryError, match="--model-dir"):
        build_text_provider(registry().get(E5))
