"""Gunluk besleme tazeleme (karar 0145): kesif -> senkronizasyon -> tazelik olcumu.

AliExpress fiyatlari Admitad beslemesinden gelir (karar 0112); bu modul
BESLEME MOTORUNA YENI MANTIK EKLEMEZ. Var olan parcalari sirayla ve guvenle
cagirir:

1. Kilit: `(4302, merchant_id)` advisory kilidi. Ayni merchant icin iki gunluk
   kosu birlikte calismaz; ikincisi hata vermeden "already_running" ile cikar.
   (Besleme basina kilit zaten `FeedSync`'tedir, 4301.)
2. Uygunluk: yalniz ETKIN ve en az bir kez TAM (`complete`) surumu olan besleme.
   Hic tam surumu olmayan besleme icin ilk yukleme asama kapilari
   (10 bin -> 100 bin -> tam, karar 0114) elle ve onayla gecilmelidir; gunluk is
   bu kapilari ATLAMAZ, o beslemeyi "initial_load_required" diye raporlar.
3. Kesif: `feed_source.source_updated_at` (kaynagin guncelleme imleci) yalniz
   kesifle tazelenir; kesifsiz `sync-due` yeni surumu hic gormez.
4. Senkronizasyon: `feeds.runner.sync_feeds` (= `sync-due` ile ayni dongu).
   Kaynak degismediyse indirme yok; degistiyse parca parca, kontrol noktali,
   tamlik kapili yazim. Gecici ag/indirme hatasi sinirli sayida yeniden denenir.
5. Olcum: `feeds.freshness.measure` (okur). Kur yoksa/eskiyse yalniz bayrak:
   TRY karsiligi okuma yolunda hesaplanir ve 4 gunden eski kurla GOSTERILMEZ
   (karar 0113); burada TL fiyat YAZILMAZ.

Fiyat sifirlanmaz, offer silinmez: kaynakta olmayan offer yalniz 48 saat bekleme
ve %10 tavan kosulunda pasiflesir (karar 0112). `price_point` yalnizca INSERT.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import psycopg

from feeds import discovery, runner
from feeds.freshness import DEFAULT_MAX_SOURCE_AGE, Freshness, measure
from feeds.network import FeedNetwork, NetworkUnavailable, build
from feeds.sync import FeedRow, load_feed

logger = logging.getLogger(__name__)

#: `FeedSync` besleme kilidi 4301; gunluk kosu kilidi 4302.
DAILY_LOCK_NAMESPACE = 4302

ELIGIBLE_SQL = """
SELECT f.id, f.network,
       EXISTS (SELECT 1 FROM source_snapshot s
                WHERE s.feed_source_id = f.id AND s.status = 'complete') AS loaded
  FROM feed_source f JOIN merchant m ON m.id = f.merchant_id
 WHERE m.slug = %s AND f.status = 'active'
 ORDER BY f.id
"""


@dataclass(frozen=True)
class DailyOptions:
    merchant: str
    parallel_downloads: int = 2
    #: Gecici hatada ek tur sayisi (ilk tur haric) ve turlar arasi bekleme (tur ile artar).
    retries: int = 2
    retry_wait_seconds: float = 600.0
    max_source_age: timedelta = DEFAULT_MAX_SOURCE_AGE
    discover: bool = True
    #: Yaklasik TRY icin gereken kurun para birimi (AliExpress beslemesi USD).
    fx_base: str = "USD"


@dataclass
class DailyResult:
    #: success | partial | failed
    status: str = "success"
    detail: dict[str, Any] = field(default_factory=dict)
    problems: list[str] = field(default_factory=list)

    @property
    def exit_code(self) -> int:
        return 0 if self.status == "success" else 1

    @property
    def error_summary(self) -> str | None:
        """Ilk birkac sorun (kod listesi; adres/sir icermez). `job_run` ayrica kirpar."""
        return "; ".join(self.problems[:5]) or None

    def problem(self, text: str) -> None:
        self.problems.append(text)


def _try_lock(conn: psycopg.Connection, merchant_id: int) -> bool:
    with conn.cursor() as cur:
        cur.execute("SELECT pg_try_advisory_lock(%s, %s)", (DAILY_LOCK_NAMESPACE, merchant_id))
        row = cur.fetchone()
    conn.commit()
    return bool(row and row[0])


def _unlock(conn: psycopg.Connection, merchant_id: int) -> None:
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT pg_advisory_unlock(%s, %s)", (DAILY_LOCK_NAMESPACE, merchant_id))
        conn.commit()
    except psycopg.Error:  # baglanti kopmussa kilit zaten birakilmistir
        logger.warning("gunluk kilit birakilamadi")


def _discover(
    conn: psycopg.Connection,
    networks: list[str],
    opts: DailyOptions,
    result: DailyResult,
    network_for: Callable[[str], FeedNetwork],
    sleep: Callable[[float], None],
) -> None:
    seen = gone = 0
    for name in networks:
        for attempt in range(opts.retries + 1):
            try:
                report = discovery.discover(conn, network_for(name))
                conn.commit()
                seen += report.seen
                gone += report.gone
                break
            except NetworkUnavailable as error:
                conn.rollback()
                # Kimlik bilgisi yoksa beklemenin anlami yok.
                if "tanimli degil" in str(error) or attempt == opts.retries:
                    result.detail["discovery"] = "failed"
                    result.problem(f"discovery_failed:{name}")
                    break
                sleep(opts.retry_wait_seconds * (attempt + 1))
    result.detail.setdefault("discovery", "ok")
    result.detail["discovered"] = seen
    if gone:
        result.detail["discovery_gone"] = gone
        result.problem("feeds_gone")


def run_daily(
    conn: psycopg.Connection,
    opts: DailyOptions,
    *,
    network_for: Callable[[str], FeedNetwork] = build,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    sync_kwargs: dict[str, object] | None = None,
) -> DailyResult:
    started = time.monotonic()
    result = DailyResult()
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM merchant WHERE slug = %s", (opts.merchant,))
        row = cur.fetchone()
    conn.commit()
    if row is None:
        result.status = "failed"
        result.problem("merchant_not_found")
        return result
    merchant_id = int(row[0])

    if not _try_lock(conn, merchant_id):
        # Baska bir gunluk kosu surerken ikincisi sessizce vazgecer (hata degil).
        result.detail["skipped"] = "already_running"
        return result
    try:
        _run_locked(conn, opts, result, network_for, sleep, clock, sync_kwargs)
    finally:
        _unlock(conn, merchant_id)
    result.detail["duration_s"] = round(time.monotonic() - started, 1)
    return result


def _run_locked(
    conn: psycopg.Connection,
    opts: DailyOptions,
    result: DailyResult,
    network_for: Callable[[str], FeedNetwork],
    sleep: Callable[[float], None],
    clock: Callable[[], datetime],
    sync_kwargs: dict[str, object] | None,
) -> None:
    with conn.cursor() as cur:
        cur.execute(ELIGIBLE_SQL, (opts.merchant,))
        rows = cur.fetchall()
    conn.commit()
    eligible = [(int(fid), str(net)) for fid, net, loaded in rows if loaded]
    not_loaded = [int(fid) for fid, _net, loaded in rows if not loaded]
    result.detail["feeds_active"] = len(rows)
    if not_loaded:
        # Asama kapilari atlanmaz: ilk yukleme elle ve onayla (docs/ops.md).
        result.detail["feeds_initial_load_required"] = len(not_loaded)
        result.problem("initial_load_required")
    if not rows:
        result.status = "failed"
        result.problem("no_active_feeds")
        return
    if not eligible:
        result.status = "failed"
        return

    if opts.discover:
        _discover(conn, sorted({net for _fid, net in eligible}), opts, result, network_for, sleep)

    feeds: list[FeedRow] = []
    for fid, _net in eligible:
        feeds.append(load_feed(conn, fid))
    conn.rollback()
    # Kesif bir beslemeyi 'gone'/'discovered' yaptiysa artik etkin degildir: atla.
    feeds = [f for f in feeds if f.status == "active"]

    final: dict[int, runner.FeedOutcome] = {}
    pending = feeds
    attempts = 0
    for attempt in range(opts.retries + 1):
        attempts = attempt + 1
        outcomes = runner.sync_feeds(
            conn,
            pending,
            network_for=network_for,
            parallel=opts.parallel_downloads,
            max_records=None,
            sync_kwargs=sync_kwargs,
        )
        for outcome in outcomes:
            final[outcome.feed_id] = outcome
        retry_ids = {o.feed_id for o in outcomes if not o.ok and o.retryable}
        if not retry_ids or attempt == opts.retries:
            break
        sleep(opts.retry_wait_seconds * (attempt + 1))
        # Retry turunda kaynagi tazelemek icin beslemeler yeniden yuklenir.
        pending = [load_feed(conn, fid) for fid in sorted(retry_ids)]
        conn.rollback()
    result.detail["attempts"] = attempts

    _summarize(result, list(final.values()))

    report = measure(
        conn,
        opts.merchant,
        now=clock(),
        max_source_age=opts.max_source_age,
        fx_base=opts.fx_base,
    )
    _freshness(result, report)


def _summarize(result: DailyResult, outcomes: list[runner.FeedOutcome]) -> None:
    totals = dict.fromkeys(
        (
            "records",
            "rejected",
            "created",
            "changed",
            "unchanged",
            "reactivated",
            "deactivated",
            "price_points",
        ),
        0,
    )
    synced = unchanged = failed = rejected_gate = locked = 0
    for outcome in outcomes:
        report = outcome.report
        if outcome.locked:
            locked += 1
            continue
        if report is None:
            failed += 1
            result.problem(f"feed_{outcome.feed_id}:{outcome.error_code}")
            continue
        for key in totals:
            totals[key] += int(getattr(report, key))
        if report.status in ("skipped", "duplicate"):
            unchanged += 1
        elif report.status == "success":
            synced += 1
        else:
            # Tamlik kapisi ya da deaktivasyon tavani: veri yazildi ama surum reddedildi.
            rejected_gate += 1
            result.problem(f"feed_{outcome.feed_id}:{report.gate or report.status}")
    result.detail.update(totals)
    result.detail["feeds_synced"] = synced
    result.detail["feeds_unchanged"] = unchanged
    result.detail["feeds_failed"] = failed
    result.detail["feeds_gate_rejected"] = rejected_gate
    if locked:
        result.detail["feeds_locked"] = locked
    if failed or rejected_gate:
        attempted = synced + unchanged + failed + rejected_gate
        result.status = "failed" if attempted and failed == attempted else "partial"


def _freshness(result: DailyResult, report: Freshness) -> None:
    result.detail.update(report.detail())
    for feed in report.problems:
        result.problem(f"feed_{feed.feed_id}:{feed.state.value}")
    if not report.fx.usable:
        # Fiyat yazimi durmaz (orijinal USD dogru); yalniz TL karsiligi gosterilemez.
        result.detail["fx_stale"] = True
        result.problem("fx_stale")
    if result.problems and result.status == "success":
        result.status = "partial"
