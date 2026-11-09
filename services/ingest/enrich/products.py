"""Urun duzeyinde metin embedding'i (karar 0177): artimli, idempotent, butceli.

    python -m enrich.products                                   # KURU CALISMA: API yok, yazim yok
    python -m enrich.products --execute --max-tokens 1000000    # gercek kosu (token tavani zorunlu)
    python -m enrich.products --ids-file pilot.txt --execute --max-tokens 1000000

Hedef tablo `product_text_embedding` (migration 0105): urun basina model basina tek `halfvec(768)`.
Model jina-embeddings-v3, gorev `retrieval.passage`; sorgu tarafi ayni modelle `retrieval.query`.

Algoritma (her pencere icin; pencere = urun kimligi araligi ya da `--ids-file` dilimi):

1. **Degisen urunu SQL bulur.** Kaynak ozeti `md5(baslik, U+001F, marka)` sorguda hesaplanir ve
   saklanan `source_hash` ile karsilastirilir; yalnizca vektoru olmayan, metni degismis ya da eski
   `text_version`'li yayindaki urunler Python'a gelir. Degismeyen urun okunmaz, yazilmaz.
   Pencere birincil anahtar araligidir: her sorgunun maliyeti sinirlidir, bos aralik ucuzdur.
2. **Kanonik metin + icerik ozeti** (`enrich/product_text.py`). Kaynak degisti ama kanonik metin
   ayni kaldiysa (bosluk, gurultu eki, baslikta zaten gecen marka) yalnizca `source_hash`
   guncellenir: API yok, vektor yazimi yok.
3. **API'siz kopya.** Ayni `content_hash` baska urunde varsa vektor sunucu tarafinda kopyalanir
   (`(model_version, content_hash)` indeksi). Ayni penceredeki yinelenen metin tek kez gonderilir.
4. **Kalan benzersiz metinler** partiler halinde API'ye gider: dakikalik token butcesi
   (`JINA_TOKENS_PER_MINUTE`) ve kosu tavani (`--max-tokens`) asilmaz. 4xx (tek bozuk girdi)
   partiyi ikiye bolerek ayiklanir; gecici hata sinirli sayida tekrar denenir, ardisik hata
   esiginde kosu durur. Her basarili cagri hemen `api_usage`'a yazilir (kural 9).
5. **Yazim** WAL geri basincina (karar 0134) uyar; her parti kendi isleminde commit edilir.

Durum veritabanindadir: yarim kalan kosu tekrar calistirildiginda kaldigi yerden devam eder
(yazilmis urun ikinci kez islenmez). Ayni anda tek kosu: oturum duzeyi danisma kilidi.

Sinirlar: embedding benzerligi urun kimligi KANITI degildir; bu modul eslestirmeye (resolve)
ve `similarity_edge`'e yazmaz. Zamanlayici yoktur (P1 pilotu elle, onayla calisir).
"""

from __future__ import annotations

import argparse
import logging
import math
import os
import signal
import sys
import time
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from types import FrameType
from typing import Any
from urllib.parse import urlparse

import psycopg

from db import job_run, usage, wal_pressure
from db.connection import connect, env
from enrich.client import (
    EmbeddingBatch,
    EmbeddingClient,
    EmbeddingError,
    EmbeddingRejected,
    FakeEmbeddingClient,
    JinaEmbeddingClient,
)
from enrich.product_text import TEXT_VERSION, build_product_text, content_hash
from enrich.providers import build_text_provider, validate_for
from enrich.ratelimit import TokenBudget, tokens_per_minute_from_env
from enrich.registry import ModelSpec, RegistryError, registry, require_writable, select_model

logger = logging.getLogger(__name__)

#: Hedef tablonun indeks ailesi (karar 0180). Yalnizca bu aileye ait modeller buraya yazar.
INDEX_FAMILY = "product_text_halfvec768"
#: Varsayilan model ve degerleri kayit defterinden gelir (`enrich/model_registry.json`).
DEFAULT_SPEC = registry().default("product_text")
MODEL = DEFAULT_SPEC.id
PASSAGE_TASK = DEFAULT_SPEC.task("passage")
DIMENSIONS = DEFAULT_SPEC.dimensions
OPERATION = "product_text_embedding"
JOB = "enrich_products"

#: Ayni anda tek kosu (oturum duzeyi `pg_try_advisory_lock`). Diger islerin anahtarlarindan ayri.
LOCK_KEY = 177_000_001

#: Pencere genisligi (urun kimligi). 12,3 M urunde tam tarama ~615 pencere; her biri PK araligi.
DEFAULT_SCAN_STEP = 20_000
#: v3 tek istekte 2048 girdi alir; 128 x ~48 token ~ 6 bin token/istek, 4xx bolmesi ucuz.
DEFAULT_API_BATCH = 128
MAX_CONSECUTIVE_FAILURES = 3
#: Kuru calisma/tavan tahmini: uretimde 15.000 urunde ~47,5 token / ~130 karakter olculdu (0170).
CHARS_PER_TOKEN = DEFAULT_SPEC.chars_per_token

#: Vektor tablosu ve boyutu kayit defterindeki aileden gelir (karar 0180/0181). Tablo adi SQL'e
#: yalnizca bu kumeden girer (kullanici girdisi degil).
TABLES = frozenset({"product_text_embedding", "product_text_embedding_d384"})
#: Karar 0179 veri seti yalniz saglayici (API) vektorlerini ve `halfvec(768)`i tasir.
ARCHIVE_TABLE = "product_text_embedding"


@dataclass(frozen=True)
class TableSql:
    """Bir vektor tablosu icin tum ifadeler. Hepsi ayni sozlesmeyi (0105) paylasir."""

    table: str
    dimensions: int
    scan_range: str
    scan_ids: str
    donors: str
    copy: str
    upsert: str
    touch: str


def table_sql(table: str, dimensions: int) -> TableSql:
    if table not in TABLES or not 1 <= dimensions <= 4000:
        raise ValueError(f"bilinmeyen vektor tablosu: {table!r}")
    scan = f"""
SELECT p.id, p.title, b.name, s.source_hash, e.content_hash, e.text_version
  FROM product p
  LEFT JOIN brand b ON b.id = p.brand_id
 CROSS JOIN LATERAL (
       SELECT decode(md5(p.title || chr(31) || coalesce(b.name, '')), 'hex') AS source_hash) s
  LEFT JOIN {table} e
         ON e.product_id = p.id AND e.model_version = %(model)s
 WHERE {{where}}
   AND p.publication_state = 'published'
   AND (%(include_offerless)s OR p.offer_count + p.foreign_offer_count > 0)
   AND (e.product_id IS NULL
        OR e.text_version <> %(text_version)s
        OR e.source_hash <> s.source_hash)
 ORDER BY p.id
"""
    on_conflict = """
ON CONFLICT (product_id, model_version) DO UPDATE
   SET text_version = EXCLUDED.text_version,
       content_hash = EXCLUDED.content_hash,
       source_hash  = EXCLUDED.source_hash,
       embedding    = EXCLUDED.embedding,
       embedded_at  = now()
"""
    # Vektor sunucu tarafinda kopyalanir (istemciye vektor tasinmaz). Arada silinen urun JOIN ile
    # elenir (FK hatasi yerine sessizce atlanir).
    copy = f"""
INSERT INTO {table} AS t
       (product_id, model_version, text_version, content_hash, source_hash, embedding)
SELECT u.product_id, %(model)s, %(text_version)s, u.content_hash, u.source_hash, d.embedding
  FROM unnest(%(ids)s::bigint[], %(content)s::bytea[], %(source)s::bytea[])
       AS u(product_id, content_hash, source_hash)
  JOIN product p ON p.id = u.product_id
  JOIN LATERAL (
       SELECT e.embedding FROM {table} e
        WHERE e.model_version = %(model)s AND e.content_hash = u.content_hash
        LIMIT 1) d ON true
"""
    upsert = f"""
INSERT INTO {table} AS t
       (product_id, model_version, text_version, content_hash, source_hash, embedding)
SELECT u.product_id, %(model)s, %(text_version)s, u.content_hash, u.source_hash,
       u.embedding::halfvec({dimensions})
  FROM unnest(%(ids)s::bigint[], %(content)s::bytea[], %(source)s::bytea[], %(vectors)s::text[])
       AS u(product_id, content_hash, source_hash, embedding)
  JOIN product p ON p.id = u.product_id
"""
    # Kanonik metin ayni: yalniz kaynak ozeti yenilenir. Vektor kolonu yazilmaz (HNSW kuruluyken
    # indeks bakimi ve WAL olusmasin).
    touch = f"""
UPDATE {table} t
   SET source_hash = u.source_hash
  FROM unnest(%(ids)s::bigint[], %(source)s::bytea[]) AS u(product_id, source_hash)
 WHERE t.product_id = u.product_id AND t.model_version = %(model)s
"""
    donors = f"""
SELECT DISTINCT content_hash
  FROM {table}
 WHERE model_version = %(model)s AND content_hash = ANY(%(hashes)s::bytea[])
"""
    return TableSql(
        table=table,
        dimensions=dimensions,
        scan_range=scan.format(where="p.id > %(lo)s AND p.id <= %(hi)s"),
        scan_ids=scan.format(where="p.id = ANY(%(ids)s::bigint[])"),
        donors=donors,
        copy=copy + on_conflict,
        upsert=upsert + on_conflict,
        touch=touch,
    )


#: Varsayilan (uretim) tablo ifadeleri; eski adlarla da erisilebilir.
DEFAULT_SQL = table_sql("product_text_embedding", 768)
SCAN_RANGE_SQL = DEFAULT_SQL.scan_range
SCAN_IDS_SQL = DEFAULT_SQL.scan_ids
DONORS_SQL = DEFAULT_SQL.donors
COPY_SQL = DEFAULT_SQL.copy
UPSERT_SQL = DEFAULT_SQL.upsert
TOUCH_SQL = DEFAULT_SQL.touch

MAX_ID_SQL = "SELECT coalesce(max(id), 0) FROM product"

# Karar 0179: saglayicidan gelen her (kanonik metin, vektor) urunden bagimsiz arsive; ayni metin tek
# satir. Vektor yazimiyla AYNI islemde: arsivde olmayan vektor urun tablosunda da olmaz.
ARCHIVE_SQL = """
INSERT INTO embedding_dataset
       (model_version, content_hash, text_version, task, input_text, embedding, source,
        first_product_id)
SELECT %(model)s, u.content_hash, %(text_version)s, %(task)s, u.input_text,
       u.embedding::halfvec(768), 'api', u.product_id
  FROM unnest(%(content)s::bytea[], %(texts)s::text[], %(vectors)s::text[], %(ids)s::bigint[])
       AS u(content_hash, input_text, embedding, product_id)
ON CONFLICT (model_version, content_hash) DO NOTHING
"""


@dataclass(frozen=True)
class Candidate:
    """Taramada degismis/yeni bulunan urun."""

    product_id: int
    title: str
    brand: str | None
    source_hash: bytes
    stored_hash: bytes | None
    stored_version: int | None


@dataclass
class Options:
    dry_run: bool = True
    after_id: int = 0
    until_id: int | None = None
    ids: Sequence[int] | None = None
    #: Bu kosuda islenecek en fazla degismis/yeni urun.
    limit: int | None = None
    #: Kosu token tavani (gercek + bekleyen tahmin). None: tavansiz (yalniz sahte istemci/test).
    max_tokens: int | None = None
    include_offerless: bool = False
    scan_step: int = DEFAULT_SCAN_STEP
    api_batch: int = DEFAULT_API_BATCH
    max_consecutive_failures: int = MAX_CONSECUTIVE_FAILURES


@dataclass
class ProductCounts:
    model: str = MODEL
    provider: str = DEFAULT_SPEC.provider
    windows: int = 0
    candidates: int = 0
    new: int = 0
    refreshed: int = 0
    touched: int = 0
    skipped_empty: int = 0
    unique_texts: int = 0
    reused: int = 0
    api_texts: int = 0
    api_calls: int = 0
    tokens: int = 0
    estimated_tokens: int = 0
    written: int = 0
    #: Karar 0179: kalici veri setine eklenen yeni (metin, vektor) satiri.
    archived: int = 0
    rejected: int = 0
    failed: int = 0
    aborted: bool = False
    budget_stopped: bool = False
    limit_reached: bool = False
    interrupted: bool = False
    wal_stopped: str | None = None
    locked: bool = False
    #: Secilen model bu tabloya yazilamaz (boyut/uzay uyusmazligi); hicbir sey yapilmadi.
    incompatible: bool = False
    #: Gozlem: API/model cagrisi basina sure (ms); detayda yalniz p50/p95 tutulur.
    latencies_ms: list[float] = field(default_factory=list)
    #: Bir sonraki kosunun `--after-id` degeri (bu kimlige kadar tum urunler islendi).
    resume_after: int = 0
    errors: list[str] = field(default_factory=list)

    def note(self, message: str) -> None:
        if len(self.errors) < 20:
            self.errors.append(message)

    def detail(self) -> dict[str, Any]:
        return {
            "model": self.model,
            "provider": self.provider,
            "text_version": TEXT_VERSION,
            "windows": self.windows,
            "candidates": self.candidates,
            "new": self.new,
            "refreshed": self.refreshed,
            "touched": self.touched,
            "skipped_empty": self.skipped_empty,
            "unique_texts": self.unique_texts,
            "reused": self.reused,
            "api_texts": self.api_texts,
            "api_calls": self.api_calls,
            "tokens": self.tokens,
            "written": self.written,
            "archived": self.archived,
            "rejected": self.rejected,
            "failed": self.failed,
            "budget_stopped": self.budget_stopped,
            "limit_reached": self.limit_reached,
            "resume_after": self.resume_after,
            **latency_detail(self.latencies_ms, self.api_texts),
        }


def _percentile(values: Sequence[float], q: float) -> float:
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, math.ceil(q * len(ordered)) - 1))
    return ordered[index]


def latency_detail(latencies_ms: Sequence[float], items: int) -> dict[str, Any]:
    """Saglayici gecikmesi ve verim: yalniz sayilar (metin, anahtar yok). Cagri yoksa bos."""
    if not latencies_ms:
        return {}
    total_s = sum(latencies_ms) / 1000
    return {
        "embed_ms_p50": round(_percentile(latencies_ms, 0.50)),
        "embed_ms_p95": round(_percentile(latencies_ms, 0.95)),
        "items_per_s": round(items / total_s, 1) if total_s > 0 else None,
    }


def decide_outcome(counts: ProductCounts) -> tuple[str, str | None]:
    """Karar 0174 sozlesmesi: sonuc yalnizca tipli sayaclardan, oncelik sirasiyla."""
    if counts.incompatible:
        return "failed", "incompatible_index"
    if counts.locked:
        return "skipped_locked", "lock_busy"
    if counts.aborted:
        return ("partial" if counts.written else "failed"), "provider_errors"
    if counts.wal_stopped:
        return "partial", "wal_backpressure"
    if counts.interrupted:
        return "partial", "interrupted"
    if counts.rejected or counts.failed:
        return "partial", "item_errors"
    if counts.candidates == 0:
        return "no_input", "up_to_date"
    if counts.budget_stopped:
        return "completed", "token_budget_reached"
    if counts.limit_reached:
        return "completed", "limit_reached"
    return "completed", None


def estimate_tokens(text: str) -> int:
    return max(1, math.ceil(len(text) / CHARS_PER_TOKEN))


def vector_literal(vector: Sequence[float]) -> str:
    """halfvec metin girdisi; yarim duyarlik ~3,3 anlamli basamak, 5 basamak kayipsiz."""
    return "[" + ",".join(f"{value:.5g}" for value in vector) + "]"


def _windows(
    conn: psycopg.Connection, options: Options, queries: TableSql = DEFAULT_SQL
) -> Iterator[tuple[str, dict[str, Any]]]:
    """(sql, parametre) pencereleri: kimlik listesi dilimleri ya da birincil anahtar araliklari."""
    if options.ids is not None:
        ids = sorted({int(i) for i in options.ids if int(i) > options.after_id})
        for start in range(0, len(ids), options.scan_step):
            yield queries.scan_ids, {"ids": ids[start : start + options.scan_step]}
        return
    with conn.cursor() as cur:
        cur.execute(MAX_ID_SQL)
        row = cur.fetchone()
    conn.commit()
    top = int(row[0]) if row else 0
    if options.until_id is not None:
        top = min(top, options.until_id)
    lo = options.after_id
    while lo < top:
        hi = min(lo + options.scan_step, top)
        yield queries.scan_range, {"lo": lo, "hi": hi}
        lo = hi


@dataclass
class _Work:
    """Bir penceredeki vektor gerektiren urunler, kanonik metne gore gruplu."""

    text_by_hash: dict[bytes, str] = field(default_factory=dict)
    members: dict[bytes, list[Candidate]] = field(default_factory=dict)

    def add(self, digest: bytes, text: str, candidate: Candidate) -> None:
        self.text_by_hash.setdefault(digest, text)
        self.members.setdefault(digest, []).append(candidate)


class ProductEmbedder:
    """Tek kosunun durumu. Testler `run` uzerinden surer; CLI yalnizca baglar."""

    def __init__(
        self,
        conn: psycopg.Connection,
        client: EmbeddingClient,
        options: Options,
        *,
        governor: wal_pressure.WalGovernor | None = None,
        should_stop: Callable[[], bool] = lambda: False,
    ) -> None:
        self.conn = conn
        self.client = client
        self.options = options
        self.governor = governor
        self.should_stop = should_stop
        self.model = client.model_version
        self.spec: ModelSpec | None = registry().spec_for_version(self.model)
        self.sql = DEFAULT_SQL
        #: Yalniz saglayici vektorleri 0179 veri setine yazilir (yerel cikti yeniden uretilebilir).
        self.archive = False
        self.counts = ProductCounts(
            model=self.model,
            provider=self.spec.provider if self.spec else "unknown",
            resume_after=options.after_id,
        )
        self._consecutive_failures = 0
        #: Kuru calismada bu kosuda "uretilmis sayilan" ozetler: sonraki pencerelerde kopya sayilir.
        self._planned: set[bytes] = set()

    # --- giris ---------------------------------------------------------------------------
    def run(self) -> ProductCounts:
        # Kayit defterinde olmayan ya da baska boyut/uzaydaki model bu tabloya yazamaz (karar 0180).
        try:
            if self.spec is None:
                raise RegistryError(f"kayit defterinde yok: {self.model!r}")
            if "product_text" not in self.spec.roles or self.spec.state == "disabled":
                raise RegistryError(f"{self.spec.id}: urun metni icin kullanilamaz")
            require_writable(self.spec, self.spec.index_family)
            family = registry().family(self.spec)
            self.sql = table_sql(family.table or "", family.dimensions)
            self.archive = family.table == ARCHIVE_TABLE and self.spec.provider == "jina"
        except (RegistryError, ValueError) as error:
            self.counts.incompatible = True
            self.counts.note(str(error))
            return self.counts
        if not self._lock():
            self.counts.locked = True
            return self.counts
        try:
            for sql, params in _windows(self.conn, self.options, self.sql):
                if self._halted():
                    break
                rows = self._scan(sql, params)
                self.counts.windows += 1
                if not self._process(rows):
                    break
                self.counts.resume_after = self._window_end(params, rows)
        finally:
            self._unlock()
        return self.counts

    # --- kilit -----------------------------------------------------------------------------
    def _lock(self) -> bool:
        with self.conn.cursor() as cur:
            cur.execute("SELECT pg_try_advisory_lock(%s)", (LOCK_KEY,))
            row = cur.fetchone()
        self.conn.commit()
        return bool(row and row[0])

    def _unlock(self) -> None:
        try:
            if self.conn.info.transaction_status != psycopg.pq.TransactionStatus.IDLE:
                self.conn.rollback()
            with self.conn.cursor() as cur:
                cur.execute("SELECT pg_advisory_unlock(%s)", (LOCK_KEY,))
            self.conn.commit()
        except psycopg.Error as error:  # baglanti kapaninca kilit zaten birakilir
            logger.warning("danisma kilidi birakilamadi: %s", type(error).__name__)

    # --- tarama ----------------------------------------------------------------------------
    def _scan(self, sql: str, params: dict[str, Any]) -> list[Candidate]:
        query = {
            **params,
            "model": self.model,
            "text_version": TEXT_VERSION,
            "include_offerless": self.options.include_offerless,
        }
        with self.conn.cursor() as cur:
            cur.execute(sql, query)
            fetched = cur.fetchall()
        # Okuma islemi API beklerken acik kalmasin.
        self.conn.commit()
        return [
            Candidate(
                product_id=int(pid),
                title=title,
                brand=brand,
                source_hash=bytes(source),
                stored_hash=None if stored is None else bytes(stored),
                stored_version=None if version is None else int(version),
            )
            for pid, title, brand, source, stored, version in fetched
        ]

    def _window_end(self, params: dict[str, Any], rows: list[Candidate]) -> int:
        if "hi" in params:
            return int(params["hi"])
        ids = params["ids"]
        return int(ids[-1]) if ids else self.counts.resume_after

    def _halted(self) -> bool:
        c = self.counts
        if self.should_stop():
            c.interrupted = True
        return (
            c.aborted or c.budget_stopped or c.limit_reached or c.interrupted or bool(c.wal_stopped)
        )

    # --- pencere ---------------------------------------------------------------------------
    def _process(self, rows: list[Candidate]) -> bool:
        """Pencereyi isler. False: kosu durmali (resume_after zaten ayarlandi)."""
        c = self.counts
        if self.options.limit is not None:
            room = self.options.limit - c.candidates
            if room <= 0:
                c.limit_reached = True
                return False
            if len(rows) > room:
                rows = rows[:room]
                c.limit_reached = True
        c.candidates += len(rows)

        touch: list[Candidate] = []
        work = _Work()
        for candidate in rows:
            text = build_product_text(candidate.title, candidate.brand)
            if not text:
                c.skipped_empty += 1
                continue
            digest = content_hash(self.model, text)
            if candidate.stored_hash == digest and candidate.stored_version == TEXT_VERSION:
                touch.append(candidate)
                continue
            if candidate.stored_hash is None:
                c.new += 1
            else:
                c.refreshed += 1
            work.add(digest, text, candidate)

        if touch and not self._touch(touch):
            return self._stop_at(rows[0].product_id)
        if not work.members:
            return self._continue_after(rows)

        hashes = list(work.members)
        c.unique_texts += len(hashes)
        donors = self._donors(hashes)
        reuse = [h for h in hashes if h in donors]
        fresh = [h for h in hashes if h not in donors]
        if reuse and not self._copy(work, reuse):
            return self._stop_at(rows[0].product_id)

        for start in range(0, len(fresh), self.options.api_batch):
            batch = fresh[start : start + self.options.api_batch]
            if not self._embed_batch(work, batch):
                first = min(m.product_id for h in fresh[start:] for m in work.members[h])
                return self._stop_at(first)
        return self._continue_after(rows)

    def _continue_after(self, rows: list[Candidate]) -> bool:
        if self.counts.limit_reached:
            if rows:
                self.counts.resume_after = rows[-1].product_id
            return False
        return True

    def _stop_at(self, first_unfinished_id: int) -> bool:
        # Durum veritabaninda oldugundan kalan urunler sonraki kosuda zaten bulunur; bu deger
        # yalnizca elle `--after-id` ile devam icin ipucudur.
        self.counts.resume_after = max(self.counts.resume_after, first_unfinished_id - 1)
        return False

    # --- yazim adimlari -------------------------------------------------------------------
    def _may_write(self) -> bool:
        """WAL geri basinci (karar 0134). False: kosu durur (neden sayaclara yazilir)."""
        if self.governor is None or self.governor.before_batch():
            return True
        if self.governor.stopped_reason is not None:
            self.counts.wal_stopped = self.governor.stopped_reason
        else:  # bekleme sirasinda durdurma istendi
            self.counts.interrupted = True
        return False

    def _touch(self, touch: list[Candidate]) -> bool:
        if self.options.dry_run:
            self.counts.touched += len(touch)
            return True
        if not self._may_write():
            return False
        self.counts.touched += len(touch)
        with self.conn.cursor() as cur:
            cur.execute(
                self.sql.touch,
                {
                    "model": self.model,
                    "ids": [t.product_id for t in touch],
                    "source": [t.source_hash for t in touch],
                },
            )
        self.conn.commit()
        return True

    def _donors(self, hashes: list[bytes]) -> set[bytes]:
        with self.conn.cursor() as cur:
            cur.execute(self.sql.donors, {"model": self.model, "hashes": hashes})
            found = {bytes(row[0]) for row in cur.fetchall()}
        self.conn.commit()
        if self.options.dry_run:
            found |= self._planned.intersection(hashes)
        return found

    def _copy(self, work: _Work, reuse: list[bytes]) -> bool:
        members = [m for h in reuse for m in work.members[h]]
        if self.options.dry_run:
            self.counts.reused += len(members)
            return True
        if not self._may_write():
            return False
        params = {
            "model": self.model,
            "text_version": TEXT_VERSION,
            "ids": [m.product_id for m in members],
            "content": [h for h in reuse for _ in work.members[h]],
            "source": [m.source_hash for m in members],
        }
        with self.conn.cursor() as cur:
            cur.execute(self.sql.copy, params)
            written = max(cur.rowcount, 0)
        self.conn.commit()
        self.counts.reused += written
        self.counts.written += written
        return True

    def _embed_batch(self, work: _Work, batch: list[bytes]) -> bool:
        """Bir API partisi: tavan denetimi, cagri, kullanim kaydi, yazim. False: kosu durur."""
        c = self.counts
        texts = [work.text_by_hash[h] for h in batch]
        estimate = sum(estimate_tokens(t) for t in texts)
        spent = c.tokens if not self.options.dry_run else c.estimated_tokens
        if self.options.max_tokens is not None and spent + estimate > self.options.max_tokens:
            c.budget_stopped = True
            return False
        if self.options.dry_run:
            c.api_texts += len(batch)
            c.estimated_tokens += estimate
            self._planned.update(batch)
            return True
        if self.should_stop():
            c.interrupted = True
            return False

        try:
            vectors = self._embed_resilient(texts)
        except EmbeddingError as error:
            self._consecutive_failures += 1
            c.failed += sum(len(work.members[h]) for h in batch)
            c.note(f"parti ({len(batch)} metin): {type(error).__name__}: {error}")
            logger.warning("urun metin partisi atlandi, sonraki kosuya kaldi: %s", error)
            if self._consecutive_failures >= self.options.max_consecutive_failures:
                c.aborted = True
                return False
            return True
        self._consecutive_failures = 0
        c.api_texts += len(batch)

        rows: list[tuple[int, bytes, bytes, str]] = []
        archive: list[tuple[bytes, str, str, int]] = []
        for digest, vector in zip(batch, vectors, strict=True):
            members = work.members[digest]
            if vector is None:
                c.rejected += len(members)
                c.note(f"saglayici reddetti: urun {members[0].product_id}")
                continue
            literal = vector_literal(vector)
            rows.extend((m.product_id, digest, m.source_hash, literal) for m in members)
            archive.append((digest, work.text_by_hash[digest], literal, members[0].product_id))
        if not rows:
            return True
        if not self._may_write():
            return False
        params = {
            "model": self.model,
            "text_version": TEXT_VERSION,
            "ids": [r[0] for r in rows],
            "content": [r[1] for r in rows],
            "source": [r[2] for r in rows],
            "vectors": [r[3] for r in rows],
        }
        with self.conn.cursor() as cur:
            cur.execute(self.sql.upsert, params)
            c.written += max(cur.rowcount, 0)
            if not self.archive:
                self.conn.commit()
                return True
            cur.execute(
                ARCHIVE_SQL,
                {
                    "model": self.model,
                    "text_version": TEXT_VERSION,
                    "task": self.spec.task("passage") if self.spec else PASSAGE_TASK,
                    "content": [a[0] for a in archive],
                    "texts": [a[1] for a in archive],
                    "vectors": [a[2] for a in archive],
                    "ids": [a[3] for a in archive],
                },
            )
            c.archived += max(cur.rowcount, 0)
        self.conn.commit()
        return True

    def _embed_resilient(self, texts: list[str]) -> list[list[float] | None]:
        """Partiyi gonderir; kalici ret (4xx) tek bozuk girdiden olabilir: ikiye bolerek ayiklar.

        Reddedilen girdi None doner (o urun yazilmaz, sonraki kosuda yeniden denenir).
        Gecici hata (`EmbeddingError`) yukari firlatilir.
        """
        started = time.perf_counter()
        try:
            batch = self.client.embed_texts(texts)
        except EmbeddingRejected:
            if len(texts) == 1:
                return [None]
            middle = len(texts) // 2
            return self._embed_resilient(texts[:middle]) + self._embed_resilient(texts[middle:])
        self.counts.latencies_ms.append((time.perf_counter() - started) * 1000)
        self._record(batch)
        # Kapi: sayi, boyut, sonlu deger, birim norm. Gecemezse `EmbeddingInvalid`
        # (`EmbeddingError`): parti yazilmaz, ardisik hata sayacina girer.
        if self.spec is None:  # run() zaten reddeder; dogrudan cagriya karsi
            raise EmbeddingError(f"kayit defterinde yok: {self.model!r}")
        return list(validate_for(self.spec, batch, len(texts)).vectors)

    def _record(self, batch: EmbeddingBatch) -> None:
        """Kural 9: cagri vektor yazimindan ONCE, ayri islemde kaydedilir (yazim dusse de kalir)."""
        self.counts.api_calls += 1
        self.counts.tokens += batch.total_tokens
        usage.record(
            self.conn,
            usage.ModelCall(
                # Duz metin: `admin/coverage.test.ts` islemi bu kaliptan bulur.
                operation="product_text_embedding",
                model_version=batch.model_version,
                units=batch.total_tokens,
                # Yerel CPU modeli cagri basina ucretsizdir; cagri yine kaydedilir (kural 9).
                cost_micros=0 if self.spec and self.spec.provider == "local_onnx" else None,
            ),
        )
        self.conn.commit()


def embed_products(
    conn: psycopg.Connection,
    client: EmbeddingClient,
    options: Options,
    *,
    governor: wal_pressure.WalGovernor | None = None,
    should_stop: Callable[[], bool] = lambda: False,
) -> ProductCounts:
    return ProductEmbedder(conn, client, options, governor=governor, should_stop=should_stop).run()


# --- CLI ------------------------------------------------------------------------------------

_stop_requested = False


def _request_stop(signum: int, frame: FrameType | None) -> None:
    global _stop_requested
    _stop_requested = True
    logger.warning("durdurma istendi (sinyal %s); mevcut parti bitince durulur", signum)


def _should_stop() -> bool:
    return _stop_requested


def _is_local(url: str) -> bool:
    return (urlparse(url).hostname or "").lower() in {"localhost", "127.0.0.1", "::1"}


def _local_db() -> bool:
    """DATABASE_URL tanimsizsa YEREL DEGIL sayilir (temkinli): arguman dogrulamasi baglantisiz
    calisir; eksik URL hatasi ancak gercek baglantida (`connect`) verilir."""
    return _is_local(env("DATABASE_URL") or "")


def read_ids(path: Path) -> list[int]:
    """Satir basina bir urun kimligi; bos satir ve `#` yorumu atlanir. Gecersiz satir hatadir."""
    ids: list[int] = []
    for number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        if not line.isdigit():
            raise ValueError(f"{path.name}:{number}: urun kimligi degil")
        ids.append(int(line))
    return ids


def _report(counts: ProductCounts, seconds: float, dry_run: bool) -> None:
    rate = usage.cost_micros_per_1k_tokens()
    tokens = counts.estimated_tokens if dry_run else counts.tokens
    suffix = " (KURU CALISMA: API yok, yazim yok)" if dry_run else ""
    print(f"--- urun metin embedding ({counts.model}, metin t{TEXT_VERSION}){suffix} ---")
    if counts.incompatible:
        print(f"  model bu tabloya yazilamaz; hicbir sey yapilmadi: {'; '.join(counts.errors)}")
        return
    if counts.locked:
        print("  baska bir kosu calisiyor (danisma kilidi); hicbir sey yapilmadi")
        return
    print(f"  pencere               {counts.windows}")
    print(f"  degismis/yeni urun    {counts.candidates}")
    print(f"    yeni                {counts.new}")
    print(f"    metni degisen       {counts.refreshed}")
    print(f"    yalniz ozet (API'siz) {counts.touched}")
    print(f"    bos metin (atlandi) {counts.skipped_empty}")
    print(f"  benzersiz metin       {counts.unique_texts}")
    print(f"  kopyalanan (API'siz)  {counts.reused}")
    print(f"  API'ye giden metin    {counts.api_texts}")
    print(f"  API cagrisi           {counts.api_calls}")
    print(f"  token                 {tokens}{' (tahmin)' if dry_run else ''}")
    print(f"  maliyet (mikro TL)    {round(tokens * rate / 1000)}  (0 = oran tanimsiz)")
    print(f"  yazilan vektor satiri {counts.written}")
    print(f"  veri setine eklenen   {counts.archived}")
    print(f"  reddedilen            {counts.rejected}")
    print(f"  basarisiz             {counts.failed}{' (kosu durdu)' if counts.aborted else ''}")
    if counts.budget_stopped:
        print("  UYARI: --max-tokens tavani doldu; kalan urunler sonraki kosuya kaldi")
    if counts.limit_reached:
        print("  UYARI: --limit doldu; kalan urunler sonraki kosuya kaldi")
    if counts.wal_stopped:
        print(f"  UYARI: WAL geri basinci: {counts.wal_stopped}")
    if counts.interrupted:
        print("  UYARI: durdurma istendi")
    print(f"  devam noktasi         --after-id {counts.resume_after}")
    print(f"  sure                  {seconds:.1f} sn")
    for key, value in latency_detail(counts.latencies_ms, counts.api_texts).items():
        print(f"  {key:<21} {value}")
    for error in counts.errors:
        print(f"  ! {error}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="enrich.products", description="Urun metin embedding (karar 0177)"
    )
    parser.add_argument(
        "--execute", action="store_true", help="API cagir ve yaz (varsayilan: kuru)"
    )
    parser.add_argument(
        "--max-tokens", type=int, default=None, help="kosu token tavani (--execute ile ZORUNLU)"
    )
    parser.add_argument("--limit", type=int, default=None, help="en fazla degismis/yeni urun")
    parser.add_argument("--after-id", type=int, default=0, help="bu kimlikten sonrasi")
    parser.add_argument("--until-id", type=int, default=None, help="bu kimlige kadar (dahil)")
    parser.add_argument(
        "--ids-file", type=Path, default=None, help="yalniz bu urunler (satir basina kimlik)"
    )
    parser.add_argument(
        "--include-offerless",
        action="store_true",
        help="teklifi olmayan yayindaki urunleri de al (varsayilan: yalniz teklifli)",
    )
    parser.add_argument("--scan-step", type=int, default=DEFAULT_SCAN_STEP)
    parser.add_argument("--batch-size", type=int, default=DEFAULT_API_BATCH)
    parser.add_argument(
        "--fake-client", action="store_true", help="deterministik sahte vektor; yalniz YEREL DB"
    )
    parser.add_argument(
        "--model",
        default=None,
        help="kayit defteri kimligi (varsayilan: ENRICH_PRODUCT_TEXT_MODEL, yoksa kayit)",
    )
    parser.add_argument(
        "--model-dir", type=Path, default=None, help="yerel (local_onnx) model dizini"
    )
    parser.add_argument("--threads", type=int, default=2, help="yerel model is parcacigi")
    parser.add_argument("--verbose", "-v", action="store_true")
    return parser


def _validate(args: argparse.Namespace) -> str | None:
    if args.limit is not None and args.limit < 1:
        return "--limit en az 1 olmali"
    if args.scan_step < 1 or args.batch_size < 1 or args.batch_size > 2048:
        return "--scan-step >= 1, 1 <= --batch-size <= 2048 olmali"
    if args.after_id < 0 or (args.until_id is not None and args.until_id <= args.after_id):
        return "--after-id >= 0 ve --until-id > --after-id olmali"
    if args.ids_file is not None and args.until_id is not None:
        return "--ids-file ile --until-id birlikte kullanilmaz"
    if args.max_tokens is not None and args.max_tokens < 1:
        return "--max-tokens pozitif olmali"
    local_db = _local_db()
    if args.fake_client and args.execute and not local_db:
        return "sahte vektor yalnizca yerel veritabanina yazilabilir"
    if args.threads < 1:
        return "--threads pozitif olmali"
    try:
        spec = _select(args, local_db)
        require_writable(spec, spec.index_family)
    except RegistryError as error:
        return f"model secilemez: {error}"
    if spec.provider == "jina":
        if args.execute and not args.fake_client and args.max_tokens is None:
            return "gercek API icin --max-tokens zorunlu; sinirsiz ucretli cagri yok"
        if args.execute and not args.fake_client and not os.environ.get("JINA_API_KEY"):
            return "JINA_API_KEY tanimli degil"
    elif not args.fake_client and args.model_dir is None:
        return f"{spec.id}: yerel model icin --model-dir gerekli"
    return None


def _select(args: argparse.Namespace, local_db: bool) -> ModelSpec:
    """Uretimde yalniz active/shadow + dogrulanmis lisans; pilot modeller yalniz YEREL DB."""
    return select_model("product_text", requested=args.model, allow_pilot=local_db)


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO, format="%(levelname)s %(message)s"
    )
    problem = _validate(args)
    if problem:
        print(f"HATA: {problem}", file=sys.stderr)
        return 2
    try:
        ids = read_ids(args.ids_file) if args.ids_file is not None else None
    except (OSError, ValueError) as error:
        print(f"HATA: {error}", file=sys.stderr)
        return 2

    options = Options(
        dry_run=not args.execute,
        after_id=args.after_id,
        until_id=args.until_id,
        ids=ids,
        limit=args.limit,
        max_tokens=args.max_tokens,
        include_offerless=args.include_offerless,
        scan_step=args.scan_step,
        api_batch=args.batch_size,
    )
    spec = _select(args, _local_db())  # _validate dogruladi
    budget: TokenBudget | None = None
    client: EmbeddingClient
    if args.fake_client:
        client = FakeEmbeddingClient(model=f"{spec.id}-fake", dimensions=spec.dimensions)
        print("UYARI: sahte istemci; vektorler anlamsal DEGIL.\n")
    else:
        if args.execute and spec.provider == "jina":
            budget = TokenBudget(tokens_per_minute=tokens_per_minute_from_env())
            print(f"butce {budget.tokens_per_minute} token/dk, tavan {args.max_tokens} token\n")
        # Kayit defterinden: model, gorev/onek ve boyut (uzak API ya da yerel CPU).
        try:
            client = build_text_provider(  # type: ignore[assignment]
                spec,
                purpose="passage",
                budget=budget,
                batch_size=args.batch_size,
                model_dir=args.model_dir,
                threads=args.threads,
            )
        except (RegistryError, RuntimeError, ImportError) as error:
            print(f"HATA: model yuklenemedi: {error}", file=sys.stderr)
            return 2

    signal.signal(signal.SIGINT, _request_stop)
    signal.signal(signal.SIGTERM, _request_stop)

    started = time.monotonic()
    tracked = args.execute and not args.fake_client
    if not tracked:
        # Kuru calisma ve sahte istemci is kaydi birakmaz (karar 0055/0174 madde 8).
        with connect() as conn:
            counts = embed_products(conn, client, options, should_stop=_should_stop)
        _report(counts, time.monotonic() - started, options.dry_run)
        name, reason = decide_outcome(counts)
        return job_run.outcome(name, reason).exit_code

    with job_run.track(JOB, outcomes=True) as run, connect() as conn:
        governor = wal_pressure.WalGovernor.for_connection(conn, should_stop=_should_stop)
        counts = embed_products(conn, client, options, governor=governor, should_stop=_should_stop)
        run.detail.update(counts.detail())
        run.detail.update(governor.stats.as_detail())
        if isinstance(client, JinaEmbeddingClient):
            run.detail.update(rate_limited=client.rate_limited, retries=client.retries)
        name, reason = decide_outcome(counts)
        if counts.wal_stopped:
            run.error_summary = f"WAL geri basinci: {counts.wal_stopped}"
        elif counts.errors:
            run.error_summary = "; ".join(counts.errors)[:300]
        code = run.set_outcome(name, reason)
    _report(counts, time.monotonic() - started, options.dry_run)
    if isinstance(client, JinaEmbeddingClient):
        waited = budget.waited if budget is not None else 0.0
        print(
            f"\n429: {client.rate_limited}  yeniden deneme: {client.retries}"
            f"  bekleme {waited:.1f} sn"
        )
    return code


if __name__ == "__main__":
    sys.exit(main())
