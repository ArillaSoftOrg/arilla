"""Saglayicidan bagimsiz embedding sozlesmesi (karar 0180, 0182).

Ayni metin sozlesmesine (`TextEmbeddingProvider`) uc tur uygulama baglanir:

- **Ticari API** (`JinaEmbeddingClient`, `enrich/client.py`): HTTP, zaman asimi, sinirli tekrar,
  429/`Retry-After`, dakikalik token butcesi.
- **Yerel CPU** (`LocalOnnxTextProvider`): karar 0155'in dogrulanmis ONNX gommesini
  (`classify.suggest.model.OnnxEmbedder`) sarar; yeni calisma zamani bagimliligi yoktur.
- **Kendi cikarim servisimiz** (`RemoteHttpTextProvider`, karar 0182): ayni KVM 8'de ayri
  konteyner, ileride Processing VPS ya da GPU sunucusu. OpenAI uyumlu `/v1/embeddings`
  (TEI, Infinity, vLLM bunu sunar). Model dosyasi ve calisma zamani YALNIZ o servistedir;
  ingest ve web imajina model/torch bagimliligi eklenmez. Sunucu baska model bildirirse parti
  reddedilir (vektor uzayi karismaz).

Gorsel kip ayri sozlesmedir (`ImageEmbeddingProvider`); bugun yalniz Jina CLIP uygular.

Her iki yol da `validate_batch` kapisindan gecer: sonuc sayisi, boyut, sonlu deger ve birim norm.
Kapiyi gecemeyen parti `EmbeddingInvalid` ile reddedilir ve HICBIR vektor yazilmaz; bozuk ya da
yanlis boyutlu bir vektorun sessizce yazilip yanlis eslesme uretmesindense kosunun durmasi iyidir.
"""

from __future__ import annotations

import ipaddress
import math
import os
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlsplit

import httpx

from enrich.client import (
    EmbeddingBatch,
    EmbeddingError,
    EmbeddingRejected,
    JinaEmbeddingClient,
    backoff_seconds,
    retry_after_seconds,
)
from enrich.ratelimit import TokenBudget
from enrich.registry import ModelSpec, RegistryError

#: `provider_l2`: saglayici normalize ettigini taahhut ediyor; yarim duyarlik ve yuvarlama payi.
NORM_TOLERANCE = 1e-2
#: Yerel saglayicida tek partinin ust siniri (bellek tepe noktasi bununla sinirlanir).
LOCAL_MAX_BATCH = 256
#: Uzak cikarim servisi: parti ust siniri, deneme sayisi ve zaman asimlari.
REMOTE_MAX_BATCH = 128
REMOTE_MAX_ATTEMPTS = 4
REMOTE_CONNECT_TIMEOUT_S = 5.0
REMOTE_READ_TIMEOUT_S = 60.0
#: Denemeler arasi bekleme ust siniri (Retry-After dahil).
REMOTE_WAIT_CAP_S = 30.0


class EmbeddingInvalid(EmbeddingError):
    """Saglayici bicimce gecerli ama icerikce kullanilamaz vektor dondu (boyut, NaN, sifir norm).

    Gecici degildir; ayni parti tekrar gonderilse de ayni sonuc beklenir. Cagiran partiyi yazmaz.
    """


class ImageEmbeddingProvider(Protocol):
    """Gorsel -> vektor. Girdi, on islenmis (karar 0015: 512 px, EXIF'siz) `data:` URL'sidir."""

    @property
    def model_version(self) -> str: ...

    @property
    def image_batch_size(self) -> int: ...

    def embed_images(
        self, data_urls: Sequence[str], *, estimated_tokens: int | None = None
    ) -> EmbeddingBatch: ...


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
        embedder_pooling = getattr(self.embedder, "pooling", None)
        if embedder_pooling != self.spec.pooling:
            # Karar 0186: yanlis havuzlama boyut/norm kapisindan gecer; bu yuzden gommecinin
            # GERCEKTEN kullandigi yontem kayit defteriyle ayni olmak zorunda.
            raise RegistryError(
                f"{self.spec.id}: gommeci havuzlamasi {embedder_pooling!r}, "
                f"kayit defteri {self.spec.pooling!r} bekliyor"
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


def validate_endpoint(url: str) -> str:
    """Uzak cikarim adresi. Duz HTTP yalniz yerel/ozel agda (ayni makine, Docker agi, VPN).

    Kimlik bilgisi URL'de olamaz (gunluklere sizar); sorgu/parca da kabul edilmez.
    """
    parts = urlsplit(url.strip())
    if parts.scheme not in {"http", "https"} or not parts.hostname:
        raise RegistryError("uzak embedding adresi http(s)://host[:port][/yol] olmali")
    if parts.username or parts.password or parts.query or parts.fragment:
        raise RegistryError("uzak embedding adresinde kimlik bilgisi, sorgu ya da parca olamaz")
    if parts.scheme == "http" and not _private_host(parts.hostname):
        raise RegistryError("duz HTTP yalniz yerel/ozel agdaki cikarim servisine izinli")
    return url.strip().rstrip("/")


def _private_host(host: str) -> bool:
    if host == "localhost" or "." not in host and ":" not in host:
        return True  # tek etiketli ad: Docker servis adi (ornek `embed-cpu`)
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    return address.is_private or address.is_loopback


@dataclass
class RemoteHttpTextProvider:
    """Kendi isletilen cikarim servisi (CPU konteyneri, Processing VPS ya da GPU), karar 0182.

    - Sozlesme: `POST {base}/v1/embeddings` `{"model", "input"}` -> `{"data":[{"index",
      "embedding"}], "model", "usage"}` (OpenAI uyumlu).
    - Eszamanlilik: ornek basina tek istek (senkron). Toplam eszamanlilik = isci sayisi; canli
      sorgu ve toplu is AYRI orneklerle (ayri havuz) calisir.
    - Tekrar: 429/5xx/ag hatasi sinirli ustel bekleme ile; diger 4xx kalici (`EmbeddingRejected`).
    - Model kimligi: yanit `model` alani `served_model` ile ayni degilse parti reddedilir.
    """

    spec: ModelSpec
    base_url: str
    purpose: str = "passage"
    batch_size: int = 32
    token: str | None = None
    client: httpx.Client | None = None
    max_attempts: int = REMOTE_MAX_ATTEMPTS
    sleep: Any = time.sleep
    latencies_ms: list[float] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.spec.provider != "remote_http" or not self.spec.endpoint:
            raise RegistryError(f"{self.spec.id}: remote_http saglayicisi degil")
        self.base_url = validate_endpoint(self.base_url)
        self.batch_size = max(1, min(self.batch_size, REMOTE_MAX_BATCH))
        self.max_attempts = max(1, self.max_attempts)
        self._prefix = self.spec.prefix(self.purpose)

    @property
    def model_version(self) -> str:
        return self.spec.id

    @property
    def text_batch_size(self) -> int:
        return self.batch_size

    @property
    def served_model(self) -> str:
        assert self.spec.endpoint is not None
        return self.spec.endpoint["served_model"]

    def _client(self) -> httpx.Client:
        if self.client is None:
            self.client = httpx.Client(
                timeout=httpx.Timeout(REMOTE_READ_TIMEOUT_S, connect=REMOTE_CONNECT_TIMEOUT_S)
            )
        return self.client

    def embed_texts(self, texts: Sequence[str]) -> EmbeddingBatch:
        if not texts:
            return EmbeddingBatch(vectors=[], model_version=self.spec.id, total_tokens=0)
        if len(texts) > self.batch_size:
            raise EmbeddingError(f"parti {len(texts)} > sinir {self.batch_size}")
        inputs = [self._prefix + t for t in texts]
        # Karar 0186: girdi siniri istemcide. Sunucu (TEI) yalniz model sinirini asani kirpar;
        # kayit defteri sinirini asan girdi sessizce kirpilmaz, parti reddedilir (cagiran
        # metni `text_prep` ile parcalar). Tahmin `chars_per_token` ile, onek dahil.
        limit_chars = int(self.spec.max_input_tokens * self.spec.chars_per_token)
        too_long = [i for i, text in enumerate(inputs) if len(text) > limit_chars]
        if too_long:
            raise EmbeddingInvalid(
                f"{len(too_long)} girdi ~{self.spec.max_input_tokens} token sinirini asiyor "
                f"(> {limit_chars} karakter); kirpilmadi"
            )
        body = {"model": self.served_model, "input": inputs}
        headers = {"Authorization": f"Bearer {self.token}"} if self.token else {}
        started = time.perf_counter()
        payload = self._post_with_retry(body, headers)
        self.latencies_ms.append((time.perf_counter() - started) * 1000)
        batch = self._parse(payload, texts)
        return validate_for(self.spec, batch, len(texts))

    def _post_with_retry(self, body: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
        url = f"{self.base_url}/v1/embeddings"
        last = "bilinmeyen"
        for attempt in range(self.max_attempts):
            try:
                response = self._client().post(url, json=body, headers=headers)
            except httpx.HTTPError as error:  # baglanti, zaman asimi, protokol
                last = type(error).__name__
                wait = backoff_seconds(attempt)
            else:
                status = response.status_code
                if status == 200:
                    try:
                        data = response.json()
                    except ValueError as error:
                        raise EmbeddingInvalid("yanit JSON degil") from error
                    if not isinstance(data, dict):
                        raise EmbeddingInvalid("yanit nesne degil")
                    return data
                last = f"HTTP {status}"
                if status != 429 and status < 500:
                    # Kalici: yanit govdesi gunluge YAZILMAZ (girdi metni yansiyabilir).
                    raise EmbeddingRejected(f"uzak embedding istegi reddedildi ({last})")
                hinted = retry_after_seconds(response.headers.get("retry-after"))
                wait = hinted if hinted is not None else backoff_seconds(attempt)
            if attempt + 1 < self.max_attempts:
                self.sleep(min(REMOTE_WAIT_CAP_S, wait))
        raise EmbeddingError(f"uzak embedding {self.max_attempts} denemede basarisiz ({last})")

    def _parse(self, payload: dict[str, Any], texts: Sequence[str]) -> EmbeddingBatch:
        served = payload.get("model")
        if served is not None and served != self.served_model:
            raise EmbeddingInvalid(
                f"sunucu {served!r} modelini bildirdi, {self.served_model!r} bekleniyordu"
            )
        data = payload.get("data")
        if not isinstance(data, list):
            raise EmbeddingInvalid("yanitta data listesi yok")
        try:
            ordered = sorted(data, key=lambda item: int(item["index"]))
            indexes = [int(item["index"]) for item in ordered]
            vectors = [[float(v) for v in item["embedding"]] for item in ordered]
        except (KeyError, TypeError, ValueError) as error:
            raise EmbeddingInvalid("yanit ogeleri index/embedding icermiyor") from error
        if indexes != list(range(len(ordered))):
            raise EmbeddingInvalid("yanit index dizisi eksik ya da tekrarli")
        usage = payload.get("usage")
        tokens = usage.get("total_tokens") if isinstance(usage, dict) else None
        if not isinstance(tokens, int) or isinstance(tokens, bool) or tokens < 0:
            tokens = sum(max(1, math.ceil(len(t) / self.spec.chars_per_token)) for t in texts)
        return EmbeddingBatch(vectors=vectors, model_version=self.spec.id, total_tokens=tokens)


def build_image_provider(
    spec: ModelSpec, *, budget: TokenBudget | None = None, batch_size: int | None = None
) -> ImageEmbeddingProvider:
    """Gorsel saglayici. Kip kayitta yoksa ya da saglayici gorsel gomemiyorsa `RegistryError`."""
    if "image" not in spec.capabilities:
        raise RegistryError(f"{spec.id}: gorsel kipi yok")
    if spec.provider == "jina":
        client = JinaEmbeddingClient(model=spec.id, dimensions=spec.dimensions, budget=budget)
        if batch_size is not None:
            client.image_batch = batch_size
        return client
    raise RegistryError(f"{spec.id}: gorsel icin desteklenmeyen saglayici {spec.provider!r}")


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
    if "text" not in spec.capabilities:
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

        assert spec.pooling is not None  # kayit defteri yukleyicisi zorunlu kilar (karar 0186)
        embedder = OnnxEmbedder(
            model_dir, threads=threads, batch_size=batch_size or 64, pooling=spec.pooling
        )
        return LocalOnnxTextProvider(
            spec=spec, embedder=embedder, purpose=purpose, batch_size=batch_size or 64
        )
    if spec.provider == "remote_http":
        assert spec.endpoint is not None  # kayit defteri yukleyicisi zorunlu kilar
        url_env = spec.endpoint["url_env"]
        base_url = os.environ.get(url_env, "").strip()
        if not base_url:
            raise RegistryError(f"{spec.id}: {url_env} tanimli degil")
        token = os.environ.get(url_env.removesuffix("_URL") + "_TOKEN") or None
        return RemoteHttpTextProvider(
            spec=spec, base_url=base_url, purpose=purpose, batch_size=batch_size or 32, token=token
        )
    raise RegistryError(f"{spec.id}: desteklenmeyen saglayici {spec.provider!r}")
