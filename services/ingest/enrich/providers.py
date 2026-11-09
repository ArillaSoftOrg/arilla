"""Saglayicidan bagimsiz metin embedding sozlesmesi (karar 0180).

Ayni sozlesmeye iki tur uygulama baglanir:

- **Uzak API** (`JinaEmbeddingClient`, `enrich/client.py`): HTTP, zaman asimi, sinirli tekrar,
  429/`Retry-After`, dakikalik token butcesi. Gelecekteki uzak GPU servisi de ayni yerden baglanir.
- **Yerel CPU** (`LocalOnnxTextProvider`): karar 0155'in dogrulanmis ONNX gommesini
  (`classify.suggest.model.OnnxEmbedder`) sarar; yeni calisma zamani bagimliligi yoktur.

Her iki yol da `validate_batch` kapisindan gecer: sonuc sayisi, boyut, sonlu deger ve birim norm.
Kapiyi gecemeyen parti `EmbeddingInvalid` ile reddedilir ve HICBIR vektor yazilmaz; bozuk ya da
yanlis boyutlu bir vektorun sessizce yazilip yanlis eslesme uretmesindense kosunun durmasi iyidir.
"""

from __future__ import annotations

import math
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from enrich.client import EmbeddingBatch, EmbeddingError, JinaEmbeddingClient
from enrich.ratelimit import TokenBudget
from enrich.registry import ModelSpec, RegistryError

#: `provider_l2`: saglayici normalize ettigini taahhut ediyor; yarim duyarlik ve yuvarlama payi.
NORM_TOLERANCE = 1e-2
#: Yerel saglayicida tek partinin ust siniri (bellek tepe noktasi bununla sinirlanir).
LOCAL_MAX_BATCH = 256


class EmbeddingInvalid(EmbeddingError):
    """Saglayici bicimce gecerli ama icerikce kullanilamaz vektor dondu (boyut, NaN, sifir norm).

    Gecici degildir; ayni parti tekrar gonderilse de ayni sonuc beklenir. Cagiran partiyi yazmaz.
    """


class TextEmbeddingProvider(Protocol):
    """Metin -> vektor. Amac (passage/query) olusturulurken secilir, cagri basina degil."""

    @property
    def model_version(self) -> str: ...

    @property
    def text_batch_size(self) -> int: ...

    def embed_texts(self, texts: Sequence[str]) -> EmbeddingBatch: ...


def validate_batch(
    batch: EmbeddingBatch, *, expected: int, dimensions: int, normalization: str
) -> EmbeddingBatch:
    """Vektorleri dogrular; `l2` icin normalize eder. Gecersizse `EmbeddingInvalid`."""
    if len(batch.vectors) != expected:
        raise EmbeddingInvalid(f"{expected} girdi icin {len(batch.vectors)} vektor geldi")
    vectors: list[list[float]] = []
    for position, vector in enumerate(batch.vectors):
        if len(vector) != dimensions:
            raise EmbeddingInvalid(
                f"vektor {position}: boyut {dimensions} bekleniyordu, {len(vector)} geldi"
            )
        if not all(math.isfinite(value) for value in vector):
            raise EmbeddingInvalid(f"vektor {position}: sonlu olmayan deger")
        norm = math.sqrt(sum(value * value for value in vector))
        if norm < 1e-6:
            raise EmbeddingInvalid(f"vektor {position}: sifir norm")
        if normalization == "l2":
            vectors.append([value / norm for value in vector])
        elif abs(norm - 1.0) > NORM_TOLERANCE:
            raise EmbeddingInvalid(f"vektor {position}: normalize degil (norm {norm:.4f})")
        else:
            vectors.append(list(vector))
    return EmbeddingBatch(
        vectors=vectors, model_version=batch.model_version, total_tokens=batch.total_tokens
    )


def validate_for(spec: ModelSpec, batch: EmbeddingBatch, expected: int) -> EmbeddingBatch:
    return validate_batch(
        batch, expected=expected, dimensions=spec.dimensions, normalization=spec.normalization
    )


@dataclass
class LocalOnnxTextProvider:
    """Yerel CPU modeli. `embedder`, `classify.suggest.model.Embedder` sozlesmesini uygular.

    Kaynak sinirlari: ONNX ic parcacik sayisi `threads` ile (embedder kurulurken), parti boyu
    `batch_size` ile (en fazla `LOCAL_MAX_BATCH`). ONNX cagrisi kesilemez; zaman asimi yerine
    parti boyu sinirlanir ve her parti suresi olculur.
    """

    spec: ModelSpec
    embedder: Any
    purpose: str = "passage"
    batch_size: int = 64
    #: Gozlem: parti basina sure (ms). Rapor p50/p95'i buradan hesaplar.
    latencies_ms: list[float] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.spec.provider != "local_onnx":
            raise RegistryError(f"{self.spec.id}: yerel ONNX saglayicisi degil")
        embedder_version = getattr(self.embedder, "model_version", None)
        if embedder_version != self.spec.id:
            # Model dosyasi kayit defterindeki kimlikle ayni degilse vektor uzayi da ayni degildir.
            raise RegistryError(
                f"model dizini {embedder_version!r}, kayit defteri {self.spec.id!r} bekliyor"
            )
        self.batch_size = max(1, min(self.batch_size, LOCAL_MAX_BATCH))
        prefix = self.spec.prefix(self.purpose)
        if prefix and hasattr(self.embedder, "with_prefix"):
            self.embedder = self.embedder.with_prefix(prefix)

    @property
    def model_version(self) -> str:
        return self.spec.id

    @property
    def text_batch_size(self) -> int:
        return self.batch_size

    def embed_texts(self, texts: Sequence[str]) -> EmbeddingBatch:
        if not texts:
            return EmbeddingBatch(vectors=[], model_version=self.spec.id, total_tokens=0)
        started = time.perf_counter()
        try:
            raw = self.embedder.encode(list(texts))
        except Exception as error:  # noqa: BLE001 - ONNX/tokenizer hatasi tek turde raporlanir
            raise EmbeddingError(f"yerel model hatasi: {type(error).__name__}") from error
        self.latencies_ms.append((time.perf_counter() - started) * 1000)
        vectors = [[float(v) for v in row] for row in raw]
        tokens = sum(max(1, math.ceil(len(t) / self.spec.chars_per_token)) for t in texts)
        batch = EmbeddingBatch(vectors=vectors, model_version=self.spec.id, total_tokens=tokens)
        return validate_for(self.spec, batch, len(texts))


def build_text_provider(
    spec: ModelSpec,
    *,
    purpose: str = "passage",
    budget: TokenBudget | None = None,
    batch_size: int | None = None,
    model_dir: Path | None = None,
    threads: int = 2,
) -> TextEmbeddingProvider:
    """Kayit defteri girdisinden saglayici kurar. Bilinmeyen saglayici -> `RegistryError`."""
    if "text" not in spec.modalities:
        raise RegistryError(f"{spec.id}: metin kipi yok")
    if spec.provider == "jina":
        client = JinaEmbeddingClient(
            model=spec.id, task=spec.task(purpose), dimensions=spec.dimensions, budget=budget
        )
        if batch_size is not None:
            client.text_batch = batch_size
        return client
    if spec.provider == "local_onnx":
        if model_dir is None:
            raise RegistryError(f"{spec.id}: --model-dir gerekli")
        from classify.suggest.model import OnnxEmbedder  # tembel: onnxruntime yalniz burada

        embedder = OnnxEmbedder(model_dir, threads=threads, batch_size=batch_size or 64)
        return LocalOnnxTextProvider(
            spec=spec, embedder=embedder, purpose=purpose, batch_size=batch_size or 64
        )
    raise RegistryError(f"{spec.id}: desteklenmeyen saglayici {spec.provider!r}")
