"""Karar 0186: havuzlama, altin vektor kanaryasi ve CPU servis profili.

Model gerektirmez (normal CI). Gercek model/TEI ile olcum ayri isaretlidir: `@pytest.mark.model`
(bkz. test_embedding_golden_model.py) ve normal CI'da calismaz.
"""

from __future__ import annotations

import copy
import json
import re
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest

from enrich import canary, pooling
from enrich.canary import CanaryFailed, compare, load_golden, measured_tolerance, require_canary
from enrich.providers import LocalOnnxTextProvider, RemoteHttpTextProvider
from enrich.registry import (
    POOLINGS,
    REGISTRY_PATH,
    RegistryError,
    parse_registry,
    registry,
)
from tests.fake_embed_server import FakeEmbedServer, deterministic_vector

QWEN = "qwen3-embedding-0.6b-97b0c614"
BGE = "bge-m3"
E5 = "e5-small-int8-0bcc8ca76950"
REPO = Path(__file__).resolve().parents[3]
INFRA = REPO / "infra"
#: Resmi `1_Pooling/config.json` (sabit revizyonlarda, 2026-11-11 okundu; karar 0186).
OFFICIAL_POOLING = {QWEN: "last_token", BGE: "cls", E5: "mean"}


def _raw() -> dict:
    return json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))


def _model(raw: dict, model_id: str) -> dict:
    return next(m for m in raw["models"] if m["id"] == model_id)


# --- kayit defteri: pooling alani ------------------------------------------------------


def test_self_hosted_models_declare_official_pooling_jina_does_not() -> None:
    reg = registry()
    for model_id, expected in OFFICIAL_POOLING.items():
        spec = reg.get(model_id)
        assert spec.self_hosted and spec.pooling == expected, model_id
    for spec in reg.models.values():
        if spec.provider == "jina":
            # Mevcut aktif Jina kayitlari: havuzlama saglayicida, kanarya kapsam disi.
            assert spec.pooling is None and not spec.self_hosted
        else:
            assert spec.pooling in POOLINGS


@pytest.mark.parametrize(
    ("model_id", "mutate", "message"),
    [
        (QWEN, lambda m: m.pop("pooling"), "pooling zorunlu"),
        (E5, lambda m: m.update(pooling="max"), "pooling zorunlu"),
        ("jina-embeddings-v3", lambda m: m.update(pooling="mean"), "yalniz kendi"),
    ],
)
def test_registry_rejects_bad_pooling(model_id, mutate, message) -> None:
    raw = _raw()
    mutate(_model(raw, model_id))
    with pytest.raises(RegistryError, match=message):
        parse_registry(raw)


# --- havuzlama birim testleri (sentetik token vektorleri) -----------------------------

# 2 satir, 4 konum, 2 boyut. Satir 0 sag dolgulu (3 gercek token), satir 1 dolu.
HIDDEN = np.array(
    [
        [[1.0, 0.0], [3.0, 2.0], [5.0, 4.0], [100.0, 100.0]],
        [[2.0, 2.0], [4.0, 0.0], [6.0, 2.0], [8.0, 4.0]],
    ]
)
MASK = np.array([[1, 1, 1, 0], [1, 1, 1, 1]])


def test_cls_takes_first_token() -> None:
    assert pooling.pool(HIDDEN, MASK, "cls").tolist() == [[1.0, 0.0], [2.0, 2.0]]


def test_mean_ignores_padding() -> None:
    assert pooling.pool(HIDDEN, MASK, "mean").tolist() == [[3.0, 2.0], [5.0, 2.0]]


def test_last_token_with_right_and_left_padding() -> None:
    assert pooling.pool(HIDDEN, MASK, "last_token").tolist() == [[5.0, 4.0], [8.0, 4.0]]
    left_hidden = np.array([[[100.0, 100.0], [1.0, 0.0], [3.0, 2.0], [5.0, 4.0]]])
    left_mask = np.array([[0, 1, 1, 1]])
    assert pooling.pool(left_hidden, left_mask, "last_token").tolist() == [[5.0, 4.0]]


def test_methods_differ_so_wrong_choice_changes_the_space() -> None:
    a, b, c = (pooling.normalize_l2(pooling.pool(HIDDEN, MASK, m)) for m in POOLINGS)
    assert not np.allclose(a, b) and not np.allclose(b, c) and not np.allclose(a, c)
    # Hepsi birim norm: norm kapisi yanlis yontemi YAKALAYAMAZ -> kanarya gerekli.
    for v in (a, b, c):
        assert np.allclose(np.linalg.norm(v, axis=1), 1.0)


@pytest.mark.parametrize(
    ("hidden", "mask", "method", "message"),
    [
        (HIDDEN, np.array([[0, 1, 1, 1], [1, 1, 1, 1]]), "cls", "sol dolgu"),
        (HIDDEN, np.array([[0, 0, 0, 0], [1, 1, 1, 1]]), "mean", "tamamen dolgu"),
        (HIDDEN, MASK, "max", "bilinmeyen"),
        (HIDDEN, MASK[:, :3], "mean", "boyut"),
        (HIDDEN, np.array([[1, 2, 1, 0], [1, 1, 1, 1]]), "mean", "0/1"),
    ],
)
def test_pooling_rejects_invalid_input(hidden, mask, method, message) -> None:
    with pytest.raises(pooling.PoolingError, match=message):
        pooling.pool(hidden, mask, method)


# --- havuzlama GERCEK cikarima yansiyor mu (OnnxEmbedder kodu, sahte ONNX oturumu) --------


class _Encoding:
    def __init__(self, ids: list[int], mask: list[int]) -> None:
        self.ids, self.attention_mask = ids, mask


class _Tokenizer:
    def encode_batch(self, texts):
        return [_Encoding([5, 6, 7, 1], [1, 1, 1, 0]) for _ in texts]


class _Session:
    def run(self, _outputs, feed):
        batch = feed["input_ids"].shape[0]
        hidden = np.zeros((batch, 4, 384), dtype=np.float32)
        hidden[:, 0, 0] = 1.0  # CLS
        hidden[:, 1, 1] = 1.0
        hidden[:, 2, 2] = 1.0  # son gercek token
        hidden[:, 3, 3] = 50.0  # dolgu: hicbir yontem kullanmamali
        return [hidden]


def _onnx_embedder(method: str):
    from classify.suggest.model import OnnxEmbedder

    embedder = object.__new__(OnnxEmbedder)
    embedder._np = np
    embedder._session = _Session()
    embedder._tokenizer = _Tokenizer()
    embedder._input_names = {"input_ids", "attention_mask"}
    embedder.batch_size = 8
    embedder.prefix = ""
    embedder.pooling = method
    embedder.model_version = E5
    return embedder


def test_onnx_embedder_applies_the_configured_pooling() -> None:
    cls = _onnx_embedder("cls").encode(["x"])[0]
    mean = _onnx_embedder("mean").encode(["x"])[0]
    last = _onnx_embedder("last_token").encode(["x"])[0]
    assert np.argmax(cls) == 0 and np.argmax(last) == 2
    assert np.allclose(mean[:3], 1 / np.sqrt(3), atol=1e-6) and mean[3] == 0.0


def test_local_provider_refuses_embedder_with_other_pooling() -> None:
    with pytest.raises(RegistryError, match="havuzlamasi 'cls'"):
        LocalOnnxTextProvider(spec=registry().get(E5), embedder=_onnx_embedder("cls"))
    provider = LocalOnnxTextProvider(spec=registry().get(E5), embedder=_onnx_embedder("mean"))
    assert len(provider.embed_texts(["a"]).vectors[0]) == 384


# --- kanarya ---------------------------------------------------------------------------


def _golden(spec_id: str = QWEN, *, tolerance: object = "measured") -> dict:
    spec = registry().get(spec_id)
    cases = []
    for purpose, texts in (
        ("passage", ["telefon", "fritoz", "ayakkabi"]),
        ("query", ["mouse", "bot"]),
    ):
        cases += [
            {
                "purpose": purpose,
                "text": t,
                "vector": deterministic_vector(f"g:{t}", spec.dimensions),
            }
            for t in texts
        ]
    if tolerance == "measured":
        tolerance = {"min_cosine": 0.999, "evidence": {"observed_min_cosine": 0.99999}}
    return {
        "format": 1,
        "model_id": spec.id,
        "source": dict(spec.source),
        "pooling": spec.pooling,
        "dimensions": spec.dimensions,
        "normalization": spec.normalization,
        "preprocessing_version": spec.preprocessing_version,
        "prefixes": dict(spec.prefixes),
        "reference": {"implementation": "test"},
        "cases": cases,
        "tolerance": tolerance,
    }


def _write(tmp_path: Path, golden: dict) -> Path:
    (tmp_path / f"{golden['model_id']}.json").write_text(json.dumps(golden), encoding="utf-8")
    return tmp_path


def _factory(server: FakeEmbedServer, spec_id: str = QWEN):
    spec = registry().get(spec_id)

    def factory(purpose: str) -> RemoteHttpTextProvider:
        return RemoteHttpTextProvider(spec=spec, base_url=server.url, purpose=purpose)

    return factory


def _server(golden: dict, mode: str) -> FakeEmbedServer:
    spec = registry().get(golden["model_id"])
    assert spec.endpoint is not None
    return FakeEmbedServer(
        model=spec.endpoint["served_model"], dimensions=spec.dimensions, mode=mode, golden=golden
    )


def test_canary_passes_over_real_http_when_output_matches_golden(tmp_path: Path) -> None:
    golden = _golden()
    with _server(golden, "golden") as server:
        result = require_canary(registry().get(QWEN), _factory(server), _write(tmp_path, golden))
    assert result.passed and result.min_cosine == pytest.approx(1.0)
    assert len(result.cosines) == 5
    # Sorgu oneki gercekten gitti mi (karsilastirma ayni girdiyle mi yapildi)?
    sent = [t for body in server.requests for t in body["input"]]
    prefix = registry().get(QWEN).prefix("query")
    assert any(t.startswith(prefix) for t in sent) and prefix


def test_canary_fails_closed_on_wrong_pooling_output(tmp_path: Path) -> None:
    golden = _golden()
    with _server(golden, "wrong_pooling") as server, pytest.raises(CanaryFailed, match="kosinus"):
        require_canary(registry().get(QWEN), _factory(server), _write(tmp_path, golden))


def test_canary_detects_swapped_outputs(tmp_path: Path) -> None:
    golden = _golden()
    swapped = copy.deepcopy(golden)
    swapped["cases"][0]["text"], swapped["cases"][1]["text"] = (
        golden["cases"][1]["text"],
        golden["cases"][0]["text"],
    )
    with _server(swapped, "golden") as server, pytest.raises(CanaryFailed, match="daha yakin"):
        require_canary(registry().get(QWEN), _factory(server), _write(tmp_path, golden))


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (lambda g: g.update(tolerance=None), "OLCULMEDI"),
        (lambda g: g.update(tolerance={"min_cosine": 0.999}), "kanit"),
        (
            lambda g: g.update(
                tolerance={"min_cosine": 0.95, "evidence": {"observed_min_cosine": 1}}
            ),
            "araliginda",
        ),
        (lambda g: g["source"].update(revision="0" * 40), "revizyon"),
        (lambda g: g.update(pooling="mean"), "havuzlama"),
        (lambda g: g.update(prefixes={}), "onekler"),
        (lambda g: g.update(dimensions=768), "vektor"),
        (lambda g: g.update(cases=g["cases"][:1]), "en az iki"),
        (lambda g: g.pop("tolerance"), "alanlari"),
    ],
)
def test_canary_fails_closed_on_unverified_golden(tmp_path: Path, change, message) -> None:
    golden = _golden()
    with _server(golden, "golden") as server:
        change(golden)
        with pytest.raises(CanaryFailed, match=message):
            require_canary(registry().get(QWEN), _factory(server), _write(tmp_path, golden))


def test_canary_fails_closed_without_golden_file_or_on_server_error(tmp_path: Path) -> None:
    with pytest.raises(CanaryFailed, match="altin vektor dosyasi yok"):
        require_canary(registry().get(QWEN), lambda p: None, tmp_path)
    golden = _golden()
    with _server(golden, "golden") as server:
        server.fail_statuses = [400, 400]
        with pytest.raises(CanaryFailed, match="saglayici hatasi"):
            require_canary(registry().get(QWEN), _factory(server), _write(tmp_path, golden))


def test_jina_models_are_out_of_canary_scope_and_untouched() -> None:
    calls: list[str] = []
    result = require_canary(registry().get("jina-embeddings-v3"), calls.append, Path("/yok"))
    assert calls == [] and result.cosines == []


def test_every_self_hosted_model_is_fail_closed_until_measured() -> None:
    """Repodaki altin dosyalar ya YOK ya da olculmus esik + kanit icerir; ikisi de degilse
    kapi kapali kalir. Sahte basari yok: olculmemis model `require_canary`'den GECEMEZ."""
    for spec in registry().models.values():
        if not spec.self_hosted:
            continue
        path = canary.golden_path(spec.id)
        if not path.is_file():
            with pytest.raises(CanaryFailed, match="dosyasi yok"):
                require_canary(spec, lambda p: None)
            continue
        golden = load_golden(spec.id)
        assert canary.metadata_problems(spec, golden) == [], spec.id
        if golden.tolerance is None:
            with pytest.raises(CanaryFailed, match="OLCULMEDI"):
                require_canary(spec, lambda p: None)
        else:
            assert canary.threshold_of(golden) >= canary.MIN_ALLOWED_THRESHOLD


def test_measured_tolerance_is_derived_from_observation_not_guessed(tmp_path: Path) -> None:
    golden = _golden(tolerance=None)
    with _server(golden, "golden") as server:
        spec = registry().get(QWEN)
        result = compare(spec, canary.parse_golden(golden), _factory(server), threshold=None)
    tol = measured_tolerance(result, margin=0.0005, served_by="fake")
    assert tol["min_cosine"] == 0.9995 and tol["evidence"]["observed_min_cosine"] == 1.0
    with _server(golden, "wrong_pooling") as server:
        bad = compare(spec, canary.parse_golden(golden), _factory(server), threshold=None)
    with pytest.raises(CanaryFailed, match="ayni uzayda degil"):
        measured_tolerance(bad, margin=0.0005, served_by="fake")


def test_products_execute_is_blocked_by_canary(monkeypatch, capsys, tmp_path: Path) -> None:
    """Yazma yolu: kendi calistirilan model kanaryasiz `--execute` ile yazamaz (DB'ye gitmeden)."""
    from enrich import products

    spec = registry().get(QWEN)
    golden = _golden()
    with _server(golden, "wrong_pooling") as server:
        monkeypatch.setenv("EMBED_QWEN3_06B_URL", server.url)
        monkeypatch.setattr(products, "_validate", lambda args: None)
        monkeypatch.setattr(products, "_select", lambda args, local: spec)
        monkeypatch.setattr(canary, "GOLDEN_DIR", _write(tmp_path, golden))
        monkeypatch.setattr(
            products, "require_canary", lambda s, f: canary.require_canary(s, f, tmp_path)
        )
        monkeypatch.setattr(products, "connect", lambda: pytest.fail("DB'ye gidilmemeli"))
        assert products.main(["--model", QWEN, "--execute", "--max-tokens", "10"]) == 2
    assert "kanarya" in capsys.readouterr().err


# --- CPU servis profili (compose) ------------------------------------------------------


def _compose_text() -> str:
    return (INFRA / "compose.embed.yml").read_text(encoding="utf-8")


def test_embed_compose_is_opt_in_isolated_and_bounded() -> None:
    text = _compose_text()
    assert re.search(r'profiles:\s*\["embed-cpu"\]', text)
    assert not re.search(r"^\s*ports:", text, re.M), "ports: yasak (karar 0186)"
    assert re.search(r"embed:\s*\n\s*internal: true", text)
    assert re.search(r"image: \S+:cpu-[\d.]+@sha256:[0-9a-f]{64}", text), "imaj digest'e sabit"
    for needle in (
        'HF_HUB_OFFLINE: "1"',
        'HF_ENDPOINT: "http://127.0.0.1:9"',
        "read_only: true",
        "cap_drop: [ALL]",
        "no-new-privileges:true",
        "--auto-truncate=true",
        "healthcheck:",
        "stop_grace_period:",
        "pids_limit:",
        "${EMBED_CPU_CPUS:-2.0}",
        "${EMBED_CPU_MEMORY:-6g}",
        "--max-concurrent-requests=",
    ):
        assert needle in text, needle
    # Uretim yigini ve dagitim hatti bu servisi bilmez.
    assert "embed-cpu" not in (INFRA / "compose.prod.yml").read_text(encoding="utf-8")


def _env(path: Path) -> dict[str, str]:
    values = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip() and not line.startswith("#"):
            key, _, value = line.partition("=")
            values[key.strip()] = value.strip()
    return values


def test_embed_env_profiles_match_registry_pooling_and_served_name() -> None:
    tei = {"cls": "cls", "mean": "mean", "last_token": "last-token"}
    remote = {s.id: s for s in registry().models.values() if s.provider == "remote_http"}
    files = {p.stem: _env(p) for p in (INFRA / "embed").glob("*.env")}
    assert set(files) == set(remote), "her remote_http modeli icin tek profil"
    for model_id, env in files.items():
        spec = remote[model_id]
        assert spec.endpoint is not None
        assert env["EMBED_CPU_SERVED_MODEL"] == spec.endpoint["served_model"], model_id
        assert env["EMBED_CPU_POOLING"] == tei[spec.pooling or ""], model_id
        assert re.fullmatch(r"[a-z0-9][a-z0-9._-]+", env["EMBED_CPU_MODEL_DIR"]), model_id
        assert not ({"TOKEN", "KEY", "SECRET", "PASSWORD"} & set("_".join(env).split("_")))


@pytest.mark.skipif(shutil.which("docker") is None, reason="docker yok")
def test_embed_compose_renders_and_starts_nothing_without_profile() -> None:
    base = ["docker", "compose", "-f", str(INFRA / "compose.embed.yml")]
    env_file = ["--env-file", str(INFRA / "embed" / f"{QWEN}.env")]
    try:
        none = subprocess.run(
            [*base, *env_file, "config", "--services"], capture_output=True, text=True, timeout=60
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        pytest.skip(f"docker compose calismadi: {error}")
    if none.returncode != 0 and "docker daemon" in (none.stderr or "").lower():
        pytest.skip("docker daemon yok")
    assert none.returncode == 0, none.stderr
    assert none.stdout.strip() == "", "profil olmadan hicbir servis yok"
    rendered = subprocess.run(
        [*base, *env_file, "--profile", "embed-cpu", "config", "--format", "json"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert rendered.returncode == 0, rendered.stderr
    service = json.loads(rendered.stdout)["services"]["embed-cpu"]
    assert "ports" not in service
    assert float(service["cpus"]) == 2.0
    assert int(service["mem_limit"]) == 6 * 1024**3
    assert service["read_only"] is True and service["user"] == "10001:10001"
    assert "--pooling=last-token" in service["command"]
    assert json.loads(rendered.stdout)["networks"]["embed"]["internal"] is True
