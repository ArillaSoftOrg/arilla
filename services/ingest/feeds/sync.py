"""Bir beslemenin artimli senkronizasyonu (karar 0112).

Akis:

1. Kilit (`pg_try_advisory_lock(4301, feed_source_id)`): ayni besleme iki kez
   ayni anda islenmez.
2. `ingest_run` kaydi; indirme adresi agdan yeniden cozulur (kimlik bilgisi
   yalnizca bellekte), dosya akisla diske iner (tavan + bos alan korumasi).
3. sha256 daha once `complete` ise surum `duplicate`: hicbir sey yazilmaz.
   Ayni sha256 ile yarim kalmis (`processing`) surum varsa KALDIGI YERDEN devam
   edilir: birlestirilmis parcalar atlanir.
4. Akisla ayristirma + normalizasyon; kayit sirasina gore sabit parcalar.
   Her parca TEK islemde: COPY -> satici upsert -> offer upsert (parmak izi ile
   degisiklik tespiti) -> `price_point` (yalnizca yeni/degisen fiyat-stok,
   INSERT) -> `search_outbox` -> uyelik -> `ingest_chunk = merged` ->
   `ingest_run` kontrol noktasi. Reddedilen kayitlar `ingest_error`'a.
5. Tamlik kapisi: dosya sonuna hatasiz ulasildi, red orani esigin altinda,
   kayit sayisi son tam surumlerin medyaninin %85'inden az degil. Gecmezse
   surum `rejected`: birlestirilen kayitlar kalir, HICBIR offer pasiflesmez.
6. Kapi gecerse guvenli deaktivasyon: bu beslemede artik olmayan ve baska
   hicbir etkin beslemede bulunmayan offer'lar `is_active=false` (silme yok).
   Tavan (`max_deactivate_ratio`) asilirsa deaktivasyon yapilmaz, kosu `partial`.

`product_id`'ye DOKUNULMAZ: eslestirme cozumleyicinin isidir (karar 0111:
dogrulanmamis urun otomatik birlestirilmez).
"""

from __future__ import annotations

import hashlib
import json
import logging
import statistics
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import psycopg

from collect.image_writer import write_offer_images
from collect.images import SelectedImage
from db.connection import env
from feeds.download import DownloadError, cleanup_staging, download, staging_dir
from feeds.network import FeedNetwork, NetworkUnavailable
from feeds.normalize import FeedOffer, Rejected, normalize, schema_fields, schema_fingerprint
from feeds.parsers import FeedRecord, ParseResult, iter_records, open_decoded

logger = logging.getLogger(__name__)

LOCK_NAMESPACE = 4301
DEFAULT_REQUIRED = {
    "yml": ["@id", "name", "url", "price"],
}


@dataclass(frozen=True)
class SyncSettings:
    chunk_size: int = 1000
    #: Parcalar arasi bekleme (ms): web trafigine nefes.
    pause_ms: int = 50
    #: Aktif istemci baglantisi bunun ustundeyse parcalar arasi ek bekleme.
    busy_connections: int = 20
    busy_wait_seconds: float = 2.0
    max_reject_ratio: float = 0.02
    min_ratio_vs_median: float = 0.85
    max_deactivate_ratio: float = 0.10
    #: Uyeligi biten offer bu sure gorulmezse pasiflesir (fiyat bandi gecisi).
    deactivate_grace_hours: float = 48.0
    #: Surum basina yazilan en fazla hata satiri (gerisi yalnizca sayilir).
    max_errors_logged: int = 1000
    schema_sample: int = 500
    download_attempts: int = 3

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> SyncSettings:
        overrides = {
            key: config[key]
            for key in (
                "chunk_size",
                "max_reject_ratio",
                "min_ratio_vs_median",
                "max_deactivate_ratio",
                "deactivate_grace_hours",
            )
            if isinstance(config.get(key), int | float)
        }
        return cls(**overrides)


@dataclass
class SyncReport:
    feed_source_id: int
    run_id: int | None = None
    snapshot_id: int | None = None
    status: str = "running"
    records: int = 0
    rejected: int = 0
    created: int = 0
    changed: int = 0
    unchanged: int = 0
    reactivated: int = 0
    deactivated: int = 0
    price_points: int = 0
    outbox: int = 0
    chunks_merged: int = 0
    chunks_skipped: int = 0
    gate: str | None = None
    schema_changed: bool = False
    error_code: str | None = None

    def detail(self) -> dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v not in (None, False)}


class SyncAborted(Exception):
    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(code)
        self.code = code
        self.detail = detail[:300]


# ---------------------------------------------------------------------------
# SQL
# ---------------------------------------------------------------------------

LOAD_FEED = """
SELECT f.id, f.network, f.external_id, f.status, f.format, f.currency, f.config,
       f.schema_fingerprint, f.merchant_id, m.is_active, f.source_updated_at, f.last_success_at
  FROM feed_source f LEFT JOIN merchant m ON m.id = f.merchant_id
 WHERE f.id = %s
"""

STAGE_DDL = """
CREATE TEMP TABLE IF NOT EXISTS feed_stage (
    external_id   TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    url           TEXT NOT NULL,
    price         BIGINT NOT NULL,
    old_price     BIGINT,
    currency      CHAR(3) NOT NULL,
    in_stock      BOOLEAN NOT NULL,
    category_path TEXT,
    seller_ext    TEXT,
    brand         TEXT,
    image_url     TEXT,
    affiliate_url TEXT,
    attributes    JSONB NOT NULL,
    fingerprint   TEXT NOT NULL
) ON COMMIT DELETE ROWS
"""

STAGE_COLUMNS = (
    "external_id, title, url, price, old_price, currency, in_stock, category_path, "
    "seller_ext, brand, image_url, affiliate_url, attributes, fingerprint"
)

UPSERT_SELLERS = """
INSERT INTO seller (merchant_id, external_id)
SELECT DISTINCT %(merchant_id)s, seller_ext FROM feed_stage WHERE seller_ext IS NOT NULL
ON CONFLICT (merchant_id, external_id) DO UPDATE SET last_seen_at = now(), is_active = TRUE
"""

MERGE = """
WITH prev AS (
    SELECT o.id, o.fingerprint, o.current_price, o.list_price, o.in_stock, o.is_active, o.image_url
      FROM offer o JOIN feed_stage s ON s.external_id = o.external_id
     WHERE o.merchant_id = %(merchant_id)s
), up AS (
    INSERT INTO offer (
        merchant_id, external_id, url, title_raw, brand_raw, category_raw, image_url,
        attributes_raw, current_price, list_price, currency, in_stock, discovery_source,
        first_seen_at, last_seen_at, is_active, seller_id, feed_source_id, fingerprint,
        last_changed_at, last_snapshot_id, affiliate_url
    )
    SELECT %(merchant_id)s, s.external_id, s.url, s.title, s.brand, s.category_path, s.image_url,
           s.attributes, s.price, s.old_price, s.currency, s.in_stock, 'feed',
           %(observed_at)s, %(observed_at)s, TRUE, sl.id, %(feed_source_id)s, s.fingerprint,
           %(observed_at)s, %(snapshot_id)s, s.affiliate_url
      FROM feed_stage s
      LEFT JOIN seller sl ON sl.merchant_id = %(merchant_id)s AND sl.external_id = s.seller_ext
    ON CONFLICT (merchant_id, external_id) DO UPDATE SET
        url              = EXCLUDED.url,
        -- Takip baglantisi kanonik adresten ayri; kaynagin guncel degeri.
        affiliate_url    = EXCLUDED.affiliate_url,
        title_raw        = EXCLUDED.title_raw,
        brand_raw        = EXCLUDED.brand_raw,
        category_raw     = EXCLUDED.category_raw,
        image_url        = EXCLUDED.image_url,
        -- Kaynagin tasimadigi zenginlestirme anahtarlari korunur.
        attributes_raw   = offer.attributes_raw || EXCLUDED.attributes_raw,
        current_price    = EXCLUDED.current_price,
        list_price       = EXCLUDED.list_price,
        currency         = EXCLUDED.currency,
        in_stock         = EXCLUDED.in_stock,
        last_seen_at     = EXCLUDED.last_seen_at,
        is_active        = TRUE,
        deactivated_at   = NULL,
        deactivation_reason = NULL,
        seller_id        = COALESCE(EXCLUDED.seller_id, offer.seller_id),
        feed_source_id   = EXCLUDED.feed_source_id,
        last_snapshot_id = EXCLUDED.last_snapshot_id,
        last_changed_at  = CASE WHEN offer.fingerprint IS DISTINCT FROM EXCLUDED.fingerprint
                                THEN EXCLUDED.last_changed_at ELSE offer.last_changed_at END,
        fingerprint      = EXCLUDED.fingerprint,
        image_hash       = CASE WHEN offer.image_url IS DISTINCT FROM EXCLUDED.image_url
                                THEN NULL ELSE offer.image_hash END
    RETURNING id, external_id
), joined AS (
    SELECT u.id, u.external_id, s.price, s.old_price, s.in_stock, s.fingerprint,
           p.id AS prev_id, p.fingerprint AS prev_fp, p.current_price AS prev_price,
           p.list_price AS prev_list, p.in_stock AS prev_stock, p.is_active AS prev_active
      FROM up u JOIN feed_stage s ON s.external_id = u.external_id
      LEFT JOIN prev p ON p.id = u.id
), pp AS (
    INSERT INTO price_point (offer_id, observed_at, price, list_price, in_stock)
    SELECT id, %(observed_at)s, price, old_price, in_stock FROM joined
     WHERE prev_id IS NULL OR NOT prev_active
        OR prev_price IS DISTINCT FROM price OR prev_list IS DISTINCT FROM old_price
        OR prev_stock IS DISTINCT FROM in_stock
    ON CONFLICT (offer_id, observed_at) DO NOTHING
    RETURNING 1
), ob AS (
    INSERT INTO search_outbox (entity, entity_id, op, reason)
    SELECT 'offer', id, 'upsert',
           CASE WHEN prev_id IS NULL THEN 'feed_insert'
                WHEN NOT prev_active THEN 'feed_reactivate' ELSE 'feed_change' END
      FROM joined
     WHERE prev_id IS NULL OR NOT prev_active OR prev_fp IS DISTINCT FROM fingerprint
    RETURNING 1
), mem AS (
    INSERT INTO feed_source_offer
        (feed_source_id, offer_id, last_snapshot_id, first_seen_at, last_seen_at)
    SELECT %(feed_source_id)s, id, %(snapshot_id)s, %(observed_at)s, %(observed_at)s FROM joined
    ON CONFLICT (feed_source_id, offer_id) DO UPDATE SET
        last_snapshot_id = EXCLUDED.last_snapshot_id, last_seen_at = EXCLUDED.last_seen_at
    RETURNING 1
)
, ch AS (
    SELECT id, external_id FROM joined
     WHERE prev_id IS NULL OR prev_fp IS DISTINCT FROM fingerprint
)
SELECT count(*) FILTER (WHERE prev_id IS NULL),
       count(*) FILTER (WHERE prev_id IS NOT NULL AND prev_fp IS DISTINCT FROM fingerprint),
       count(*) FILTER (WHERE prev_id IS NOT NULL AND NOT prev_active),
       (SELECT count(*) FROM pp),
       (SELECT count(*) FROM ob),
       (SELECT count(*) FROM mem),
       (SELECT coalesce(array_agg(id ORDER BY id), '{}') FROM ch),
       (SELECT coalesce(array_agg(external_id ORDER BY id), '{}') FROM ch)
  FROM joined
"""

#: Kapi gecen tam surumden sonra: bu beslemede artik olmayan offer'larin UYELIGI
#: silinir. Offer'in kendisine burada dokunulmaz.
DROP_MEMBERSHIP = """
DELETE FROM feed_source_offer
 WHERE feed_source_id = %(feed_source_id)s AND last_snapshot_id <> %(snapshot_id)s
"""

#: Hicbir etkin/duraklatilmis beslemede uyeligi kalmayan VE bekleme suresinden
#: uzun suredir gorulmeyen besleme offer'lari pasiflesir (silme yok). Bekleme:
#: urun bir beslemeden digerine gecerken (fiyat bandi degisti) siradaki besleme
#: henuz islenmemis olabilir; o arada pasiflesmez.
SWEEP_CANDIDATES = """
SELECT o.id FROM offer o
 WHERE o.merchant_id = %(merchant_id)s AND o.feed_source_id IS NOT NULL AND o.is_active
   AND o.last_seen_at < %(cutoff)s
   AND NOT EXISTS (
       SELECT 1 FROM feed_source_offer m JOIN feed_source f ON f.id = m.feed_source_id
        WHERE m.offer_id = o.id AND f.status IN ('active', 'paused'))
"""

SWEEP = """
WITH d AS (
    UPDATE offer o SET is_active = FALSE, deactivated_at = %(observed_at)s,
                       deactivation_reason = 'missing_from_snapshot'
     WHERE o.id = ANY(%(ids)s) AND o.is_active
    RETURNING o.id
), ob AS (
    INSERT INTO search_outbox (entity, entity_id, op, reason)
    SELECT 'offer', id, 'delete', 'feed_missing' FROM d
    RETURNING 1
)
SELECT count(*) FROM d
"""

ACTIVE_FEED_OFFERS = """
SELECT count(*) FROM offer
 WHERE merchant_id = %(merchant_id)s AND feed_source_id IS NOT NULL AND is_active
"""

INSERT_ERRORS = """
INSERT INTO ingest_error (feed_source_id, snapshot_id, run_id, record_ref, external_id,
                          error_code, detail)
SELECT %(feed_source_id)s, %(snapshot_id)s, %(run_id)s, r.ref, r.ext, r.code, r.detail
  FROM unnest(%(refs)s::text[], %(exts)s::text[], %(codes)s::text[], %(details)s::text[])
       AS r(ref, ext, code, detail)
"""


# ---------------------------------------------------------------------------
# Yardimcilar
# ---------------------------------------------------------------------------


def _chunks(records: Iterator[FeedRecord], size: int) -> Iterator[tuple[int, list[FeedRecord]]]:
    batch: list[FeedRecord] = []
    for record in records:
        batch.append(record)
        if len(batch) == size:
            yield batch[0].index // size, batch
            batch = []
    if batch:
        yield batch[0].index // size, batch


def _busy(conn: psycopg.Connection) -> int:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM pg_stat_activity "
            "WHERE state = 'active' AND backend_type = 'client backend' AND pid <> pg_backend_pid()"
        )
        row = cur.fetchone()
    return int(row[0]) if row else 0


@dataclass
class FeedRow:
    id: int
    network: str
    external_id: str
    status: str
    format: str | None
    currency: str | None
    config: dict[str, Any]
    schema_fingerprint: str | None
    merchant_id: int | None
    merchant_active: bool | None
    source_updated_at: datetime | None
    last_success_at: datetime | None
    parser: str = field(init=False)

    def __post_init__(self) -> None:
        self.parser = str(self.config.get("parser") or self.format or "xml")


def load_feed(conn: psycopg.Connection, feed_source_id: int) -> FeedRow:
    with conn.cursor() as cur:
        cur.execute(LOAD_FEED, (feed_source_id,))
        row = cur.fetchone()
    if row is None:
        raise SyncAborted("feed_not_found")
    return FeedRow(*row)


# ---------------------------------------------------------------------------
# Senkronizasyon
# ---------------------------------------------------------------------------


class FeedSync:
    def __init__(
        self,
        conn: psycopg.Connection,
        feed_source_id: int,
        *,
        network: FeedNetwork | None = None,
        source_path: Path | None = None,
        settings: SyncSettings | None = None,
        max_records: int | None = None,
        observed_at: datetime | None = None,
        sleep: Callable[[float], None] = time.sleep,
        fail_after_chunks: int | None = None,
    ) -> None:
        self.conn = conn
        self.feed_source_id = feed_source_id
        self.network = network
        self.source_path = source_path
        self.max_records = max_records
        self.observed_at = observed_at or datetime.now(UTC)
        self.sleep = sleep
        self.report = SyncReport(feed_source_id)
        self._settings = settings
        # Yalnizca testler: cokme benzetimi (kaldigi yerden devam kaniti).
        self._fail_after_chunks = fail_after_chunks

    # -- kayitlar --------------------------------------------------------------
    def _exec(self, sql: str, params: Any = None) -> Any:
        with self.conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchone() if cur.description else None

    def _start_run(self, feed: FeedRow) -> int:
        row = self._exec(
            """INSERT INTO ingest_run (merchant_id, feed_source_id, status, updated_at)
               VALUES (%s, %s, 'running', now()) RETURNING id""",
            (feed.merchant_id, feed.id),
        )
        self.conn.commit()
        return int(row[0])

    def _finish_run(
        self, status: str, error: str | None = None, retry_in: timedelta | None = None
    ) -> None:
        r = self.report
        self._exec(
            """UPDATE ingest_run SET finished_at = now(), status = %s, offers_seen = %s,
                      offers_created = %s, offers_updated = %s, offers_unchanged = %s,
                      offers_deactivated = %s, records_rejected = %s,
                      price_points_written = %s, snapshot_id = %s, error_text = %s,
                      next_retry_at = %s, updated_at = now()
                WHERE id = %s""",
            (
                status,
                r.records,
                r.created,
                r.changed,
                r.unchanged,
                r.deactivated,
                r.rejected,
                r.price_points,
                r.snapshot_id,
                error,
                (datetime.now(UTC) + retry_in) if retry_in else None,
                r.run_id,
            ),
        )
        self.conn.commit()

    # -- ana akis --------------------------------------------------------------
    def run(self, *, force: bool = False) -> SyncReport:
        feed = load_feed(self.conn, self.feed_source_id)
        self.conn.rollback()
        settings = self._settings or SyncSettings.from_config(feed.config)
        self._settings = settings
        if feed.status != "active" or feed.merchant_id is None:
            raise SyncAborted("feed_not_active", "besleme etkin degil ya da merchant'a bagli degil")
        # Karar 0114: TRY disi teklifler orijinal para birimiyle saklanir ve yalnizca
        # "Yurt disi teklifleri" yuzeyinde (yaklasik TL ile) gorunur; cozumleyici
        # onlari urune baglamaz (resolve/pipeline.py), TL gibi gosterilemezler.
        unchanged_source = (
            feed.source_updated_at is not None
            and feed.last_success_at is not None
            and feed.source_updated_at <= feed.last_success_at
        )
        if not force and unchanged_source:
            # Kaynagin ilan ettigi guncelleme zamani imlectir: degismediyse indirme yok.
            self.report.status = "skipped"
            self.report.gate = "source_unchanged"
            return self.report

        locked = self._exec("SELECT pg_try_advisory_lock(%s, %s)", (LOCK_NAMESPACE, feed.id))
        self.conn.commit()
        if not locked or not locked[0]:
            raise SyncAborted("feed_locked", "bu besleme zaten isleniyor")
        try:
            # Kilit bizde: bu beslemenin 'running' kalmis kosulari olmus surecin
            # (OOM, yeniden baslatma) kalintisidir.
            self._exec(
                """UPDATE ingest_run SET status = 'failed', finished_at = now(),
                          error_text = 'interrupted', updated_at = now()
                    WHERE feed_source_id = %s AND status = 'running'""",
                (feed.id,),
            )
            self.conn.commit()
            self.report.run_id = self._start_run(feed)
            try:
                self._sync(feed, settings)
            except Exception as error:
                self.conn.rollback()
                code = getattr(error, "code", None) or type(error).__name__
                self.report.status = "failed"
                self.report.error_code = str(code)[:60]
                retry = None
                if isinstance(error, DownloadError) and error.retryable:
                    retry = timedelta(minutes=30)
                if isinstance(error, NetworkUnavailable):
                    retry = timedelta(minutes=30)
                self._exec(
                    """UPDATE feed_source SET last_error_at = now(), last_error_code = %s,
                              updated_at = now() WHERE id = %s""",
                    (_error_code(code), feed.id),
                )
                if self.report.snapshot_id and not isinstance(error, _Crash):
                    self._exec(
                        "UPDATE source_snapshot SET status = 'failed'"
                        " WHERE id = %s AND status = 'processing'",
                        (self.report.snapshot_id,),
                    )
                self._finish_run("failed", _error_code(code), retry)
                raise
        finally:
            self._exec("SELECT pg_advisory_unlock(%s, %s)", (LOCK_NAMESPACE, feed.id))
            self.conn.commit()
        return self.report

    def _acquire(self, feed: FeedRow, settings: SyncSettings) -> tuple[Path, str, int]:
        if self.source_path is not None:
            # Yerel dosya (testler, elle dogrulama): ozet cozulmus icerikten.
            digest = hashlib.sha256()
            with open_decoded(self.source_path) as stream:
                for block in iter(lambda: stream.read(1 << 20), b""):
                    digest.update(block)
            return self.source_path, digest.hexdigest(), self.source_path.stat().st_size
        if self.network is None:
            raise SyncAborted("network_missing")
        directory = staging_dir()
        cleanup_staging(directory)
        url = self.network.download_url(feed.external_id)
        target = directory / f"feed-{feed.id}-{self.observed_at:%Y%m%dT%H%M%S}.bin"
        last: DownloadError | None = None
        for attempt in range(1, settings.download_attempts + 1):
            try:
                # Ornek kipi (--max-records): dosyanin yalnizca basi indirilir.
                stop_after = None
                if self.max_records is not None:
                    stop_after = int(env("FEED_SAMPLE_BYTES") or 64 << 20)
                result = download(url, target, stop_after_bytes=stop_after)
                return result.path, result.sha256, result.bytes_on_disk
            except DownloadError as error:
                last = error
                if not error.retryable or attempt == settings.download_attempts:
                    raise
                self.sleep(min(30.0, 2.0**attempt))
        assert last is not None
        raise last

    def _snapshot(self, feed: FeedRow, sha: str, size: int, path: Path) -> tuple[int, bool]:
        """(snapshot_id, duplicate). Ayni sha ile yarim surum varsa onu dondurur."""
        # Yalnizca EN SON tam surumle karsilastirilir: icerik A -> B -> A
        # dondugunde ikinci A islenir (aradaki deaktivasyonlar geri alinir).
        latest = self._exec(
            """SELECT sha256 FROM source_snapshot WHERE feed_source_id = %s AND status = 'complete'
                ORDER BY completed_at DESC NULLS LAST, id DESC LIMIT 1""",
            (feed.id,),
        )
        if latest and latest[0] == sha:
            dup = self._exec(
                """INSERT INTO source_snapshot (feed_source_id, status, sha256, bytes, completed_at)
                   VALUES (%s, 'duplicate', %s, %s, now()) RETURNING id""",
                (feed.id, sha, size),
            )
            self.conn.commit()
            return int(dup[0]), True
        row = self._exec(
            """SELECT id FROM source_snapshot WHERE feed_source_id = %s AND sha256 = %s
                 AND status = 'processing' ORDER BY id DESC LIMIT 1""",
            (feed.id, sha),
        )
        # Baska icerikle yarim kalmis surumler artik gecersiz.
        self._exec(
            """UPDATE source_snapshot SET status = 'failed'
                WHERE feed_source_id = %s AND status IN ('downloading','downloaded','processing')
                  AND (sha256 IS DISTINCT FROM %s)""",
            (feed.id, sha),
        )
        if row:
            self.conn.commit()
            return int(row[0]), False
        new = self._exec(
            """INSERT INTO source_snapshot (feed_source_id, status, sha256, bytes, storage_key)
               VALUES (%s, 'processing', %s, %s, %s) RETURNING id""",
            (feed.id, sha, size, path.name[:1000]),
        )
        self.conn.commit()
        return int(new[0]), False

    def _sync(self, feed: FeedRow, settings: SyncSettings) -> None:
        path, sha, size = self._acquire(feed, settings)
        snapshot_id, duplicate = self._snapshot(feed, sha, size, path)
        self.report.snapshot_id = snapshot_id
        if duplicate:
            self.report.status = "duplicate"
            # Icerik ayni kalsa da bekleme suresi dolan (onceki tam surumde
            # cikarilmis) offer'lar pasiflesir; uyelikler zaten guncel.
            if self._sweep(feed, settings) == "partial":
                self.report.status = "partial"
            self._exec(
                "UPDATE feed_source SET last_success_at = now(), updated_at = now() WHERE id = %s",
                (feed.id,),
            )
            self._finish_run(
                "success" if self.report.status == "duplicate" else "partial", self.report.gate
            )
            self._cleanup(path)
            return

        merged_chunks = {
            r[0]
            for r in self._fetchall(
                "SELECT seq FROM ingest_chunk WHERE snapshot_id = %s AND status = 'merged'",
                (snapshot_id,),
            )
        }
        self.conn.commit()

        parse = ParseResult()
        source = iter_records(path, feed.parser, feed.config, parse)
        records: Iterator[FeedRecord] = source
        if self.max_records is not None:
            records = _take(records, self.max_records)
        keys: set[str] = set()
        required = list(feed.config.get("required_fields") or DEFAULT_REQUIRED.get(feed.parser, []))
        errors_logged = 0
        processed_chunks = 0

        with self.conn.cursor() as cur:
            cur.execute(STAGE_DDL)
        self.conn.commit()

        try:
            for seq, batch in _chunks(records, settings.chunk_size):
                if len(keys) < 10_000 and batch[0].index < settings.schema_sample:
                    for record in batch[: settings.schema_sample]:
                        keys |= schema_fields(record)
                    missing = [f for f in required if f not in keys]
                    if missing:
                        raise SyncAborted("schema_missing_fields", ",".join(missing))

                offers: dict[str, FeedOffer] = {}
                rejects: list[tuple[str, str | None, str, str]] = []
                for record in batch:
                    try:
                        offer = normalize(
                            record,
                            feed.config,
                            expected_currency=feed.currency,
                            categories=parse.categories,
                        )
                    except Rejected as error:
                        raw_id = record.fields.get("@id")
                        ext = raw_id if isinstance(raw_id, str) else None
                        rejects.append((record.ref, ext, error.code, error.detail))
                        continue
                    # Ayni parcada tekrar eden kimlik: son gelen kazanir.
                    offers[offer.external_id] = offer

                self.report.records += len(batch)
                self.report.rejected += len(rejects)
                if seq in merged_chunks:
                    self.report.chunks_skipped += 1
                    continue

                log_now = rejects[: max(0, settings.max_errors_logged - errors_logged)]
                errors_logged += len(log_now)
                self._merge_chunk(feed, snapshot_id, seq, batch, offers, log_now)
                processed_chunks += 1
                self.report.chunks_merged += 1
                if (
                    self._fail_after_chunks is not None
                    and processed_chunks >= self._fail_after_chunks
                ):
                    raise _Crash("benzetilmis cokme")
                self._backpressure(settings)

        finally:
            # Ornek kipinde uretec sona kadar tuketilmez: dosya tutamaci acik kalmasin.
            source.close()
        fingerprint = schema_fingerprint(keys) if keys else None
        self._finish_snapshot(feed, settings, snapshot_id, parse, fingerprint, keys)
        self._cleanup(path)

    def _fetchall(self, sql: str, params: Any) -> list[tuple[Any, ...]]:
        with self.conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchall()

    def _merge_chunk(
        self,
        feed: FeedRow,
        snapshot_id: int,
        seq: int,
        batch: list[FeedRecord],
        offers: dict[str, FeedOffer],
        rejects: list[tuple[str, str | None, str, str]],
    ) -> None:
        params = {
            "merchant_id": feed.merchant_id,
            "feed_source_id": feed.id,
            "snapshot_id": snapshot_id,
            "observed_at": self.observed_at,
        }
        chunk_sha = hashlib.sha256(
            "\n".join(o.fingerprint() for o in offers.values()).encode()
        ).hexdigest()
        with self.conn.cursor() as cur:
            created = changed = reactivated = pp = ob = 0
            changed_ids: list[int] = []
            changed_ext: list[str] = []
            if offers:
                with cur.copy(f"COPY feed_stage ({STAGE_COLUMNS}) FROM STDIN") as copy:
                    for o in offers.values():
                        copy.write_row(
                            (
                                o.external_id,
                                o.title,
                                o.url,
                                o.price_minor,
                                o.old_price_minor,
                                o.currency,
                                o.in_stock,
                                o.category_path,
                                o.seller_external_id,
                                o.brand,
                                o.image_url,
                                o.affiliate_url,
                                json.dumps(_attributes(o), ensure_ascii=False),
                                o.fingerprint(),
                            )
                        )
                cur.execute(UPSERT_SELLERS, params)
                cur.execute(MERGE, params)
                row = cur.fetchone()
                assert row is not None
                created, changed, reactivated, pp, ob, _mem, changed_ids, changed_ext = row
                images: list[tuple[int, tuple[SelectedImage, ...]]] = [
                    (oid, offers[ext].images)
                    for oid, ext in zip(changed_ids, changed_ext, strict=True)
                ]
                if images:
                    write_offer_images(self.conn, images)
            if rejects:
                cur.execute(
                    INSERT_ERRORS,
                    {
                        "feed_source_id": feed.id,
                        "snapshot_id": snapshot_id,
                        "run_id": self.report.run_id,
                        "refs": [r[0][:200] for r in rejects],
                        "exts": [(r[1] or "")[:200] or None for r in rejects],
                        "codes": [r[2] for r in rejects],
                        "details": [r[3][:1000] or None for r in rejects],
                    },
                )
            cur.execute(
                """INSERT INTO ingest_chunk (snapshot_id, seq, record_start, record_count, sha256,
                                             status, attempts, merged_at)
                   VALUES (%s, %s, %s, %s, %s, 'merged', 1, now())
                   ON CONFLICT (snapshot_id, seq) DO UPDATE SET status = 'merged',
                       attempts = ingest_chunk.attempts + 1, merged_at = now(),
                       sha256 = EXCLUDED.sha256, record_count = EXCLUDED.record_count""",
                (snapshot_id, seq, batch[0].index, len(batch), chunk_sha),
            )
            r = self.report
            r.created += created
            r.changed += changed
            r.reactivated += reactivated
            r.unchanged += len(offers) - created - changed
            r.price_points += pp
            r.outbox += ob
            cur.execute(
                """UPDATE ingest_run SET checkpoint = %s::jsonb, snapshot_id = %s,
                          offers_seen = %s, offers_created = %s, offers_updated = %s,
                          offers_unchanged = %s, records_rejected = %s,
                          price_points_written = %s, updated_at = now()
                    WHERE id = %s""",
                (
                    json.dumps({"snapshot_id": snapshot_id, "chunk": seq, "records": r.records}),
                    snapshot_id,
                    r.records,
                    r.created,
                    r.changed,
                    r.unchanged,
                    r.rejected,
                    r.price_points,
                    r.run_id,
                ),
            )
        self.conn.commit()

    def _backpressure(self, settings: SyncSettings) -> None:
        self.sleep(settings.pause_ms / 1000)
        for _ in range(5):
            if _busy(self.conn) <= settings.busy_connections:
                break
            self.sleep(settings.busy_wait_seconds)
        self.conn.commit()

    def _gate(self, feed: FeedRow, settings: SyncSettings, parse: ParseResult) -> str | None:
        r = self.report
        if self.max_records is not None:
            return "sample_limit"
        if not parse.complete:
            return "truncated"
        if r.records == 0:
            return "empty"
        if r.rejected / r.records > settings.max_reject_ratio:
            return "error_rate"
        previous = [
            int(row[0])
            for row in self._fetchall(
                """SELECT record_count FROM source_snapshot
                    WHERE feed_source_id = %s AND status = 'complete' AND record_count IS NOT NULL
                    ORDER BY completed_at DESC LIMIT 3""",
                (feed.id,),
            )
        ]
        if previous and r.records < settings.min_ratio_vs_median * statistics.median(previous):
            return "too_few_records"
        return None

    def _finish_snapshot(
        self,
        feed: FeedRow,
        settings: SyncSettings,
        snapshot_id: int,
        parse: ParseResult,
        fingerprint: str | None,
        keys: set[str],
    ) -> None:
        r = self.report
        gate = self._gate(feed, settings, parse)
        r.gate = gate
        status = "partial"
        if gate is None:
            snapshot_status = "complete"
            status = self._deactivate(feed, settings, snapshot_id)
        else:
            snapshot_status = "rejected"

        self._exec(
            """UPDATE source_snapshot SET status = %s, record_count = %s, rejected_count = %s,
                      schema_fingerprint = %s, reject_reason = %s, completed_at = now()
                WHERE id = %s""",
            (snapshot_status, r.records, r.rejected, fingerprint, gate, snapshot_id),
        )
        if fingerprint and feed.schema_fingerprint and fingerprint != feed.schema_fingerprint:
            r.schema_changed = True
            logger.warning("besleme %s: sema degisti", feed.id)
        self._exec(
            """UPDATE feed_source SET
                   schema_fingerprint = COALESCE(%(fp)s, schema_fingerprint),
                   schema_fields = COALESCE(%(fields)s::jsonb, schema_fields),
                   schema_changed_at = CASE WHEN %(changed)s THEN now() ELSE schema_changed_at END,
                   last_success_at = CASE WHEN %(ok)s THEN now() ELSE last_success_at END,
                   last_error_at = CASE WHEN %(ok)s THEN last_error_at ELSE now() END,
                   last_error_code = CASE WHEN %(ok)s THEN NULL ELSE %(gate)s END,
                   updated_at = now()
                WHERE id = %(id)s""",
            {
                "fp": fingerprint,
                "fields": json.dumps(sorted(keys)[:500]) if keys else None,
                "changed": r.schema_changed,
                "ok": snapshot_status == "complete",
                "gate": r.gate,
                "id": feed.id,
            },
        )
        r.status = status
        self._finish_run(status, r.gate)

    def _deactivate(self, feed: FeedRow, settings: SyncSettings, snapshot_id: int) -> str:
        r = self.report
        total, stale = self._exec(
            """SELECT count(*), count(*) FILTER (WHERE last_snapshot_id <> %s)
                 FROM feed_source_offer WHERE feed_source_id = %s""",
            (snapshot_id, feed.id),
        )
        if total and stale > settings.max_deactivate_ratio * total:
            r.gate = "deactivation_cap"
            return "partial"
        self._exec(DROP_MEMBERSHIP, {"feed_source_id": feed.id, "snapshot_id": snapshot_id})
        return self._sweep(feed, settings)

    def _sweep(self, feed: FeedRow, settings: SyncSettings) -> str:
        """Uyeligi kalmamis ve bekleme suresi dolmus offer'lari pasiflestirir."""
        r = self.report
        cutoff = self.observed_at - timedelta(hours=settings.deactivate_grace_hours)
        ids = [
            int(row[0])
            for row in self._fetchall(
                SWEEP_CANDIDATES, {"merchant_id": feed.merchant_id, "cutoff": cutoff}
            )
        ]
        if ids:
            active = self._exec(ACTIVE_FEED_OFFERS, {"merchant_id": feed.merchant_id})[0]
            if len(ids) > settings.max_deactivate_ratio * max(int(active), 1):
                r.gate = "deactivation_cap"
                return "partial"
            r.deactivated = int(self._exec(SWEEP, {"ids": ids, "observed_at": self.observed_at})[0])
        return "success"

    def _cleanup(self, path: Path) -> None:
        if self.source_path is None:
            path.unlink(missing_ok=True)


class _Crash(RuntimeError):
    """Test: parca birlestirildikten sonra cokme."""

    code = "simulated_crash"


def _take(records: Iterator[FeedRecord], limit: int) -> Iterator[FeedRecord]:
    for record in records:
        if record.index >= limit:
            return
        yield record


def _attributes(offer: FeedOffer) -> dict[str, str]:
    attributes = dict(offer.attributes)
    if offer.gtin:
        attributes["gtin"] = offer.gtin
    if offer.mpn:
        attributes["mpn"] = offer.mpn
    return attributes


def _error_code(code: object) -> str:
    text = "".join(ch if ch.isalnum() else "_" for ch in str(code).lower()).strip("_")
    return (text or "error")[:60] if len(text) >= 2 else "error"
