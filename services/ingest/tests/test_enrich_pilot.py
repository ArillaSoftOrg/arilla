"""Pilot CLI ve urun isinin model izolasyonu (karar 0180) — veritabanisiz."""

from __future__ import annotations

import json

import pytest

from enrich import pilot, products
from enrich.client import FakeEmbeddingClient
from enrich.products import Options, ProductCounts, ProductEmbedder, decide_outcome, latency_detail
from enrich.providers import LocalOnnxTextProvider
from enrich.registry import registry

E5 = "e5-small-int8-0bcc8ca76950"


class _NoDb:
    """Veritabanina dokunulursa test patlar: uyumsuz model hicbir sorgu calistirmamali."""

    def __getattr__(self, name):
        raise AssertionError(f"veritabani kullanildi: {name}")


@pytest.mark.parametrize(
    ("model", "dimensions"), [("bge-m3", 1024), ("x-model", 768), ("jina-clip-v2", 768)]
)
def test_incompatible_model_never_touches_product_table(model: str, dimensions: int) -> None:
    client = FakeEmbeddingClient(model=model, dimensions=dimensions)
    counts = ProductEmbedder(_NoDb(), client, Options(dry_run=False)).run()
    assert counts.incompatible
    assert decide_outcome(counts) == ("failed", "incompatible_index")
    assert counts.written == 0 and client.calls == 0


def test_cli_rejects_disabled_and_wrong_role(capsys: pytest.CaptureFixture[str]) -> None:
    for model in ("bge-m3", "jina-clip-v2"):
        assert products.main(["--model", model]) == 2
        assert "model secilemez" in capsys.readouterr().err


def test_cli_pilot_model_only_on_local_db(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@db.example.com:5432/x")
    assert products.main(["--model", E5]) == 2
    assert "uretimde secilemez" in capsys.readouterr().err
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@127.0.0.1:5432/x")
    assert products.main(["--model", E5]) == 2
    assert "--model-dir gerekli" in capsys.readouterr().err


def test_latency_detail_numbers_only() -> None:
    assert latency_detail([], 0) == {}
    detail = latency_detail([10.0, 20.0, 30.0, 40.0], 200)
    assert detail == {"embed_ms_p50": 20, "embed_ms_p95": 40, "items_per_s": 2000.0}


def test_counts_detail_carries_provider_and_model() -> None:
    counts = ProductCounts(model="jina-embeddings-v3", provider="jina", api_texts=10)
    counts.latencies_ms.extend([5.0, 15.0])
    detail = counts.detail()
    assert detail["model"] == "jina-embeddings-v3" and detail["provider"] == "jina"
    assert {"embed_ms_p50", "embed_ms_p95", "items_per_s"} <= set(detail)
    assert len(json.dumps(detail)) < 4096  # job_run.detail siniri


def test_pilot_rejects_api_models(capsys: pytest.CaptureFixture[str], tmp_path) -> None:
    texts = tmp_path / "t.txt"
    texts.write_text("mouse\n", encoding="utf-8")
    code = pilot.main(
        ["--model", "jina-embeddings-v3", "--model-dir", str(tmp_path), "--texts-file", str(texts)]
    )
    assert code == 2 and "API yok" in capsys.readouterr().err


def test_pilot_measures_remote_model_over_http_and_reports_canary(
    capsys, tmp_path, monkeypatch
) -> None:
    """Karar 0186: pilot `remote_http` modelini de olcer (yazmaz); devre disi model olculebilir."""
    from tests.fake_embed_server import FakeEmbedServer

    texts = tmp_path / "t.txt"
    texts.write_text("Logitech G305 Kablosuz Mouse\nApple iPhone 15\n", encoding="utf-8")
    with FakeEmbedServer(model="Qwen/Qwen3-Embedding-0.6B", dimensions=1024) as server:
        monkeypatch.setenv("EMBED_QWEN3_06B_URL", server.url)
        code = pilot.main(["--model", "qwen3-embedding-0.6b-97b0c614", "--texts-file", str(texts)])
    out = capsys.readouterr().out
    result = json.loads(out)
    assert code == 0 and result["texts"] == 2 and result["provider"] == "remote_http"
    # Sahte sunucu altin vektoru uretmez -> kanarya olcumu esige yaklasamaz (anlamsiz vektor).
    assert result["canary_min_cosine"] is None or result["canary_min_cosine"] < 0.99


def test_pilot_rejects_missing_model_dir(capsys: pytest.CaptureFixture[str], tmp_path) -> None:
    texts = tmp_path / "t.txt"
    texts.write_text("mouse\n", encoding="utf-8")
    code = pilot.main(["--model", E5, "--model-dir", str(tmp_path), "--texts-file", str(texts)])
    assert code == 2 and "model yuklenemedi" in capsys.readouterr().err


def test_pilot_from_db_refuses_remote(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@db.example.com:5432/x")
    with pytest.raises(SystemExit, match="yerel"):
        pilot.texts_from_db(10, 1, 2.75, 64)


def test_pilot_measure_reports_numbers_only() -> None:
    class _Embedder:
        model_version = E5
        pooling = "mean"

        def with_prefix(self, prefix):
            return self

        def encode(self, texts):
            return [[1.0] + [0.0] * 383 for _ in texts]

    provider = LocalOnnxTextProvider(spec=registry().get(E5), embedder=_Embedder(), batch_size=2)
    long_text = "x" * 400
    result = pilot.measure(provider, ["kisa", "Logitech mouse", long_text], 64)
    assert result["texts"] == 3 and result["failed_batches"] == 0
    assert result["over_token_limit_ratio"] == round(1 / 3, 3)
    assert "embed_ms_p50" in result and "kisa" not in json.dumps(result)
