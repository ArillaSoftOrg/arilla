"""Embedding istemcisi — Jina CLIP v2 (barindirilan cok-kipli API).

Saglayici karari: `docs/decisions/0015-embedding-saglayici.md`. Kendi
modelimizi barindirmiyoruz; metin ve gorsel AYNI vektor uzayina duser ve
cikti 768 boyuta kirpilir.

Istemci **enjekte edilebilir**: B1 ve B2'deki desenin aynisi. Testler ve
fixture gosterimi `FakeEmbeddingClient` ile kosar, hicbir test aga cikmaz.
Gercek API yolu yazili ama bu asamada calistirilmadi — hesap henuz yok.
"""

from __future__ import annotations

import hashlib
import logging
import math
import os
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx

logger = logging.getLogger(__name__)

API_URL = "https://api.jina.ai/v1/embeddings"
MODEL = "jina-clip-v2"

#: Sema `vector(768)` taahhut ediyor; jina-clip-v2 icin gecerli aralik 64-1024.
DIMENSIONS = 768

#: Tek istekte gonderilen girdi sayisi. Gorseller base64 oldugu icin govde
#: hizla buyur; kucuk tutuyoruz.
IMAGE_BATCH = 8
TEXT_BATCH = 64

MAX_RETRIES = 4


class EmbeddingError(RuntimeError):
    """Saglayici cagrisi basarisiz. Kosuyu durdurur."""


@dataclass(frozen=True)
class EmbeddingBatch:
    """Bir API cagrisinin sonucu."""

    vectors: list[list[float]]
    model_version: str
    #: `api_usage.units` icin; saglayicinin dondugu token sayisi.
    total_tokens: int


class EmbeddingClient(Protocol):
    def embed_images(self, data_urls: Sequence[str]) -> EmbeddingBatch: ...
    def embed_texts(self, texts: Sequence[str]) -> EmbeddingBatch: ...

    @property
    def model_version(self) -> str: ...

    @property
    def image_batch_size(self) -> int: ...

    @property
    def text_batch_size(self) -> int: ...


def api_key() -> str:
    key = os.environ.get("JINA_API_KEY")
    if not key:
        raise EmbeddingError(
            "JINA_API_KEY tanimli degil. Anahtar depoda tutulmaz; .env.example'a bakin."
        )
    return key


@dataclass
class JinaEmbeddingClient(EmbeddingClient):
    client: httpx.Client | None = None
    dimensions: int = DIMENSIONS
    model: str = MODEL

    @property
    def model_version(self) -> str:
        return self.model

    @property
    def image_batch_size(self) -> int:
        return IMAGE_BATCH

    @property
    def text_batch_size(self) -> int:
        return TEXT_BATCH

    def _client(self) -> httpx.Client:
        return self.client or httpx.Client(timeout=120.0)

    def embed_images(self, data_urls: Sequence[str]) -> EmbeddingBatch:
        return self._post([{"image": url} for url in data_urls])

    def embed_texts(self, texts: Sequence[str]) -> EmbeddingBatch:
        return self._post([{"text": text} for text in texts])

    def _post(self, inputs: list[dict[str, str]]) -> EmbeddingBatch:
        if not inputs:
            return EmbeddingBatch(vectors=[], model_version=self.model, total_tokens=0)

        body = {
            "model": self.model,
            "dimensions": self.dimensions,
            # Kosinus mesafesi normalize vektorlerde dogru calisir;
            # `embedding_ann_idx` HNSW indeksi vector_cosine_ops kullaniyor.
            "normalized": True,
            "embedding_type": "float",
            "input": inputs,
        }
        headers = {
            "Authorization": f"Bearer {api_key()}",
            "Content-Type": "application/json",
        }

        payload = self._post_with_retry(body, headers)
        return self._parse(payload, len(inputs))

    def _post_with_retry(self, body: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
        client = self._client()
        for attempt in range(MAX_RETRIES):
            response = client.post(API_URL, json=body, headers=headers)
            if response.status_code == 429 or response.status_code >= 500:
                if attempt == MAX_RETRIES - 1:
                    raise EmbeddingError(
                        f"saglayici {response.status_code} dondu, {MAX_RETRIES} denemede gecmedi"
                    )
                # Ustel geri cekilme. Oran siniri saglayicinin isi, biz uyariz.
                wait = 2**attempt
                logger.warning("saglayici %s dondu, %s sn sonra tekrar", response.status_code, wait)
                time.sleep(wait)
                continue
            if response.status_code >= 400:
                raise EmbeddingError(f"saglayici {response.status_code}: {response.text[:200]}")
            return response.json()
        raise EmbeddingError("beklenmeyen durum: yeniden deneme dongusu bitti")

    def _parse(self, payload: dict[str, Any], expected: int) -> EmbeddingBatch:
        # Yanit bicimi OpenAI uyumlu olarak belgeleniyor ama anahtar olmadigi
        # icin gercek bir yanitla DOGRULANMADI. Ilk gercek kosuda teyit edilecek;
        # burada acikca patlamasi, sessizce yanlis vektor yazmasindan iyidir.
        rows = payload.get("data")
        if not isinstance(rows, list) or len(rows) != expected:
            raise EmbeddingError(
                f"yanit beklenen bicimde degil: {expected} girdi gonderildi, "
                f"{len(rows) if isinstance(rows, list) else 'liste degil'} sonuc geldi"
            )

        vectors: list[list[float]] = []
        for row in sorted(rows, key=lambda item: item.get("index", 0)):
            vector = row.get("embedding")
            if not isinstance(vector, list) or len(vector) != self.dimensions:
                raise EmbeddingError(
                    f"vektor boyutu {self.dimensions} bekleniyordu, "
                    f"{len(vector) if isinstance(vector, list) else 'yok'} geldi"
                )
            vectors.append([float(value) for value in vector])

        usage = payload.get("usage") or {}
        tokens = int(usage.get("total_tokens") or 0)
        return EmbeddingBatch(vectors=vectors, model_version=self.model, total_tokens=tokens)


@dataclass
class FakeEmbeddingClient(EmbeddingClient):
    """Deterministik sahte istemci — testler ve fixture gosterimi icin.

    Ayni girdi her zaman ayni vektoru verir, farkli girdiler farkli. Gercek
    anlamsal yakinlik TASIMAZ; yalnizca boru hattinin dogrulugunu sinar
    (yineleme onleme, idempotentlik, satir sayilari).
    """

    dimensions: int = DIMENSIONS
    model: str = f"{MODEL}-fake"
    #: Kac cagri yapildi — testlerin "ayni gorsel iki kez islenmiyor"
    #: iddiasini olctugu sayac.
    calls: int = 0
    inputs_seen: list[str] = field(default_factory=list)

    @property
    def model_version(self) -> str:
        return self.model

    @property
    def image_batch_size(self) -> int:
        return IMAGE_BATCH

    @property
    def text_batch_size(self) -> int:
        return TEXT_BATCH

    def embed_images(self, data_urls: Sequence[str]) -> EmbeddingBatch:
        return self._embed(data_urls)

    def embed_texts(self, texts: Sequence[str]) -> EmbeddingBatch:
        return self._embed(texts)

    def _embed(self, items: Sequence[str]) -> EmbeddingBatch:
        if not items:
            return EmbeddingBatch(vectors=[], model_version=self.model, total_tokens=0)
        self.calls += 1
        self.inputs_seen.extend(items)
        vectors = [self._vector(item) for item in items]
        # Kaba bir token tahmini; gercek fiyat zaten bilinmiyor.
        tokens = sum(max(1, len(item) // 4) for item in items)
        return EmbeddingBatch(vectors=vectors, model_version=self.model, total_tokens=tokens)

    def _vector(self, item: str) -> list[float]:
        seed = hashlib.sha256(item.encode("utf-8")).digest()
        raw = [(seed[index % len(seed)] / 255.0) - 0.5 for index in range(self.dimensions)]
        norm = math.sqrt(sum(value * value for value in raw)) or 1.0
        # Gercek istemci normalized=True donuyor; sahte olan da donsun ki
        # kosinus mesafesi ayni sekilde davransin.
        return [value / norm for value in raw]
