"""Karar 0182: kip yetenekleri, kendi cikarim servisimiz (remote_http), uzay izolasyonu.

Ag yok: uzak servis `httpx.MockTransport` ile taklit edilir; bekleme enjekte edilir (uyku yok).
"""

from __future__ import annotations

import copy
import json
import math
from collections.abc import Callable

import httpx
import pytest

from enrich.client import EmbeddingError, EmbeddingRejected, JinaEmbeddingClient
from enrich.providers import (
    REMOTE_MAX_BATCH,
    REMOTE_WAIT_CAP_S,
    EmbeddingInvalid,
    RemoteHttpTextProvider,
    build_image_provider,
    build_text_provider,
    validate_endpoint,
)
from enrich.registry import REGISTRY_PATH, RegistryError, parse_registry, registry

QWEN = "qwen3-embedding-0.6b-97b0c614"
SERVED = "Qwen/Qwen3-Embedding-0.6B"
BASE = "http://embed-cpu:8080"


def _raw() -> dict:
    return json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))


def _model(raw: dict, model_id: str) -> dict:
    return next(m for m in raw["models"] if m["id"] == model_id)


def _unit(dim: int, seed: int = 1) -> list[float]:
    raw = [((seed * (i + 3)) % 17) - 8.0 for i in range(dim)]
    norm = math.sqrt(sum(v * v for v in raw))
    return [v / norm for v in raw]


def _ok(texts: list[str], *, dim: int = 1024, model: str | None = SERVED) -> dict:
    body: dict = {
        "object": "list",
        "data": [
            {"object": "embedding", "index": i, "embedding": _unit(dim, i + 1)}
            for i in range(len(texts))
        ],
        "usage": {"prompt_tokens": 7 * len(texts), "total_tokens": 7 * len(texts)},
    }
    if model is not None:
        body["model"] = model
    return body


def _provider(
    handler: Callable[[httpx.Request], httpx.Response],
    *,
    purpose: str = "passage",
    sleeps: list[float] | None = None,
    **kwargs,
) -> RemoteHttpTextProvider:
    waits = sleeps if sleeps is not None else []
    return RemoteHttpTextProvider(
        spec=registry().get(QWEN),
        base_url=BASE,
        purpose=purpose,
        client=httpx.Client(transport=httpx.MockTransport(handler)),
        sleep=waits.append,
        **kwargs,
    )


# --- Kayit defteri: kip yetenekleri, endpoint, online_query -----------------------------------


def test_capabilities_are_declared_and_provider_bounded() -> None:
    reg = registry()
    assert reg.get("jina-clip-v2").capabilities == {"text", "image"}
    assert reg.get("jina-embeddings-v3").capabilities == {"text"}
    assert reg.get(QWEN).capabilities == {"text"}
    assert reg.get("e5-small-int8-0bcc8ca76950").capabilities == {"text"}


def test_provider_cannot_declare_unsupported_modality() -> None:
    raw = _raw()
    _model(raw, "e5-small-int8-0bcc8ca76950")["modalities"] = ["text", "image"]
    with pytest.raises(RegistryError, match="kipini desteklemiyor"):
        parse_registry(raw)


def test_remote_http_requires_endpoint_and_others_forbid_it() -> None:
    raw = _raw()
    del _model(raw, QWEN)["endpoint"]
    with pytest.raises(RegistryError, match="endpoint zorunlu"):
        parse_registry(raw)
    raw = _raw()
    _model(raw, "jina-embeddings-v3")["endpoint"] = {"url_env": "EMBED_X_URL", "served_model": "x"}
    with pytest.raises(RegistryError, match="yalniz remote_http"):
        parse_registry(raw)


@pytest.mark.parametrize("url_env", ["JINA_API_KEY", "EMBED__URL", "embed_x_url", "EMBED_X"])
def test_endpoint_env_name_is_constrained(url_env: str) -> None:
    raw = _raw()
    _model(raw, QWEN)["endpoint"]["url_env"] = url_env
    with pytest.raises(RegistryError, match="url_env"):
        parse_registry(raw)


def test_endpoint_rejects_unknown_fields_and_blank_served_model() -> None:
    raw = _raw()
    _model(raw, QWEN)["endpoint"]["api_key"] = "x"
    with pytest.raises(RegistryError, match="bilinmeyen alan"):
        parse_registry(raw)
    raw = _raw()
    _model(raw, QWEN)["endpoint"]["served_model"] = " "
    with pytest.raises(RegistryError, match="served_model"):
        parse_registry(raw)


def test_online_query_is_required_boolean() -> None:
    raw = _raw()
    del _model(raw, "jina-embeddings-v3")["online_query"]
    with pytest.raises(RegistryError, match="eksik alan"):
        parse_registry(raw)
    raw = _raw()
    _model(raw, "jina-embeddings-v3")["online_query"] = "yes"
    with pytest.raises(RegistryError, match="online_query"):
        parse_registry(raw)


def test_only_models_with_a_live_query_path_are_marked_online() -> None:
    """Canli sorgu vektoru TS'de uretilir: Jina istemcisi ve BGE-M3 sorgu servisi (karar 0182/0196).

    BGE-M3 `online_query=true` ama model `disabled`: kayit defteri bayragi yalniz TS'nin sorgu yolu
    oldugunu soyler, etkinlestirmez (`enrich.index activate` ayrica insan onayi ister).
    """
    online = {m.id for m in registry().models.values() if m.online_query}
    assert online == {"jina-clip-v2", "jina-embeddings-v3", "bge-m3-5617a9f6"}
    assert not registry().get("bge-m3-5617a9f6").production_ready


def test_candidates_are_pinned_and_not_selectable_in_production() -> None:
    reg = registry()
    qwen, bge = reg.get(QWEN), reg.get("bge-m3-5617a9f6")
    assert qwen.source == {"repo": SERVED, "revision": "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3"}
    assert QWEN.endswith(qwen.source["revision"][:8])
    assert bge.source["revision"] == "5617a9f61b028005a4858fdac845db406aefb181"
    for spec in (qwen, bge):
        assert spec.state == "disabled" and not spec.production_ready
        assert spec.dimensions == 1024
        # Depolama tablosu var (migration 0114, karar 0195) ama model `disabled`: uretimde
        # secilemez.
        assert reg.family(spec).table == "product_text_embedding_d1024"


def test_same_dimension_is_not_same_space() -> None:
    reg = registry()
    qwen, bge = reg.get(QWEN), reg.get("bge-m3-5617a9f6")
    assert qwen.dimensions == bge.dimensions == 1024
    assert qwen.index_family == bge.index_family
    assert not qwen.same_space(bge)
    assert qwen.same_space(QWEN)
    v3 = reg.get("jina-embeddings-v3")
    assert v3.same_space("jina-embeddings-v3-fake")
    assert not v3.same_space("jina-clip-v2")  # ikisi de 768 ama farkli uzay


def test_shipped_registry_round_trips_without_mutation() -> None:
    raw = _raw()
    snapshot = copy.deepcopy(raw)
    parse_registry(raw)
    assert raw == snapshot


# --- Saglayici kurulumu ----------------------------------------------------------------------


def test_image_provider_only_for_image_capable_models(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("JINA_API_KEY", "test-key")
    provider = build_image_provider(registry().get("jina-clip-v2"), batch_size=4)
    assert isinstance(provider, JinaEmbeddingClient)
    assert provider.model_version == "jina-clip-v2"
    assert provider.image_batch_size == 4
    for model in ("jina-embeddings-v3", QWEN, "e5-small-int8-0bcc8ca76950"):
        with pytest.raises(RegistryError, match="gorsel kipi yok"):
            build_image_provider(registry().get(model))


def test_build_remote_provider_reads_env_and_optional_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    spec = registry().get(QWEN)
    monkeypatch.delenv("EMBED_QWEN3_06B_URL", raising=False)
    with pytest.raises(RegistryError, match="EMBED_QWEN3_06B_URL tanimli degil"):
        build_text_provider(spec)
    monkeypatch.setenv("EMBED_QWEN3_06B_URL", "http://embed-cpu:8080/")
    monkeypatch.setenv("EMBED_QWEN3_06B_TOKEN", "s3cret")
    provider = build_text_provider(spec, purpose="query", batch_size=999)
    assert isinstance(provider, RemoteHttpTextProvider)
    assert provider.base_url == "http://embed-cpu:8080"
    assert provider.token == "s3cret"
    assert provider.text_batch_size == REMOTE_MAX_BATCH
    assert provider.model_version == QWEN


def test_remote_provider_rejects_non_remote_spec() -> None:
    with pytest.raises(RegistryError, match="remote_http saglayicisi degil"):
        RemoteHttpTextProvider(spec=registry().get("jina-embeddings-v3"), base_url=BASE)


@pytest.mark.parametrize(
    "url",
    [
        "http://embed-cpu:8080",
        "http://localhost:8080",
        "http://127.0.0.1:8080",
        "http://10.0.0.5:8080/infer",
        "http://192.168.1.20",
        "https://gpu.example.com",
    ],
)
def test_endpoint_accepts_private_http_or_any_https(url: str) -> None:
    assert validate_endpoint(url) == url.rstrip("/")


@pytest.mark.parametrize(
    "url",
    [
        "http://gpu.example.com",  # acik internette duz HTTP
        "http://8.8.8.8:8080",
        "https://user:pw@gpu.example.com",  # kimlik bilgisi URL'de
        "https://gpu.example.com/?key=x",
        "ftp://embed-cpu",
        "embed-cpu:8080",
    ],
)
def test_endpoint_rejects_unsafe_urls(url: str) -> None:
    with pytest.raises(RegistryError):
        validate_endpoint(url)


# --- Uzak sozlesme: istek bicimi, dogrulama, hata ve tekrar ------------------------------------


def test_request_shape_prefix_auth_and_validated_result() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=_ok(json.loads(request.content)["input"]))

    provider = _provider(handler, purpose="query", token="t0k")
    batch = provider.embed_texts(["kablolu oyuncu faresi", "su gecirmez mont"])
    request = seen[0]
    assert str(request.url) == f"{BASE}/v1/embeddings"
    assert request.headers["authorization"] == "Bearer t0k"
    body = json.loads(request.content)
    assert body["model"] == SERVED
    prefix = registry().get(QWEN).prefix("query")
    assert prefix.startswith("Instruct: ") and prefix.endswith("\nQuery:")
    assert body["input"] == [prefix + "kablolu oyuncu faresi", prefix + "su gecirmez mont"]
    assert batch.model_version == QWEN
    assert batch.total_tokens == 14
    assert len(batch.vectors) == 2 and all(len(v) == 1024 for v in batch.vectors)
    assert provider.latencies_ms and provider.latencies_ms[0] >= 0


def test_passage_purpose_sends_no_instruction_and_no_auth_header() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=_ok(json.loads(request.content)["input"]))

    _provider(handler).embed_texts(["Logitech G102 kablolu fare"])
    assert json.loads(seen[0].content)["input"] == ["Logitech G102 kablolu fare"]
    assert "authorization" not in seen[0].headers


def test_out_of_order_items_are_reordered_by_index() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = _ok(json.loads(request.content)["input"])
        body["data"].reverse()
        return httpx.Response(200, json=body)

    batch = _provider(handler).embed_texts(["a", "b", "c"])
    assert batch.vectors[0] == pytest.approx(_unit(1024, 1), abs=1e-6)
    assert batch.vectors[2] == pytest.approx(_unit(1024, 3), abs=1e-6)


def test_missing_usage_falls_back_to_estimate() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = _ok(json.loads(request.content)["input"])
        del body["usage"]
        return httpx.Response(200, json=body)

    batch = _provider(handler).embed_texts(["x" * 55])
    assert batch.total_tokens == math.ceil(55 / registry().get(QWEN).chars_per_token)


def test_unnormalized_vectors_are_l2_normalized() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = _ok(json.loads(request.content)["input"])
        body["data"][0]["embedding"] = [v * 7.0 for v in body["data"][0]["embedding"]]
        return httpx.Response(200, json=body)

    vector = _provider(handler).embed_texts(["a"]).vectors[0]
    assert math.sqrt(sum(v * v for v in vector)) == pytest.approx(1.0, abs=1e-6)


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda b: b.update(model="BAAI/bge-m3"), "modelini bildirdi"),
        (lambda b: b["data"][0].update(embedding=_unit(768)), "boyut 1024"),
        (lambda b: b["data"].pop(), "vektor geldi"),
        (lambda b: b["data"][0].update(embedding=[0.0] * 1024), "sifir norm"),
        (lambda b: b["data"][0].update(embedding=[float("nan")] * 1024), "sonlu olmayan"),
        (lambda b: b["data"][1].update(index=0), "index dizisi"),
        (lambda b: b["data"][0].pop("embedding"), "index/embedding"),
        (lambda b: b.pop("data"), "data listesi"),
    ],
)
def test_invalid_responses_are_rejected_before_any_write(mutate, message: str) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = _ok(json.loads(request.content)["input"])
        mutate(body)
        return httpx.Response(200, content=json.dumps(body, allow_nan=True).encode())

    with pytest.raises(EmbeddingInvalid, match=message):
        _provider(handler).embed_texts(["a", "b"])


def test_server_without_model_field_is_accepted() -> None:
    """TEI gibi bazi sunucular `model` dondurmez; boyut/norm kapisi yine calisir."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_ok(json.loads(request.content)["input"], model=None))

    assert len(_provider(handler).embed_texts(["a"]).vectors) == 1


def test_non_json_body_is_invalid() -> None:
    with pytest.raises(EmbeddingInvalid, match="JSON degil"):
        _provider(lambda r: httpx.Response(200, content=b"<html>")).embed_texts(["a"])


def test_transient_failures_retry_with_bounded_waits() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            raise httpx.ConnectTimeout("yavas", request=request)
        if calls["n"] == 2:
            return httpx.Response(503)
        if calls["n"] == 3:
            return httpx.Response(429, headers={"retry-after": "999"})
        return httpx.Response(200, json=_ok(json.loads(request.content)["input"]))

    sleeps: list[float] = []
    batch = _provider(handler, sleeps=sleeps).embed_texts(["a"])
    assert calls["n"] == 4
    assert len(batch.vectors) == 1
    assert len(sleeps) == 3
    assert sleeps[-1] == REMOTE_WAIT_CAP_S  # Retry-After 999 tavana kirpilir
    assert all(0 < s <= REMOTE_WAIT_CAP_S for s in sleeps)


def test_exhausted_retries_raise_embedding_error() -> None:
    sleeps: list[float] = []
    provider = _provider(lambda r: httpx.Response(502), sleeps=sleeps, max_attempts=3)
    with pytest.raises(EmbeddingError, match="3 denemede basarisiz \\(HTTP 502\\)"):
        provider.embed_texts(["a"])
    assert len(sleeps) == 2  # son denemeden sonra beklenmez


@pytest.mark.parametrize("status", [400, 401, 403, 404, 413, 422])
def test_permanent_client_errors_are_not_retried_and_hide_body(status: int) -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(status, text="girdi: gizli kullanici metni")

    with pytest.raises(EmbeddingRejected) as caught:
        _provider(handler).embed_texts(["a"])
    assert calls["n"] == 1
    assert "gizli" not in str(caught.value)


def test_oversized_batch_is_refused_without_a_request() -> None:
    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover - cagrilmamali
        raise AssertionError("istek gitmemeliydi")

    provider = _provider(handler, batch_size=2)
    with pytest.raises(EmbeddingError, match="parti 3 > sinir 2"):
        provider.embed_texts(["a", "b", "c"])


def test_empty_input_makes_no_request() -> None:
    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover - cagrilmamali
        raise AssertionError("istek gitmemeliydi")

    batch = _provider(handler).embed_texts([])
    assert batch.vectors == [] and batch.total_tokens == 0
