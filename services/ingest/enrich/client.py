"""Embedding istemcisi — Jina CLIP v2 (barindirilan cok-kipli API).

Saglayici karari: `docs/decisions/0015-embedding-saglayici.md`. Kendi
modelimizi barindirmiyoruz; metin ve gorsel AYNI vektor uzayina duser ve
cikti 768 boyuta kirpilir.

Istemci **enjekte edilebilir**: B1 ve B2'deki desenin aynisi. Testler ve
fixture gosterimi `FakeEmbeddingClient` ile kosar, hicbir test aga cikmaz.

Hiz: istek gondermeden ONCE `TokenBudget` beklenir (dakikalik token
butcesi); 429 artik normal akis degil, istisnadir. 429'da `Retry-After`
dinlenir, deneme sayisi sinirlidir. Bkz. karar 0028.
"""

from __future__ import annotations

import hashlib
import logging
import math
import os
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from email.utils import parsedate_to_datetime
from typing import Any, Protocol

import httpx

from enrich.ratelimit import TokenBudget

logger = logging.getLogger(__name__)

API_URL = "https://api.jina.ai/v1/embeddings"
MODEL = "jina-clip-v2"

#: Sema `vector(768)` taahhut ediyor; jina-clip-v2 icin gecerli aralik 64-1024.
DIMENSIONS = 768

#: Tek istekte gonderilen girdi sayisi. On isleme sonrasi bir gorsel ~4.000
#: token ve ~50 KB base64; 8'lik parti ~32.000 token, butcenin yarisindan az.
IMAGE_BATCH = 8
TEXT_BATCH = 64

#: Toplam deneme sayisi (ilk istek dahil). Sonsuz deneme yok: basarisiz
#: parti `EmbeddingError` ile doner, boru hatti o offer'lari embedding'siz
#: birakir ve bir sonraki kosu kaldigi yerden devam eder.
MAX_ATTEMPTS = 5
BACKOFF_BASE = 2.0
BACKOFF_CAP = 60.0
#: Saglayici absurt bir Retry-After donerse bile bundan uzun beklenmez.
RETRY_AFTER_CAP = 120.0

#: Tahmin verilmezse gorsel basina varsayim (uzun kenar <= 512 -> tek karo).
DEFAULT_IMAGE_TOKENS = 4000
#: Metin icin kaba token tahmini (karakter / 3); gercek sayi yanittan gelir.
TEXT_CHARS_PER_TOKEN = 3


class EmbeddingError(RuntimeError):
    """Saglayici cagrisi basarisiz. Boru hatti partiyi atlar, kosu devam eder."""


@dataclass(frozen=True)
class EmbeddingBatch:
    """Bir API cagrisinin sonucu."""

    vectors: list[list[float]]
    model_version: str
    #: `api_usage.units` icin; saglayicinin dondugu token sayisi.
    total_tokens: int


class EmbeddingClient(Protocol):
    def embed_images(
        self, data_urls: Sequence[str], *, estimated_tokens: int | None = None
    ) -> EmbeddingBatch: ...
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


def retry_after_seconds(value: str | None, now: float | None = None) -> float | None:
    """`Retry-After` basligi: saniye ya da HTTP tarihi. Anlasilmazsa None."""
    if not value:
        return None
    value = value.strip()
    try:
        return max(0.0, float(value))
    except ValueError:
        pass
    try:
        when = parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError):
        return None
    current = time.time() if now is None else now
    return max(0.0, when.timestamp() - current)


def backoff_seconds(attempt: int) -> float:
    """0 tabanli deneme icin ustel bekleme: 2, 4, 8, ... en fazla BACKOFF_CAP."""
    return min(BACKOFF_CAP, BACKOFF_BASE * (2**attempt))


@dataclass
class JinaEmbeddingClient(EmbeddingClient):
    client: httpx.Client | None = None
    dimensions: int = DIMENSIONS
    model: str = MODEL
    #: None -> butce yok (birim testleri). CLI her zaman bir butce verir.
    budget: TokenBudget | None = None
    sleep: Callable[[float], None] = time.sleep
    max_attempts: int = MAX_ATTEMPTS
    image_batch: int = IMAGE_BATCH
    #: Gozlem sayaclari — kosu raporu buradan okur.
    rate_limited: int = 0
    retries: int = 0

    @property
    def model_version(self) -> str:
        return self.model

    @property
    def image_batch_size(self) -> int:
        return self.image_batch

    @property
    def text_batch_size(self) -> int:
        return TEXT_BATCH

    def _client(self) -> httpx.Client:
        if self.client is None:
            self.client = httpx.Client(timeout=120.0)
        return self.client

    def embed_images(
        self, data_urls: Sequence[str], *, estimated_tokens: int | None = None
    ) -> EmbeddingBatch:
        estimate = (
            estimated_tokens
            if estimated_tokens is not None
            else DEFAULT_IMAGE_TOKENS * len(data_urls)
        )
        return self._post([{"image": url} for url in data_urls], estimate)

    def embed_texts(self, texts: Sequence[str]) -> EmbeddingBatch:
        estimate = sum(max(1, len(text) // TEXT_CHARS_PER_TOKEN) for text in texts)
        return self._post([{"text": text} for text in texts], estimate)

    def _post(self, inputs: list[dict[str, str]], estimate: int) -> EmbeddingBatch:
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

        payload, entry = self._post_with_retry(body, headers, estimate)
        batch = self._parse(payload, len(inputs))
        if self.budget is not None and entry is not None:
            # Pencerede tahmin degil, saglayicinin saydigi gercek token kalsin.
            self.budget.settle(entry, batch.total_tokens or estimate)
        return batch

    def _pause(self, seconds: float) -> None:
        if self.budget is not None:
            self.budget.pause(seconds)
        else:
            self.sleep(seconds)

    def _post_with_retry(
        self, body: dict[str, Any], headers: dict[str, str], estimate: int
    ) -> tuple[dict[str, Any], Any]:
        client = self._client()
        last = "bilinmiyor"
        for attempt in range(self.max_attempts):
            entry = self.budget.acquire(estimate) if self.budget is not None else None
            wait: float | None = None
            try:
                response = client.post(API_URL, json=body, headers=headers)
            except httpx.TransportError as error:
                last = f"baglanti hatasi ({type(error).__name__})"
            else:
                if response.status_code < 400:
                    return response.json(), entry
                if response.status_code == 429:
                    self.rate_limited += 1
                    last = "429"
                    hinted = retry_after_seconds(response.headers.get("retry-after"))
                    if hinted is not None:
                        wait = min(RETRY_AFTER_CAP, hinted)
                elif response.status_code >= 500:
                    last = str(response.status_code)
                else:
                    # 429 disindaki 4xx kalicidir: tekrar denemek ayni hatayi alir.
                    raise EmbeddingError(f"saglayici {response.status_code}: {response.text[:200]}")

            if attempt == self.max_attempts - 1:
                break
            if wait is None:
                wait = backoff_seconds(attempt)
            self.retries += 1
            logger.warning(
                "saglayici %s, %.1f sn sonra tekrar (deneme %s/%s)",
                last,
                wait,
                attempt + 2,
                self.max_attempts,
            )
            # Basarisiz denemenin tahmini pencerede kalir: saglayici o token'i
            # saymis olabilir, ihtiyatli taraf bu.
            self._pause(wait)

        raise EmbeddingError(f"saglayici {last} dondu, {self.max_attempts} denemede gecmedi")

    def _parse(self, payload: dict[str, Any], expected: int) -> EmbeddingBatch:
        # Yanit bicimi OpenAI uyumlu; ilk gercek kosularda (2026-09) teyit edildi.
        # Beklenmeyen bicimde acikca patlamasi, sessizce yanlis vektor
        # yazmasindan iyidir.
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

    def embed_images(
        self, data_urls: Sequence[str], *, estimated_tokens: int | None = None
    ) -> EmbeddingBatch:
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
