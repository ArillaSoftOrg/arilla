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
   INSERT) -> `search_outbox` -> uyelik -> bayat embedding silme (gorsel ya da
   kanonik metin degisti) -> bagli urunlerin fiyat ozeti -> `ingest_chunk = merged` ->
   `ingest_run` kontrol noktasi. Reddedilen kayitlar `ingest_error`'a.
4a. YAZMADAN ONCE butunluk (karar 0152): indirilen dosya veritabanina tek satir
   yazilmadan taranir (`feeds.integrity`): kapanis etiketi, her `<offer>` icin bir
   `</offer>`, en az bir kayit; ayrica kayit sayisi son tam surumlerin medyaninin
   `min_ratio_vs_median` (%85) altindaysa karantina (`too_few_records`). Gecmezse surum
   `rejected`, HICBIR offer/price_point/uyelik yazilmaz, dosya silinir. Kesik dosya
   (`truncated`) yeniden denenir; ayni icerik `drop_confirm_hours` sonra yine gelirse
   mesru kuculme sayilir ve kabul edilir (kalici engel yok).
5. Tamlik kapisi (yazimdan sonra, onlem): dosya sonuna hatasiz ulasildi, red orani
   esigin altinda, kayit sayisi son tam surumlerin medyaninin %85'inden az degil.
   Gecmezse surum `rejected`: birlestirilen kayitlar kalir, HICBIR offer pasiflesmez.
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
import queue
import statistics
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import psycopg

from collect.image_writer import write_offer_images
from collect.images import SelectedImage
from db import product_aggregates
from db.connection import env
from enrich import text as text_builder
from feeds import integrity
from feeds.download import (
    DownloadError,
    cleanup_staging,
    diagnostics_path,
    download,
    read_diagnostics,
    staging_dir,
)
from feeds.network import FeedNetwork, NetworkUnavailable
from feeds.normalize import FeedOffer, Rejected, normalize, schema_fields, schema_fingerprint
from feeds.parsers import FeedRecord, ParseResult, iter_records

logger = logging.getLogger(__name__)

LOCK_NAMESPACE = 4301
DEFAULT_REQUIRED = {
    "yml": ["@id", "name", "url", "price"],
}


@dataclass(frozen=True)
class SyncSettings:
    #: Olcum (karar 0114): 1000 -> 5000, 50 bin kayitta birlestirme 18,8 -> 15,0 sn.
    chunk_size: int = 5000
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
    #: Arsivlenmemis WAL bu sinirin ustundeyse parcalar arasinda beklenir.
    max_archive_lag_bytes: int = 1 << 30
    archive_poll_seconds: float = 5.0
    #: Bu kadar beklemede dusmezse senkronizasyon guvenle durur (kaldigi yerden devam).
    max_archive_wait_seconds: float = 1800.0
    download_attempts: int = 3
    #: Boyut dususu nedeniyle karantinaya alinan AYNI icerik (sha256) bu kadar saat sonra
    #: yine gelirse mesru kuculme sayilir ve islenir (karar 0152).
    drop_confirm_hours: float = 6.0

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
                "drop_confirm_hours",
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
    stale_image_embeddings: int = 0
    stale_text_embeddings: int = 0
    aggregates_updated: int = 0
    outbox: int = 0
    chunks_merged: int = 0
    chunks_skipped: int = 0
    gate: str | None = None
    #: Asama sureleri (sn): darbogaz teshisi (karar 0114).
    reused_download: bool = False
    archive_wait_seconds: float = 0.0
    parse_error: str | None = None
    seconds_normalize: float = 0.0
    seconds_merge: float = 0.0
    seconds_parse_and_wait: float = 0.0
    schema_changed: bool = False
    error_code: str | None = None
    #: Yazmadan onceki tarama (karar 0152): dosyadaki tam kayit sayisi ve sure.
    records_in_file: int = 0
    integrity_seconds: float = 0.0
    #: Boyut dususu daha once karantinaya alinmis ayni icerikle dogrulandi ve kabul edildi.
    drop_confirmed: bool = False

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

# Karar 0114 (olcum): ON CONFLICT DO UPDATE kosul tutmasa da satiri KILITLER ve
# kilit WAL'a yazilir (checkpoint sonrasi tam sayfa). Bu yuzden yalnizca YENI saticilar
# eklenir (DO NOTHING kilitlemez); goruldu bilgisi gunde en fazla bir kez guncellenir.
UPSERT_SELLERS = """
WITH incoming AS (
    SELECT DISTINCT seller_ext FROM feed_stage WHERE seller_ext IS NOT NULL
), ins AS (
    INSERT INTO seller (merchant_id, external_id)
    SELECT %(merchant_id)s, i.seller_ext FROM incoming i
     WHERE NOT EXISTS (SELECT 1 FROM seller x
                        WHERE x.merchant_id = %(merchant_id)s AND x.external_id = i.seller_ext)
    ON CONFLICT (merchant_id, external_id) DO NOTHING
    RETURNING 1
)
UPDATE seller sl SET last_seen_at = now(), is_active = TRUE
  FROM incoming i
 WHERE sl.merchant_id = %(merchant_id)s AND sl.external_id = i.seller_ext
   AND (NOT sl.is_active OR sl.last_seen_at < now() - interval '1 day')
"""

MERGE = """
WITH prev AS (
    SELECT o.id, o.external_id, o.fingerprint, o.current_price, o.list_price, o.in_stock,
           o.is_active, o.image_url, o.feed_source_id, o.affiliate_url,
           o.title_raw, o.brand_raw, o.category_raw, o.product_id
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
      LEFT JOIN prev pv ON pv.external_id = s.external_id
     -- Degismeyen kayit upsert'e HIC girmez: ON CONFLICT kosulu tutmasa da satiri
     -- kilitler ve WAL uretir (olcum: 50 bin degismemis kayitta 51 MB tam sayfa).
     WHERE pv.id IS NULL
        OR pv.fingerprint IS DISTINCT FROM s.fingerprint
        OR NOT pv.is_active
        OR pv.feed_source_id IS NULL
        OR pv.affiliate_url IS DISTINCT FROM s.affiliate_url
     -- Tutarli kilit sirasi: es zamanli iki besleme ayni teklifleri guncellerse kilitlenme olmasin.
     ORDER BY s.external_id
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
    -- Karar 0114 (olcum): DEGISMEYEN satir yeniden yazilmaz. 50 bin degismemis kayitta
    -- 343 MB WAL ve tablo sismesi olcmustuk. "Goruldu" bilgisi dar uyelik satirindadir
    -- (feed_source_offer.last_seen_at); uyelik duserken offer.last_seen_at'e aktarilir.
    WHERE offer.fingerprint IS DISTINCT FROM EXCLUDED.fingerprint
       OR NOT offer.is_active
       OR offer.feed_source_id IS NULL
       OR offer.affiliate_url IS DISTINCT FROM EXCLUDED.affiliate_url
    RETURNING id, external_id
), allrows AS (
    SELECT id, external_id FROM up
    UNION ALL
    SELECT p.id, p.external_id FROM prev p WHERE NOT EXISTS (SELECT 1 FROM up u WHERE u.id = p.id)
), joined AS (
    SELECT a.id, a.external_id, s.price, s.old_price, s.in_stock, s.fingerprint,
           s.title, s.brand, s.category_path,
           p.id AS prev_id, p.fingerprint AS prev_fp, p.current_price AS prev_price,
           p.list_price AS prev_list, p.in_stock AS prev_stock, p.is_active AS prev_active,
           p.image_url AS prev_image, s.image_url, p.title_raw AS prev_title,
           p.brand_raw AS prev_brand, p.category_raw AS prev_category, p.product_id
      FROM allrows a JOIN feed_stage s ON s.external_id = a.external_id
      LEFT JOIN prev p ON p.id = a.id
), pp AS (
    INSERT INTO price_point (offer_id, observed_at, price, list_price, in_stock)
    SELECT id, %(observed_at)s, price, old_price, in_stock FROM joined
     WHERE prev_id IS NULL OR NOT prev_active
        OR prev_price IS DISTINCT FROM price OR prev_list IS DISTINCT FROM old_price
        OR prev_stock IS DISTINCT FROM in_stock
    ON CONFLICT (offer_id, observed_at) DO NOTHING
    RETURNING 1
), ob AS (
    -- Karar 0146: arama olayi yalniz aramanin/indeksin gorecegi icerik degisince yazilir
    -- (ekleme, yeniden etkinlesme, baslik/marka/kategori/gorsel). Fiyat, eski fiyat, stok,
    -- indirim ve komisyon degisimi `price_point`'ta ve offer satirindadir; her biri icin
    -- olay yazmak gunluk tam senkronizasyonda milyonlarca gereksiz satir uretirdi.
    INSERT INTO search_outbox (entity, entity_id, op, reason)
    SELECT 'offer', id, 'upsert',
           CASE WHEN prev_id IS NULL THEN 'feed_insert'
                WHEN NOT prev_active THEN 'feed_reactivate' ELSE 'feed_change' END
      FROM joined
     WHERE prev_id IS NULL OR NOT prev_active
        OR (prev_fp IS DISTINCT FROM fingerprint
            AND (prev_title IS DISTINCT FROM title
                 OR prev_brand IS DISTINCT FROM brand
                 OR prev_category IS DISTINCT FROM category_path
                 OR prev_image IS DISTINCT FROM image_url))
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
), ed AS (
    -- Degisen MEVCUT teklifler ve onceki metin/gorsel: bayat embedding'i cagiran
    -- toplama yaziciyla ayni kuralla secer (kanonik metin Python'da kurulur).
    SELECT id, external_id, prev_image IS DISTINCT FROM image_url AS image_changed,
           prev_title, prev_brand, prev_category
      FROM joined
     WHERE prev_id IS NOT NULL AND prev_fp IS DISTINCT FROM fingerprint
)
SELECT count(*) FILTER (WHERE prev_id IS NULL),
       count(*) FILTER (WHERE prev_id IS NOT NULL AND prev_fp IS DISTINCT FROM fingerprint),
       count(*) FILTER (WHERE prev_id IS NOT NULL AND NOT prev_active),
       (SELECT count(*) FROM pp),
       (SELECT count(*) FROM ob),
       (SELECT count(*) FROM mem),
       (SELECT coalesce(array_agg(id ORDER BY id), '{}') FROM ch),
       (SELECT coalesce(array_agg(external_id ORDER BY id), '{}') FROM ch),
       (SELECT coalesce(array_agg(id ORDER BY id), '{}') FROM ed),
       (SELECT coalesce(array_agg(external_id ORDER BY id), '{}') FROM ed),
       (SELECT coalesce(array_agg(image_changed ORDER BY id), '{}') FROM ed),
       (SELECT coalesce(array_agg(prev_title ORDER BY id), '{}') FROM ed),
       (SELECT coalesce(array_agg(prev_brand ORDER BY id), '{}') FROM ed),
       (SELECT coalesce(array_agg(prev_category ORDER BY id), '{}') FROM ed),
       -- Fiyat ozeti etkilenebilecek bagli urunler (fiyat/stok/para birimi parmak izinde).
       (SELECT coalesce(array_agg(DISTINCT product_id), '{}') FROM joined
         WHERE product_id IS NOT NULL AND (NOT prev_active OR prev_fp IS DISTINCT FROM fingerprint))
  FROM joined
"""

#: Gorseli ya da kanonik metni degisen teklifin eski vektoru: enrich eksik sayip
#: yeniden uretir (toplama yazicisinin `DELETE_STALE_EMBEDDINGS` kurali).
DELETE_STALE_EMBEDDINGS = """
DELETE FROM embedding
 WHERE target_type = 'offer' AND kind = %(kind)s AND target_id = ANY(%(offer_ids)s::bigint[])
"""

#: Kapi gecen tam surumden sonra: bu beslemede artik olmayan offer'larin UYELIGI
#: silinir. Offer'in kendisine burada dokunulmaz.
DROP_MEMBERSHIP = """
WITH gone AS (
    DELETE FROM feed_source_offer
     WHERE feed_source_id = %(feed_source_id)s AND last_snapshot_id <> %(snapshot_id)s
    RETURNING offer_id, last_seen_at
)
-- Degismeyen offer satiri yazilmadigi icin son gorulme uyelikteydi: bekleme suresi
-- dogru islesin diye offer'a aktarilir (yalnizca daha yeniyse).
UPDATE offer o SET last_seen_at = g.last_seen_at
  FROM gone g
 WHERE o.id = g.offer_id AND o.last_seen_at < g.last_seen_at
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
    RETURNING o.id, o.product_id
), ob AS (
    INSERT INTO search_outbox (entity, entity_id, op, reason)
    SELECT 'offer', id, 'delete', 'feed_missing' FROM d
    RETURNING 1
)
SELECT count(*),
       coalesce(array_agg(DISTINCT product_id) FILTER (WHERE product_id IS NOT NULL), '{}')
  FROM d
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


#: Son arsivlenen WAL dosyasinin bitisinden bugunku WAL konumuna kadar bayt.
#: Arsiv kapaliysa (yerel/CI) ya da hic arsivlenmemisse NULL -> beklenmez.
ARCHIVE_LAG = """
WITH last AS (
    SELECT ('x' || substr(a.last_archived_wal, 9, 8))::bit(32)::bigint AS log_id,
           ('x' || substr(a.last_archived_wal, 17, 8))::bit(32)::bigint AS seg_no,
           (SELECT setting::bigint FROM pg_settings WHERE name = 'wal_segment_size') AS seg_size
      FROM pg_stat_archiver a
     WHERE current_setting('archive_mode') <> 'off'
       AND a.last_archived_wal ~ '^[0-9A-F]{24}$'
)
SELECT pg_wal_lsn_diff(
           pg_current_wal_lsn(),
           '0/0'::pg_lsn + (log_id * 4294967296 + (seg_no + 1) * seg_size)::numeric
       )::bigint
  FROM last
"""


def _archive_lag_bytes(conn: psycopg.Connection) -> int | None:
    with conn.cursor() as cur:
        cur.execute(ARCHIVE_LAG)
        row = cur.fetchone()
    return int(row[0]) if row and row[0] is not None else None


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
        prefetched: tuple[Path, str, int] | None = None,
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
        #: `sync-due` paralel indirmesi: dosya onceden indirildi (yol, sha256, bayt).
        self.prefetched = prefetched
        #: Indirmenin izin listeli HTTP tanilamasi (`feeds.download.http_diagnostics`).
        #: `ingest_run.checkpoint`e eklenen tanilama: {"http": ..., "integrity": ...}.
        self._diagnostics: dict[str, object] = {}
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
            # Yerel dosya (testler, elle dogrulama, olcum): ozet ham dosya baytlarindan.
            # Kesik bir ornek dosya (or. besleme basi) burada cokmemeli; tamlik
            # karari ayristirmanindir (ParseResult.complete).
            digest = hashlib.sha256()
            with self.source_path.open("rb") as stream:
                for block in iter(lambda: stream.read(1 << 20), b""):
                    digest.update(block)
            return self.source_path, digest.hexdigest(), self.source_path.stat().st_size
        if self.prefetched is not None:
            return self.prefetched
        if self.network is None:
            raise SyncAborted("network_missing")
        directory = staging_dir()
        cleanup_staging(directory)
        reused = self._reusable_download(feed, directory)
        if reused is not None:
            return reused
        url = self.network.download_url(feed.external_id)
        sample = self.max_records is not None
        target = directory / staging_name(feed.id, self.observed_at, sample=sample)
        last: DownloadError | None = None
        for attempt in range(1, settings.download_attempts + 1):
            try:
                # Ornek kipi (--max-records): dosyanin yalnizca basi indirilir.
                stop_after = None
                if self.max_records is not None:
                    stop_after = sample_bytes(self.max_records, env("FEED_SAMPLE_BYTES"))
                result = download(url, target, stop_after_bytes=stop_after)
                return result.path, result.sha256, result.bytes_on_disk
            except DownloadError as error:
                last = error
                if not error.retryable or attempt == settings.download_attempts:
                    raise
                self.sleep(min(30.0, 2.0**attempt))
        assert last is not None
        raise last

    def _reusable_download(self, feed: FeedRow, directory: Path) -> tuple[Path, str, int] | None:
        """Yarim kalan (cokme/kesinti) surumun indirilmis dosyasi diskte duruyorsa ve
        kaynak o zamandan beri guncellenmediyse YENIDEN INDIRILMEZ (karar 0114:
        Admitad baglanti basina ~0,25-0,5 MB/s; 1 GB besleme ~1 saat). Ornek dosyasi
        (bilerek eksik) yalnizca ornek kosusunda, tam dosya yalnizca tam kosuda kullanilir.
        """
        row = self._exec(
            """SELECT storage_key, sha256, bytes, started_at FROM source_snapshot
                WHERE feed_source_id = %s AND status IN ('processing', 'failed')
                  AND storage_key IS NOT NULL AND sha256 IS NOT NULL
                  AND started_at > now() - interval '24 hours'
                ORDER BY id DESC LIMIT 1""",
            (feed.id,),
        )
        self.conn.commit()
        if row is None:
            return None
        key, sha, size, started_at = row
        sample = self.max_records is not None
        if key.endswith(SAMPLE_SUFFIX) != sample:
            return None
        if feed.source_updated_at is not None and feed.source_updated_at > started_at:
            return None
        path = directory / key
        if not path.is_file() or path.stat().st_size != size:
            return None
        self.report.reused_download = True
        return path, str(sha), int(size)

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
            if not feed.config.get("no_deactivate") and self._sweep(feed, settings) == "partial":
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

        if self._preflight(feed, settings, path, sha, snapshot_id):
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

        loop_started = time.perf_counter()

        def merge(item: tuple[int, list[FeedRecord], dict[str, FeedOffer], list[Any]]) -> None:
            nonlocal processed_chunks
            seq, batch, offers, log_now = item
            merge_started = time.perf_counter()
            self._merge_chunk(feed, snapshot_id, seq, batch, offers, log_now)
            self.report.seconds_merge += time.perf_counter() - merge_started
            processed_chunks += 1
            self.report.chunks_merged += 1
            if self._fail_after_chunks is not None and processed_chunks >= self._fail_after_chunks:
                raise _Crash("benzetilmis cokme")
            self._backpressure(settings)

        writer = _PipelinedWriter(merge)
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
                normalize_started = time.perf_counter()
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

                self.report.seconds_normalize += time.perf_counter() - normalize_started
                self.report.records += len(batch)
                self.report.rejected += len(rejects)
                if seq in merged_chunks:
                    self.report.chunks_skipped += 1
                    continue

                log_now = rejects[: max(0, settings.max_errors_logged - errors_logged)]
                errors_logged += len(log_now)
                # Birlestirme yardimci iş parcaciginda: ana akis bir SONRAKI parcayi
                # ayristirip normalize ederken PostgreSQL yaziyor (karar 0114).
                writer.submit((seq, batch, offers, log_now))
            writer.finish()

            r = self.report
            r.seconds_parse_and_wait = max(
                0.0,
                round(
                    time.perf_counter() - loop_started - r.seconds_normalize - r.seconds_merge, 2
                ),
            )
            r.seconds_normalize = round(r.seconds_normalize, 2)
            r.seconds_merge = round(r.seconds_merge, 2)
        finally:
            # Hata yolunda da yazici durdurulur; baglanti tekrar ana akisa gecer.
            writer.close()
            # Ornek kipinde uretec sona kadar tuketilmez: dosya tutamaci acik kalmasin.
            source.close()
        fingerprint = schema_fingerprint(keys) if keys else None
        self._finish_snapshot(feed, settings, snapshot_id, parse, fingerprint, keys)
        self._cleanup(path)

    # -- yazmadan onceki denetim (karar 0152) -----------------------------------
    def _preflight(
        self, feed: FeedRow, settings: SyncSettings, path: Path, sha: str, snapshot_id: int
    ) -> bool:
        """Dosyayi YAZMADAN dogrular. True: surum reddedildi, hicbir sey yazilmadi."""
        if self.max_records is not None:  # ornek kipi: dosya bilerek eksik
            return False
        started = time.perf_counter()
        result = integrity.verify(path, feed.parser)
        if result is None:  # bu bicim icin on tarama yok (ndjson, toplayici)
            return False
        r = self.report
        r.integrity_seconds = round(time.perf_counter() - started, 2)
        r.records_in_file = result.records
        self._diagnostics = {"http": read_diagnostics(path), "integrity": result.summary()}
        self._merge_checkpoint(self._diagnostics)
        if not result.ok:
            assert result.code is not None
            self._reject_before_write(
                feed,
                snapshot_id,
                path,
                result.code,
                f"{result.code}: {result.detail}",
                result.records,
                # Kesik akis gecici olabilir (kaynak/ara katman); eksik dosya tekrar indirilir.
                retry_in=timedelta(minutes=30) if result.code == "truncated" else None,
            )
            return True
        blocked, median = self._size_drop(feed, settings, snapshot_id, sha, result.records)
        if blocked:
            self._reject_before_write(
                feed,
                snapshot_id,
                path,
                "too_few_records",
                f"too_few_records: {result.records} kayit, onceki medyan {median:.0f}",
                result.records,
            )
            return True
        return False

    def _size_drop(
        self, feed: FeedRow, settings: SyncSettings, snapshot_id: int, sha: str, records: int
    ) -> tuple[bool, float]:
        """(engelle, onceki_medyan). Anormal dusus karantinaya alinir, kalici engellenmez.

        Karar 0152: son tam surumlerin medyaninin `min_ratio_vs_median` altindaki dosya
        reddedilir (kesik/bozuk kaynak). Ayni icerik (sha256) `drop_confirm_hours` once de
        karantinaya alinmissa kaynak DEGISMEMIS demektir: mesru kuculme olarak kabul edilir.
        `size_guard: false` besleme ayariyla kapatilabilir.
        """
        if feed.config.get("size_guard") is False:
            return False, 0.0
        previous = [
            int(row[0])
            for row in self._fetchall(
                """SELECT record_count FROM source_snapshot
                    WHERE feed_source_id = %s AND status = 'complete' AND record_count IS NOT NULL
                    ORDER BY completed_at DESC LIMIT 3""",
                (feed.id,),
            )
        ]
        if not previous:
            return False, 0.0
        median = float(statistics.median(previous))
        if records >= settings.min_ratio_vs_median * median:
            return False, median
        earlier = self._exec(
            """SELECT 1 FROM source_snapshot
                WHERE feed_source_id = %s AND sha256 = %s AND id <> %s
                  AND status = 'rejected' AND reject_reason = 'too_few_records'
                  AND completed_at <= now() - make_interval(secs => %s) LIMIT 1""",
            (feed.id, sha, snapshot_id, settings.drop_confirm_hours * 3600),
        )
        self.conn.commit()
        if earlier:
            self.report.drop_confirmed = True
            logger.warning(
                "besleme %s: kayit dususu dogrulandi (%s < medyan %.0f), kabul edildi",
                feed.id,
                records,
                median,
            )
            return False, median
        return True, median

    def _reject_before_write(
        self,
        feed: FeedRow,
        snapshot_id: int,
        path: Path,
        code: str,
        error_text: str,
        records: int,
        *,
        retry_in: timedelta | None = None,
    ) -> None:
        """Surumu `rejected` yapar. offer, price_point, uyelik, urun: HICBIRINE DOKUNULMAZ."""
        self._exec(
            """UPDATE source_snapshot SET status = 'rejected', record_count = %s,
                      rejected_count = 0, reject_reason = %s, completed_at = now()
                WHERE id = %s""",
            (records or None, code, snapshot_id),
        )
        # `last_success_at` degismez: tazelik olcumu "geride" kalir ve gunluk is yeniden dener.
        self._exec(
            """UPDATE feed_source SET last_error_at = now(), last_error_code = %s,
                      updated_at = now() WHERE id = %s""",
            (code, feed.id),
        )
        self.report.gate = code
        self.report.status = "partial"
        self._finish_run("partial", error_text, retry_in)
        self._cleanup(path)

    def _merge_checkpoint(self, extra: dict[str, object]) -> None:
        """`ingest_run.checkpoint`e anahtar ekler (parca kontrol noktasini ezmez)."""
        self._exec(
            """UPDATE ingest_run SET checkpoint = COALESCE(checkpoint, '{}'::jsonb) || %s::jsonb,
                      updated_at = now() WHERE id = %s""",
            (json.dumps(extra), self.report.run_id),
        )
        self.conn.commit()

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
                (
                    created,
                    changed,
                    reactivated,
                    pp,
                    ob,
                    _mem,
                    changed_ids,
                    changed_ext,
                    edited_ids,
                    edited_ext,
                    image_changed,
                    prev_titles,
                    prev_brands,
                    prev_categories,
                    product_ids,
                ) = row
                images: list[tuple[int, tuple[SelectedImage, ...]]] = [
                    (oid, offers[ext].images)
                    for oid, ext in zip(changed_ids, changed_ext, strict=True)
                ]
                if images:
                    write_offer_images(self.conn, images)
                self._invalidate_embeddings(
                    offers,
                    zip(
                        edited_ids,
                        edited_ext,
                        image_changed,
                        prev_titles,
                        prev_brands,
                        prev_categories,
                        strict=True,
                    ),
                )
                # Teklif ve bagli urunun fiyat ozeti ayni islemde gorunur (toplama yazicisi gibi).
                self.report.aggregates_updated += product_aggregates.refresh_products(
                    self.conn, product_ids
                )
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
                    json.dumps(
                        {
                            "snapshot_id": snapshot_id,
                            "chunk": seq,
                            "records": r.records,
                            **self._diagnostics,
                        }
                    ),
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

    def _invalidate_embeddings(
        self,
        offers: dict[str, FeedOffer],
        edited: Iterator[tuple[int, str, bool, str | None, str | None, str | None]],
    ) -> None:
        stale_image: list[int] = []
        stale_text: list[int] = []
        for offer_id, ext, image_changed, title, brand, category in edited:
            if image_changed:
                stale_image.append(offer_id)
            offer = offers[ext]
            # Yalnizca KANONIK metin degistiyse: fiyat/stok degisimi yeniden embedding
            # maliyeti dogurmaz.
            if title is not None and text_builder.build(
                title, brand, category
            ) != text_builder.build(offer.title, offer.brand, offer.category_path):
                stale_text.append(offer_id)
        with self.conn.cursor() as cur:
            for kind, ids in (("image", stale_image), ("text", stale_text)):
                if not ids:
                    continue
                cur.execute(DELETE_STALE_EMBEDDINGS, {"kind": kind, "offer_ids": ids})
                if kind == "image":
                    self.report.stale_image_embeddings += cur.rowcount
                else:
                    self.report.stale_text_embeddings += cur.rowcount

    def _backpressure(self, settings: SyncSettings) -> None:
        self.sleep(settings.pause_ms / 1000)
        for _ in range(5):
            if _busy(self.conn) <= settings.busy_connections:
                break
            self.sleep(settings.busy_wait_seconds)
        # WAL arsivi geride kalirsa bekle (karar 0114): pgBackRest'in bekleyen WAL
        # kuyrugu sinirlidir (4 GiB); dolarsa WAL birakilir ve PITR zinciri kopar.
        # Olcum: 491 bin kayitlik ilk yukleme 4,6 GB WAL uretti.
        waited = 0.0
        while (
            lag := _archive_lag_bytes(self.conn)
        ) is not None and lag > settings.max_archive_lag_bytes:
            if waited >= settings.max_archive_wait_seconds:
                self.conn.commit()
                raise SyncAborted("archive_lag", f"arsivlenmemis WAL {lag} bayt")
            self.report.archive_wait_seconds += settings.archive_poll_seconds
            self.sleep(settings.archive_poll_seconds)
            waited += settings.archive_poll_seconds
            self.conn.commit()
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
        if feed.config.get("no_deactivate"):
            # Kismi kaynak (yonetici toplamasi, karar 0117): her kosu farkli bir alt kume olabilir;
            # kayit sayisi karsilastirmasi anlamsiz ve hicbir sey pasiflesmeyecek.
            return None
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
            # `no_deactivate`: kaynak tum katalogu degil taranan alt kumeyi verir; eksik
            # olmak kaldirilmis demek degildir (karar 0117). Hicbir offer pasiflesmez.
            status = (
                "success"
                if feed.config.get("no_deactivate")
                else self._deactivate(feed, settings, snapshot_id)
            )
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
        if gate == "truncated" and parse.error:
            r.parse_error = parse.error
        self._finish_run(status, f"{r.gate}: {parse.error}" if r.parse_error else r.gate)

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
            deactivated, product_ids = self._exec(
                SWEEP, {"ids": ids, "observed_at": self.observed_at}
            )
            r.deactivated = int(deactivated)
            r.aggregates_updated += product_aggregates.refresh_products(self.conn, product_ids)
        return "success"

    def _cleanup(self, path: Path) -> None:
        if self.source_path is None:
            path.unlink(missing_ok=True)
            diagnostics_path(path).unlink(missing_ok=True)


SAMPLE_SUFFIX = "-sample.bin"


def staging_name(feed_id: int, at: datetime, *, sample: bool) -> str:
    return f"feed-{feed_id}-{at:%Y%m%dT%H%M%S}" + (SAMPLE_SUFFIX if sample else ".bin")


#: Olcum (karar 0114, AliExpress YML): ~322 bayt/kayit sikistirilmis. ~1,9x pay.
SAMPLE_BYTES_PER_RECORD = 600
SAMPLE_MIN_BYTES = 4 << 20


def sample_bytes(max_records: int, override: str | None) -> int:
    """Ornek kipinde indirilecek bayt: kayit sayisiyla orantili (sabit 64 MiB degil)."""
    if override and override.isdigit():
        return int(override)
    return max(SAMPLE_MIN_BYTES, max_records * SAMPLE_BYTES_PER_RECORD)


def prefetch_download(
    feed: FeedRow, network: FeedNetwork, *, max_records: int | None, max_bytes: int, at: datetime
) -> tuple[Path, str, int] | None:
    """`sync-due` paralel indirmesi (karar 0114): Admitad baglanti basina sinirli
    (~0,25-0,5 MB/s), 3 baglantida toplam ~2,2 kat. Hata/disk sinirinda None:
    senkronizasyon kendi indirmesini dener ve hatayi kendi kaydina yazar.
    """
    directory = staging_dir()
    target = directory / staging_name(feed.id, at, sample=max_records is not None)
    stop_after = sample_bytes(max_records, env("FEED_SAMPLE_BYTES")) if max_records else None
    try:
        result = download(
            network.download_url(feed.external_id),
            target,
            max_bytes=max_bytes,
            stop_after_bytes=stop_after,
        )
    except (DownloadError, NetworkUnavailable) as error:
        logger.warning(
            "besleme %s on indirme basarisiz: %s", feed.id, getattr(error, "code", error)
        )
        return None
    return result.path, result.sha256, result.bytes_on_disk


class _PipelinedWriter:
    """Tek yardimci is parcacigi + tek parcalik kuyruk (bellek sinirli).

    Baglanti ayni anda yalnizca BIR is parcacigi tarafindan kullanilir: ana akis
    yalnizca ayristirir/normalize eder, veritabanina dokunmaz. Yardimcidaki hata
    sonraki `submit`/`finish` cagrisinda ana akista yeniden firlatilir.
    """

    _STOP = object()

    def __init__(self, handler: Callable[[Any], None]) -> None:
        self._handler = handler
        self._queue: queue.Queue[Any] = queue.Queue(maxsize=1)
        self._error: BaseException | None = None
        self._thread = threading.Thread(target=self._run, name="feed-merge", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        while True:
            item = self._queue.get()
            if item is self._STOP:
                return
            if self._error is not None:
                continue
            try:
                self._handler(item)
            except BaseException as error:  # noqa: BLE001 - ana akisa tasinir
                self._error = error

    def _raise(self) -> None:
        if self._error is not None:
            error, self._error = self._error, None
            raise error

    def submit(self, item: Any) -> None:
        self._raise()
        self._queue.put(item)

    def finish(self) -> None:
        self.close()
        self._raise()

    def close(self) -> None:
        if self._thread.is_alive():
            self._queue.put(self._STOP)
            self._thread.join()


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
