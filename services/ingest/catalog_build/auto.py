"""Otomatik katalog hatti (karar 0164): yeni teklif -> taslak -> kategori -> kapi -> yayin.

Yeni bir mimari DEGIL: var olan dort adimi sirayla ve tek kilit altinda baglar.

  1. build    kaynak teklifinden eksik TASLAK urun (`catalog_build build`; imleç, WAL denetimi)
  2. parents  guvenilir UST kategori (`classify parents`; yalniz `yuksek` esleme, alt kategori yok)
  3. gate     draft -> ready | held (`catalog_build gate`, `--stale-days`, `--allow-foreign`)
  4. publish  ready -> published (`catalog_build publish`, tazelik yeniden kontrol edilir)

Guvenceler:

* Tek calisma: `AUTO_LOCK_KEY` advisory kilidi. Ayrica baska bir catalog_build/classify oturumu,
  besleme senkronizasyonu (4301), gunluk besleme isi (4302) ya da benzerlik kenari (SIME) kilidi
  gorulurse BASLAMAZ; calisirken de parti araliginda kontrol edilir ve uretim senkronizasyonuna
  yol verilir (is durur, ayni komut kaldigi yerden surer).
* Yedek penceresi (01:20-02:05 UTC) ve disk (baslangic >= 70 GB, rezerv 40 GB; `catalog-publish`
  ile ayni esikler) disinda calismaz.
* Her adim `job_run.track` altinda; adim sayaclari `catalog_auto` kaydinin `detail` alanindadir.
* Her adim kendi imlecinden surer; coken kosu yeniden calistirilinca kaldigi yerden devam eder.
  Bir adim hata verirse sonrakiler yine denenir (bagimsiz yedek is); veritabani baglantisi
  kopar ya da WAL siniri asilirsa hepsi durur.
* Yurt disi (USD) urun yalniz `allow_foreign` VE `CATALOG_PUBLISH_FOREIGN_APPROVED=true` ile
  yayinlanir (karar 0113/0114/0164). Site herkese acilmaz: `PRODUCT_ACCESS` kapisina dokunulmaz.
* `require_category`: acik oldugunda kategorisiz urun `held` (`category_missing`) kalir.
  Varsayilan KAPALI: var olan 2,77 M yayinli urunun cogu da kategorisizdir (karar 0164 §4).

`backlog` YALNIZCA OKUR: bekleyen isleri ve nedenlerini sayar.
"""

from __future__ import annotations

import logging
import os
import shutil
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from datetime import time as dtime
from pathlib import Path
from typing import Any

import psycopg

from catalog_build import build as build_mod
from catalog_build import gate as gate_mod
from catalog_build import publish as publish_mod
from catalog_build import source_config
from catalog_build.gate import PUBLISH_STALE_DAYS
from catalog_build.policy import SourcePolicy
from db import job_run, wal_pressure

logger = logging.getLogger(__name__)

#: Bu hattin kilidi. Sinif: classify 4_133_001, benzerlik 0x53494D45; cakismaz.
AUTO_LOCK_KEY = 4_133_201
#: Uretimdeki yazarlar (kod sabitleri `feeds.sync`, `feeds.daily`, `similarity.edges`; test
#: gercek sabitlerle esitligi dogrular). Burada kopyalanir: bu paket baska paketi iceri almaz.
FEED_SYNC_LOCK_NAMESPACE = 4301
FEEDS_DAILY_LOCK_NAMESPACE = 4302
SIMILARITY_EDGES_LOCK_KEY = 0x53494D45
CLASSIFY_LOCK_KEY = 4_133_001

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_WAL_BACKPRESSURE = 3
#: Baska bir yazar calisiyor / pencere disinda: hata degil, atlandi.
EXIT_BUSY = 4

#: Gunluk yedek (`arilla-backup-*`, 01:30 UTC) cevresi; WAL arsivi ve G/C bu surede korunur.
BACKUP_WINDOW_UTC = (dtime(1, 20), dtime(2, 5))
START_FREE_GB = 70
RESERVE_FREE_GB = 40
CHECK_EVERY_SECONDS = 15.0
GIB = 1 << 30

STAGES = ("build", "parents", "gate", "publish")
#: Sure payi; erken biten adimin kalani sonrakilere kayar.
SHARES = {"build": 0.35, "parents": 0.20, "gate": 0.15, "publish": 0.30}
#: Adim -> `job_run.job`. Var olan adlar yeniden kullanilir: yonetim ekrani ve runbook ayni kalir.
STAGE_JOBS = {
    "build": "catalog_build",
    "parents": "classify_parent",
    "gate": "catalog_gate",
    "publish": "catalog_publish",
}
MIN_STAGE_SECONDS = 5.0
#: `catalog_auto.detail`e giren ozet sayaclar (`job_run` en fazla 40 anahtar tasir).
SUMMARY_COUNTERS = frozenset(
    {
        "scanned",
        "created",
        "skipped",
        "category_set",
        "uncategorised",
        "ready",
        "held",
        "published",
        "left_ready",
    }
)

BUSY_SQL = """
SELECT
  (SELECT count(*) FROM pg_stat_activity
    WHERE datname = current_database() AND pid <> ALL(%(own)s)
      AND application_name LIKE 'arilla-ingest:catalog_build%%') AS catalog_build,
  count(*) FILTER (WHERE l.objsubid = 2 AND l.classid::bigint = %(feed_ns)s) AS feed_sync,
  count(*) FILTER (WHERE l.objsubid = 2 AND l.classid::bigint = %(daily_ns)s) AS feeds_daily,
  count(*) FILTER (WHERE l.objsubid = 1 AND l.classid::bigint = 0
                    AND l.objid::bigint = %(classify)s) AS classify,
  count(*) FILTER (WHERE l.objsubid = 1 AND l.classid::bigint = 0
                    AND l.objid::bigint = %(edges)s) AS similarity
  FROM pg_locks l
 WHERE l.locktype = 'advisory' AND l.granted AND l.pid <> ALL(%(own)s)
"""

#: Imlec ve tam tarama zamani MAGAZA BAZLIDIR (karar 0164): gate imleci urun kimligidir ve baska
#: magazanin imleci bu magazanin urunlerini atlatir. `merchant` anahtari olmayan eski kayitlar
#: (karar 0163 donemi, yalniz AliExpress) `aliexpress` sayilir.
LEGACY_MERCHANT = "aliexpress"

LAST_RESCAN_SQL = """
SELECT max(started_at) FROM job_run
 WHERE job = 'catalog_auto' AND status <> 'running' AND detail->>'rescan' = 'true'
   AND COALESCE(detail->>'merchant', %s) = %s
"""

LAST_GATE_CURSOR_SQL = """
SELECT detail->>'gate_cursor' FROM job_run
 WHERE job = 'catalog_auto' AND status <> 'running' AND detail ? 'gate_cursor'
   AND COALESCE(detail->>'merchant', %s) = %s
 ORDER BY id DESC LIMIT 1
"""


class AutoBusy(Exception):
    """Calisma baslamadi: baska yazar var ya da pencere/disk uygun degil."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class AutoOptions:
    merchant: str = "aliexpress"
    #: Tum kosunun duvar saati butcesi. Zamanlayici `TimeoutStartSec`inin altinda kalmali.
    max_seconds: float = 8_400.0
    publish_limit: int = 300_000
    stale_days: int = PUBLISH_STALE_DAYS
    allow_foreign: bool = False
    require_category: bool = False
    #: Tam yeniden tarama araligi (gun): onceden atlanmis ama sonradan gecerli olan teklifler.
    rescan_days: int = 7
    build_batch: int = build_mod.DEFAULT_BATCH
    parents_batch: int = 2_000
    gate_batch: int = gate_mod.DEFAULT_BATCH
    publish_batch: int = publish_mod.DEFAULT_BATCH
    sleep_ms: int = 100
    disk_path: str = "/"
    start_free_gb: int = START_FREE_GB
    reserve_free_gb: int = RESERVE_FREE_GB


def in_backup_window(now: datetime) -> bool:
    start, end = BACKUP_WINDOW_UTC
    t = now.astimezone(UTC).time()
    return start <= t < end


def environment_reason(
    guard_conn: psycopg.Connection,
    own_pids: list[int],
    opts: AutoOptions,
    now: datetime,
    *,
    starting: bool,
) -> str | None:
    """Neden calisilmamali? Hicbir engel yoksa None. `guard_conn` autocommit, ayri oturum."""
    if in_backup_window(now):
        return "backup_window"
    free = shutil.disk_usage(opts.disk_path).free
    need = opts.start_free_gb if starting else opts.reserve_free_gb
    if free < need * GIB:
        return f"disk_low_{free // GIB}gb"
    with guard_conn.cursor() as cur:
        cur.execute(
            BUSY_SQL,
            {
                "own": own_pids,
                "feed_ns": FEED_SYNC_LOCK_NAMESPACE,
                "daily_ns": FEEDS_DAILY_LOCK_NAMESPACE,
                "classify": CLASSIFY_LOCK_KEY,
                "edges": SIMILARITY_EDGES_LOCK_KEY,
            },
        )
        row = cur.fetchone()
    assert row is not None
    cb, feed, daily, classify, edges = (int(x) for x in row)
    # Uretim senkronizasyonu onceliklidir.
    if daily:
        return "feeds_daily_running"
    if feed:
        return "feed_sync_running"
    if cb:
        return "catalog_build_running"
    if classify:
        return "classify_running"
    if edges:
        return "similarity_running"
    return None


class Guard:
    """Durdurma ve ortam denetimi. `should_stop` parti arasinda cagrilir (acik islem yok)."""

    def __init__(
        self,
        check: Callable[[bool], str | None],
        *,
        external_stop: Callable[[], bool] = lambda: False,
        clock: Callable[[], float] = time.monotonic,
        deadline: float | None = None,
    ) -> None:
        self._check = check
        self._external = external_stop
        self._clock = clock
        self.deadline = deadline
        self.reason: str | None = None
        self._next = float("-inf")

    def start_reason(self) -> str | None:
        return self._check(True)

    def should_stop(self) -> bool:
        if self.reason is not None:
            return True
        if self._external():
            self.reason = "signal"
            return True
        now = self._clock()
        if self.deadline is not None and now >= self.deadline:
            self.reason = "time"
            return True
        if now >= self._next:
            self._next = now + CHECK_EVERY_SECONDS
            found = self._check(False)
            if found is not None:
                self.reason = found
                return True
        return False


@dataclass
class StageResult:
    name: str
    status: str = "pending"  # success | partial | failed | skipped
    seconds: float = 0.0
    note: str | None = None
    counters: dict[str, int] = field(default_factory=dict)


@dataclass
class AutoResult:
    status: str = "success"
    exit_code: int = EXIT_OK
    skipped: str | None = None
    stopped: str | None = None
    rescan: bool = False
    gate_cursor: int = 0
    merchant: str = ""
    stages: list[StageResult] = field(default_factory=list)
    wal: dict[str, float | int] = field(default_factory=dict)

    def detail(self) -> dict[str, Any]:
        """`job_run.detail`: yalniz duz sayi/bool/kisa metin (en fazla 40 anahtar)."""
        out: dict[str, Any] = {"rescan": self.rescan, "gate_cursor": self.gate_cursor}
        if self.merchant:
            out["merchant"] = self.merchant
        if self.skipped:
            out["skipped"] = self.skipped
        if self.stopped:
            out["stopped"] = self.stopped
        for stage in self.stages:
            out[f"{stage.name}_status"] = stage.status
            out[f"{stage.name}_s"] = round(stage.seconds)
            for key, value in stage.counters.items():
                # Ayrinti (held_<neden> ...) adimin kendi `job_run` kaydindadir.
                if key in SUMMARY_COUNTERS:
                    out[f"{stage.name}_{key}"] = value
        out.update(self.wal)
        return out


def _scalar(conn: psycopg.Connection, sql: str, params: tuple[Any, ...] | None = None) -> Any:
    with conn.cursor() as cur:
        cur.execute(sql, params)
        row = cur.fetchone()
    conn.commit()
    return row[0] if row else None


def rescan_due(conn: psycopg.Connection, days: int, merchant: str = LEGACY_MERCHANT) -> bool:
    """Son tam taramadan `days` gun gectiyse (ya da hic yapilmadiysa) True. 0 = hic yapma."""
    if days <= 0:
        return False
    last = _scalar(conn, LAST_RESCAN_SQL, (LEGACY_MERCHANT, merchant))
    if last is None:
        return True
    return bool((datetime.now(UTC) - last).total_seconds() >= days * 86_400)


def previous_gate_cursor(conn: psycopg.Connection, merchant: str = LEGACY_MERCHANT) -> int:
    value = _scalar(conn, LAST_GATE_CURSOR_SQL, (LEGACY_MERCHANT, merchant))
    try:
        return max(0, int(value)) if value is not None else 0
    except (TypeError, ValueError):
        return 0


def _stage_deadline(
    stage: str, remaining: list[str], overall_deadline: float, clock: Callable[[], float]
) -> float:
    """Bu adimin payi: kalan sure x pay / kalan adimlarin pay toplami."""
    left = max(0.0, overall_deadline - clock())
    total = sum(SHARES[s] for s in remaining) or 1.0
    return clock() + left * SHARES[stage] / total


def run_auto(
    conn: psycopg.Connection,
    opts: AutoOptions,
    guard: Guard,
    governor: wal_pressure.WalGovernor | None,
    *,
    policy: SourcePolicy | None = None,
    policies: dict[str, SourcePolicy] | None = None,
    map_path: Path | None = None,
    clock: Callable[[], float] = time.monotonic,
    track: Callable[[str], Any] = job_run.track,
) -> AutoResult:
    """Dort adimi sirayla calistirir. `conn` icinde baska ISLEM ACIK olmamalidir."""
    result = AutoResult(merchant=opts.merchant)
    # Kaynak kisitlari yalniz SIKILASTIRIR (karar 0164); AliExpress icin sonuc degismez.
    plan = source_config.plan_for(opts.merchant)
    opts, plan = source_config.effective_options(opts, plan)
    not_applicable = {
        stage
        for stage, applies in (("parents", plan.run_parents), ("publish", plan.may_publish))
        if not applies
    }
    started = clock()
    overall_deadline = started + opts.max_seconds
    guard.deadline = overall_deadline

    reason = guard.start_reason()
    if reason is not None:
        result.status, result.exit_code, result.skipped = "success", EXIT_BUSY, reason
        logger.warning("otomatik hat atlandi: %s", reason)
        return result

    with conn.cursor() as cur:
        cur.execute("SELECT pg_try_advisory_lock(%s)", (AUTO_LOCK_KEY,))
        locked = bool(cur.fetchone()[0])  # type: ignore[index]
    conn.commit()
    if not locked:
        result.status, result.exit_code, result.skipped = "success", EXIT_BUSY, "auto_running"
        return result

    throttle = governor.before_batch if governor is not None else None
    try:
        result.rescan = rescan_due(conn, opts.rescan_days, opts.merchant)
        cursor_before = previous_gate_cursor(conn, opts.merchant)
        remaining = [s for s in STAGES if s not in not_applicable]
        for stage in STAGES:
            remaining_now = [s for s in remaining]
            if stage in remaining:
                remaining.remove(stage)
            stage_result = StageResult(name=stage)
            result.stages.append(stage_result)
            if stage in not_applicable:
                # Kaynak icin gecerli degil (kayit defteri): hata/kismi degil, atlama sayilmaz.
                stage_result.status = "not_applicable"
                stage_result.note = (
                    "no_parent_map" if stage == "parents" else "publish_not_permitted"
                )
                continue
            if guard.should_stop():
                stage_result.status, stage_result.note = "skipped", guard.reason or "stop"
                continue
            deadline = _stage_deadline(stage, remaining_now, overall_deadline, clock)
            budget = deadline - clock()
            if budget < MIN_STAGE_SECONDS:
                stage_result.status, stage_result.note = "skipped", "no_time"
                continue

            def stop_for_stage(deadline: float = deadline) -> bool:
                return guard.should_stop() or clock() >= deadline

            began = clock()
            try:
                with track(STAGE_JOBS[stage]) as run:
                    note = _run_stage(
                        stage,
                        conn,
                        opts,
                        stage_result,
                        budget=budget,
                        stop=stop_for_stage,
                        throttle=throttle,
                        policy=policy,
                        policies=policies,
                        map_path=map_path,
                        rescan=result.rescan,
                        gate_cursor=cursor_before,
                        auto=result,
                    )
                    run.detail.update(stage_result.counters)
                    run.detail["via"] = "catalog_auto"
                    if stage_result.status == "partial":
                        run.status = "partial"
                        run.error_summary = note
            except psycopg.OperationalError:
                stage_result.status, stage_result.note = "failed", "database_connection"
                result.stopped = "database_connection"
                break
            except Exception as error:  # adim hatasi sonrakileri durdurmaz (track kaydetti)
                conn.rollback()
                stage_result.status = "failed"
                stage_result.note = f"{type(error).__name__}: {error}"[:120]
                logger.error("adim %s basarisiz: %s", stage, stage_result.note)
            finally:
                stage_result.seconds = clock() - began
            if governor is not None and governor.stopped_reason is not None:
                result.stopped = f"wal: {governor.stopped_reason}"[:120]
                result.exit_code = EXIT_WAL_BACKPRESSURE
                break
    finally:
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT pg_advisory_unlock(%s)", (AUTO_LOCK_KEY,))
            conn.commit()
        except psycopg.Error:  # pragma: no cover
            pass

    if governor is not None:
        result.wal = dict(governor.stats.as_detail())
    if result.stopped is None and guard.reason not in (None, "time"):
        result.stopped = guard.reason
    statuses = [s.status for s in result.stages]
    if "failed" in statuses:
        result.status = "failed"
        result.exit_code = result.exit_code or EXIT_ERROR
    elif "partial" in statuses or "skipped" in statuses or result.stopped:
        result.status = "partial"
    return result


def _run_stage(
    stage: str,
    conn: psycopg.Connection,
    opts: AutoOptions,
    out: StageResult,
    *,
    budget: float,
    stop: Callable[[], bool],
    throttle: Callable[[], bool] | None,
    policy: SourcePolicy | None,
    policies: dict[str, SourcePolicy] | None,
    map_path: Path | None,
    rescan: bool,
    gate_cursor: int,
    auto: AutoResult,
) -> str | None:
    """Tek adim. Donus: kismi bitisin nedeni (yoksa None). Sayaclar `out.counters`'a yazilir."""
    sleep = opts.sleep_ms / 1000
    if stage == "build":
        counts = build_mod.build_source_products(
            conn,
            merchant_slug=opts.merchant,
            batch_size=opts.build_batch,
            max_seconds=budget,
            rescan=rescan,
            sleep_seconds=sleep,
            should_stop=stop,
            throttle=throttle,
            policy=policy,
        )
        out.counters = {
            "scanned": counts.scanned,
            "created": counts.created,
            "existing": counts.existing,
            "skipped": sum(counts.skipped.values()),
            "completed": int(counts.completed),
        }
        out.status = "success" if counts.completed else "partial"
        return None if counts.completed else "build_incomplete"

    if stage == "parents":
        from classify import parent_apply as parent_mod
        from classify.suggest.finalize import MAP_FILE

        parents = parent_mod.apply_parents(
            conn,
            merchant_slug=opts.merchant,
            batch_size=opts.parents_batch,
            max_seconds=budget,
            sleep_seconds=sleep,
            allow_concurrent_catalog_build=True,
            map_path=map_path or MAP_FILE,
            throttle=throttle,
            should_stop=stop,
        )
        out.counters = {
            "scanned": parents.scanned,
            "category_set": parents.category_set,
            "uncategorised": parents.review,
            "errors": parents.errors,
            "completed": int(parents.completed),
        }
        out.status = "success" if parents.completed and not parents.errors else "partial"
        return None if out.status == "success" else "parents_incomplete"

    if stage == "gate":
        # 1) hic degerlendirilmemis `draft` (durumsuz: gecen urun draft'tan cikar),
        # 2) `held`/`ready` yeniden bakis: kaynakta geri donen teklif tekrar `ready` olur.
        gate_merchant = build_mod.merchant_id_for(conn, opts.merchant)
        conn.commit()
        fresh = gate_mod.run_gate(
            conn,
            after_id=0,
            batch_size=opts.gate_batch,
            stale_days=opts.stale_days,
            allow_foreign=opts.allow_foreign,
            states=("draft",),
            merchant_id=gate_merchant,
            require_category=opts.require_category,
            should_stop=stop,
            throttle=throttle,
        )
        recheck = gate_mod.GateCounts(completed=True)
        if fresh.completed:
            recheck = gate_mod.run_gate(
                conn,
                after_id=gate_cursor,
                batch_size=opts.gate_batch,
                stale_days=opts.stale_days,
                allow_foreign=opts.allow_foreign,
                states=("held", "ready"),
                merchant_id=gate_merchant,
                require_category=opts.require_category,
                should_stop=stop,
                throttle=throttle,
            )
            auto.gate_cursor = 0 if recheck.completed else recheck.last_product_id
        else:
            auto.gate_cursor = gate_cursor
        held = sum(fresh.held.values()) + sum(recheck.held.values())
        out.counters = {
            "scanned": fresh.scanned + recheck.scanned,
            "ready": fresh.ready + recheck.ready,
            "held": held,
            "foreign_blocked": fresh.foreign_blocked,
            "completed": int(fresh.completed and recheck.completed),
        }
        for reason in sorted(set(fresh.held) | set(recheck.held)):
            out.counters[f"held_{reason}"] = fresh.held.get(reason, 0) + recheck.held.get(reason, 0)
        out.status = "success" if fresh.completed and recheck.completed else "partial"
        return None if out.status == "success" else "gate_incomplete"

    if stage == "publish":
        merchant_id = build_mod.merchant_id_for(conn, opts.merchant)
        conn.commit()
        published = publish_mod.publish_ready(
            conn,
            limit=opts.publish_limit,
            merchant_id=merchant_id,
            batch_size=max(1, min(opts.publish_batch, publish_mod.DEFAULT_BATCH)),
            allow_foreign=opts.allow_foreign,
            stale_days=opts.stale_days,
            policies=policies,
            should_stop=stop,
            throttle=throttle,
        )
        left = sum(published.left_ready.values())
        out.counters = {
            "selected": published.selected,
            "published": published.published,
            "held": sum(published.held.values()),
            "left_ready": left,
        }
        for reason, n in published.held.items():
            out.counters[f"held_{reason}"] = n
        not_approved = published.left_ready.get("foreign_not_approved", 0)
        if not_approved:
            out.counters["foreign_not_approved"] = not_approved
            out.status = "partial"
            return f"{publish_mod.FOREIGN_APPROVAL_ENV} tanimli degil: yurt disi urun yayinlanmadi"
        out.status = "success"
        return None
    raise ValueError(f"bilinmeyen adim: {stage}")


# --- backlog (YALNIZCA OKUR) -----------------------------------------------------------------

BACKLOG_STATE_SQL = """
SELECT publication_state, coalesce(hold_reason, ''), count(*), count(category_id)
  FROM product WHERE source_merchant_id = %(mid)s
 GROUP BY 1, 2 ORDER BY 1, 2
"""
BACKLOG_OFFERS_SQL = """
SELECT count(*), count(*) FILTER (WHERE is_active),
       count(*) FILTER (WHERE product_id IS NOT NULL),
       count(*) FILTER (WHERE is_active AND product_id IS NULL)
  FROM offer WHERE merchant_id = %(mid)s
"""
BACKLOG_CURSOR_SQL = """
SELECT s.last_offer_id, s.completed_at,
       (SELECT count(*) FROM offer o WHERE o.merchant_id = %(mid)s AND o.id > s.last_offer_id),
       (SELECT max(id) FROM offer o WHERE o.merchant_id = %(mid)s)
  FROM catalog_build_state s WHERE s.merchant_id = %(mid)s
"""
BACKLOG_OLDEST_SQL = """
SELECT min(created_at), min(updated_at) FILTER (WHERE publication_state = 'held')
  FROM product
 WHERE source_merchant_id = %(mid)s AND publication_state IN ('draft', 'ready', 'held')
"""
BACKLOG_NO_PRODUCT_SQL = """
SELECT count(*) FILTER (WHERE NOT EXISTS (
           SELECT 1 FROM product p
            WHERE p.source_merchant_id = o.merchant_id AND p.source_external_id = o.external_id)),
       count(*) FILTER (WHERE o.is_active AND NOT EXISTS (
           SELECT 1 FROM product p
            WHERE p.source_merchant_id = o.merchant_id AND p.source_external_id = o.external_id))
  FROM offer o WHERE o.merchant_id = %(mid)s
"""
BACKLOG_RUNS_SQL = """
SELECT DISTINCT ON (job) job, id, status, started_at, finished_at, left(error_summary, 120)
  FROM job_run
 WHERE job = ANY(%(jobs)s)
 ORDER BY job, id DESC
"""
BACKLOG_JOBS = [
    "catalog_auto",
    "catalog_build",
    "classify_parent",
    "catalog_gate",
    "catalog_publish",
]


@dataclass
class Backlog:
    merchant: str
    offers_total: int = 0
    offers_active: int = 0
    offers_linked: int = 0
    offers_active_unlinked: int = 0
    cursor: int | None = None
    cursor_completed_at: datetime | None = None
    offers_after_cursor: int = 0
    max_offer_id: int | None = None
    offers_without_product_row: int | None = None
    active_offers_without_product_row: int | None = None
    products: dict[str, int] = field(default_factory=dict)
    categorised: dict[str, int] = field(default_factory=dict)
    held_by_reason: dict[str, int] = field(default_factory=dict)
    oldest_pending: datetime | None = None
    oldest_held: datetime | None = None
    runs: list[tuple[str, int, str, datetime, datetime | None, str | None]] = field(
        default_factory=list
    )


def backlog(conn: psycopg.Connection, merchant_slug: str, *, deep: bool = False) -> Backlog:
    """Bekleyen isler. Oturum SALT OKUNUR yapilir; `deep` pahali karsilastirmayi da sayar."""
    with conn.cursor() as cur:
        # Islemin ILK ifadesi: yazma girisimi ReadOnlySqlTransaction ile reddedilir.
        cur.execute("SET TRANSACTION READ ONLY")
        cur.execute("SET LOCAL statement_timeout = '600s'")
        mid = build_mod.merchant_id_for(conn, merchant_slug)
        out = Backlog(merchant=merchant_slug)
        cur.execute(BACKLOG_OFFERS_SQL, {"mid": mid})
        row = cur.fetchone()
        assert row is not None
        out.offers_total, out.offers_active, out.offers_linked, out.offers_active_unlinked = (
            int(x) for x in row
        )
        cur.execute(BACKLOG_CURSOR_SQL, {"mid": mid})
        cursor_row = cur.fetchone()
        if cursor_row is not None:
            out.cursor = int(cursor_row[0])
            out.cursor_completed_at = cursor_row[1]
            out.offers_after_cursor = int(cursor_row[2])
            out.max_offer_id = None if cursor_row[3] is None else int(cursor_row[3])
        cur.execute(BACKLOG_STATE_SQL, {"mid": mid})
        for state, reason, n, cat in cur.fetchall():
            out.products[state] = out.products.get(state, 0) + int(n)
            out.categorised[state] = out.categorised.get(state, 0) + int(cat)
            if state == "held":
                out.held_by_reason[reason or "-"] = int(n)
        cur.execute(BACKLOG_OLDEST_SQL, {"mid": mid})
        oldest = cur.fetchone()
        if oldest is not None:
            out.oldest_pending, out.oldest_held = oldest[0], oldest[1]
        if deep:
            cur.execute(BACKLOG_NO_PRODUCT_SQL, {"mid": mid})
            deep_row = cur.fetchone()
            assert deep_row is not None
            out.offers_without_product_row = int(deep_row[0])
            out.active_offers_without_product_row = int(deep_row[1])
        cur.execute(BACKLOG_RUNS_SQL, {"jobs": BACKLOG_JOBS})
        out.runs = [tuple(r) for r in cur.fetchall()]  # type: ignore[misc]
    conn.rollback()
    return out


def format_backlog(b: Backlog, now: datetime | None = None) -> str:
    now = now or datetime.now(UTC)

    def age(ts: datetime | None) -> str:
        if ts is None:
            return "-"
        hours = (now - ts).total_seconds() / 3600
        return f"{hours:.1f} saat" if hours < 48 else f"{hours / 24:.1f} gun"

    lines = [
        f"magaza                      {b.merchant}",
        f"teklif toplam               {b.offers_total}",
        f"teklif aktif                {b.offers_active}",
        f"teklif urune bagli          {b.offers_linked}  (yayinda)",
        f"teklif aktif + bagsiz       {b.offers_active_unlinked}",
        f"build imleci                {b.cursor}  (tamamlandi: {b.cursor_completed_at})",
        f"imlecten sonraki teklif     {b.offers_after_cursor}  (en buyuk id {b.max_offer_id})",
    ]
    if b.offers_without_product_row is not None:
        lines.append(f"urun satiri olmayan teklif  {b.offers_without_product_row}")
        lines.append(f"  ...aktif olanlar          {b.active_offers_without_product_row}")
    for state in ("draft", "ready", "held", "published"):
        n = b.products.get(state, 0)
        lines.append(f"urun {state:<10}           {n}  (kategorili {b.categorised.get(state, 0)})")
    for reason, n in sorted(b.held_by_reason.items(), key=lambda kv: -kv[1]):
        lines.append(f"  held {reason:<24} {n}")
    lines.append(f"en eski bekleyen urun       {age(b.oldest_pending)}")
    lines.append(f"en eski held urun (guncel)  {age(b.oldest_held)}")
    for job, run_id, status, started, _finished, err in b.runs:
        lines.append(f"son kosu {job:<16} #{run_id} {status} {started:%Y-%m-%d %H:%M} {err or ''}")
    return "\n".join(lines)


def disk_path_from_env() -> str:
    return os.environ.get("CATALOG_AUTO_DISK_PATH", "/")


def disk_thresholds_from_env() -> tuple[int, int]:
    """(baslangic, rezerv) bos disk GB. Varsayilanlar `catalog-publish` ile aynidir (70/40);
    yalnizca gelistirme makinelerinde dusurulur."""

    def read(name: str, default: int) -> int:
        try:
            return max(0, int(os.environ.get(name, default)))
        except ValueError:
            return default

    return read("CATALOG_AUTO_START_FREE_GB", START_FREE_GB), read(
        "CATALOG_AUTO_RESERVE_FREE_GB", RESERVE_FREE_GB
    )
