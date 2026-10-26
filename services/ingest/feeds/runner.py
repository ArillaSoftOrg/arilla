"""Birden fazla beslemeyi sirayla senkronize eder (karar 0114, 0145).

`feeds sync-due` ve `feeds daily` ayni dongüyu kullanir: indirmeler PARALEL
(en fazla 4), isleme SIRAYLA; bir besleme digerini durdurmaz. Her indirme bos
diskin payina sinirlidir (`FEED_MIN_FREE_BYTES` korunur).

Burada yeni senkronizasyon mantigi YOK: yazma, kilit, tamlik kapisi, kontrol
noktasi ve deaktivasyon `feeds.sync.FeedSync`'tedir.
"""

from __future__ import annotations

import shutil
import time
from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import psycopg

from db.connection import env
from feeds.download import DownloadError, staging_dir
from feeds.network import FeedNetwork, NetworkUnavailable, build
from feeds.sync import FeedRow, FeedSync, SyncAborted, SyncReport, prefetch_download

OK_STATUSES = frozenset({"success", "duplicate", "skipped"})
#: Yazmadan onceki kapi bu nedenle reddettiyse yeniden indirmek anlamli (karar 0152):
#: kesik dosya kaynak/ara katman kaynakli gecici olabilir. `too_few_records` yeniden
#: denenmez (ayni icerik gelir); karantina suresi dolunca kendiliginden kabul edilir.
RETRYABLE_GATES = frozenset({"truncated"})
MAX_PARALLEL_DOWNLOADS = 4


@dataclass
class FeedOutcome:
    """Bir besleme icin tek senkronizasyon denemesinin sonucu."""

    feed_id: int
    #: `SyncReport.status` (success, duplicate, skipped, partial) ya da `failed`.
    status: str
    report: SyncReport | None = None
    error_code: str | None = None
    #: Gecici ag/indirme hatasi: sonra yeniden denemek anlamli.
    retryable: bool = False
    #: Baska bir surec (elle kosu) bu beslemeyi isliyor; hata degil.
    locked: bool = False

    @property
    def ok(self) -> bool:
        return self.locked or self.status in OK_STATUSES


def is_due(feed: FeedRow, force: bool = False) -> bool:
    """Kaynagi, son basarili senkronizasyondan sonra guncellenmis (ya da bilinmiyor) mu?"""
    return (
        force
        or feed.source_updated_at is None
        or feed.last_success_at is None
        or feed.source_updated_at > feed.last_success_at
    )


def sync_one(
    conn: psycopg.Connection,
    feed_id: int,
    *,
    network: FeedNetwork | None,
    max_records: int | None = None,
    force: bool = False,
    prefetched: tuple[Path, str, int] | None = None,
    source_path: Path | None = None,
    **sync_kwargs: object,
) -> FeedOutcome:
    """Tek besleme. Hata disari firlamaz; sonuc `FeedOutcome` olarak doner."""
    sync = FeedSync(
        conn,
        feed_id,
        network=network,
        source_path=source_path,
        max_records=max_records,
        prefetched=prefetched,
        **sync_kwargs,  # type: ignore[arg-type]
    )
    try:
        report = sync.run(force=force or source_path is not None)
    except SyncAborted as error:
        conn.rollback()
        return FeedOutcome(
            feed_id, "failed", error_code=error.code, locked=error.code == "feed_locked"
        )
    except Exception as error:  # bir besleme digerlerini durdurmaz
        conn.rollback()
        retryable = isinstance(error, NetworkUnavailable) or (
            isinstance(error, DownloadError) and error.retryable
        )
        return FeedOutcome(
            feed_id,
            "failed",
            error_code=str(getattr(error, "code", type(error).__name__))[:60],
            retryable=retryable,
        )
    return FeedOutcome(
        feed_id,
        report.status,
        report=report,
        retryable=report.status == "partial" and report.gate in RETRYABLE_GATES,
    )


def sync_feeds(
    conn: psycopg.Connection,
    feeds: Sequence[FeedRow],
    *,
    network_for: Callable[[str], FeedNetwork] = build,
    parallel: int = 2,
    max_records: int | None = None,
    force: bool = False,
    on_outcome: Callable[[FeedOutcome], None] | None = None,
    sync_kwargs: dict[str, object] | None = None,
) -> list[FeedOutcome]:
    """`feeds` sirayla islenir. Kaynagi degismis olanlar once PARALEL indirilir."""
    parallel = max(1, min(int(parallel), MAX_PARALLEL_DOWNLOADS))
    due = [f for f in feeds if is_due(f, force)]
    outcomes: list[FeedOutcome] = []
    if not feeds:
        return outcomes
    free = shutil.disk_usage(staging_dir()).free
    min_free = int(env("FEED_MIN_FREE_BYTES") or 15 << 30)
    budget = max(0, (free - min_free) // parallel)
    with ThreadPoolExecutor(max_workers=parallel) as pool:
        futures = {
            f.id: pool.submit(
                prefetch_download,
                f,
                network_for(f.network),
                max_records=max_records,
                max_bytes=budget,
                at=datetime.now(UTC),
            )
            for f in due
        }
        for feed in feeds:
            try:
                prefetched = futures[feed.id].result() if feed.id in futures else None
                outcome = sync_one(
                    conn,
                    feed.id,
                    network=network_for(feed.network),
                    max_records=max_records,
                    force=force,
                    prefetched=prefetched,
                    **(sync_kwargs or {}),
                )
            except Exception as error:  # on indirme ya da ag kurulumu; digerleri surer
                conn.rollback()
                outcome = FeedOutcome(
                    feed.id,
                    "failed",
                    error_code=str(getattr(error, "code", type(error).__name__))[:60],
                    retryable=isinstance(error, NetworkUnavailable),
                )
            outcomes.append(outcome)
            if on_outcome is not None:
                on_outcome(outcome)
    return outcomes


def pause(seconds: float, sleep: Callable[[float], None] = time.sleep) -> None:
    if seconds > 0:
        sleep(seconds)
