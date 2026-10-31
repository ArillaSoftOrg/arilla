"""Birden fazla beslemeyi sirayla senkronize eder (karar 0114, 0145).

`feeds sync-due` ve `feeds daily` ayni dongüyu kullanir: indirmeler PARALEL
(en fazla 4, birlestirme imlecinin onunde sinirli pencere), isleme SIRAYLA ve verilen
sirayla; bir besleme digerini durdurmaz. Gunluk is bir sure butcesi verebilir (karar 0162).
Her indirme bos diskin payina sinirlidir (`FEED_MIN_FREE_BYTES` korunur).

Burada yeni senkronizasyon mantigi YOK: yazma, kilit, tamlik kapisi, kontrol
noktasi ve deaktivasyon `feeds.sync.FeedSync`'tedir.
"""

from __future__ import annotations

import shutil
import time
from collections.abc import Callable, Sequence
from concurrent.futures import Future, ThreadPoolExecutor
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
    # Tamlik kapisi `truncated`: kaynak dosya yarim uretilmis/kesilmis olabilir ve genelde
    # bir sonraki indirmede tamamlanir; gunluk is mevcut tur/bekleme siniriyla yeniden dener.
    # Diger kapilar (error_rate, too_few_records...) icerik sorunudur: yeniden denenmez.
    # Karar 0152: `truncated` artik YAZMADAN ONCE yakalanir; deneme hicbir satir yazmaz.
    return FeedOutcome(
        feed_id,
        report.status,
        report=report,
        retryable=report.status == "partial" and report.gate in RETRYABLE_GATES,
    )


#: Birlestirme imlecinin onunde en fazla bu kadar besleme indirilmis/indirilmekte olur
#: (disk ve gereksiz indirme siniri). Havuz yine `parallel` kadar iscidir.
PREFETCH_LOOKAHEAD_EXTRA = 1


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
    deadline: float | None = None,
    clock: Callable[[], float] = time.monotonic,
    deferred: list[int] | None = None,
) -> list[FeedOutcome]:
    """`feeds` VERILEN SIRAYLA islenir (karar 0162). Kaynagi degismis olanlar, birlestirme
    imlecinin biraz onunden baslayarak PARALEL indirilir (tum liste bastan degil).

    `deadline` (`clock()` zamaninda): dolduktan sonra YENI besleme birlestirmesi ya da
    indirmesi baslamaz; yarim kalmis bir beslemenin birlestirmesi bitirilir (parca
    kontrol noktalari zaten devam ettirilebilir). Baslatilmayan, kaynagi degismis
    beslemelerin kimlikleri `deferred`'a eklenir; bunlar hata degildir. Kaynagi
    degismemis beslemeler ucuzdur (indirme yok) ve her zaman gecilir.
    """
    parallel = max(1, min(int(parallel), MAX_PARALLEL_DOWNLOADS))
    lookahead = parallel + PREFETCH_LOOKAHEAD_EXTRA
    ordered = list(feeds)
    due_ids = {f.id for f in ordered if is_due(f, force)}
    outcomes: list[FeedOutcome] = []
    if not ordered:
        return outcomes
    free = shutil.disk_usage(staging_dir()).free
    min_free = int(env("FEED_MIN_FREE_BYTES") or 15 << 30)
    budget = max(0, (free - min_free) // lookahead)

    def expired() -> bool:
        return deadline is not None and clock() >= deadline

    with ThreadPoolExecutor(max_workers=parallel) as pool:
        futures: dict[int, Future[tuple[Path, str, int] | None]] = {}
        submitted: set[int] = set()

        def prefetch(upto: int) -> None:
            for feed in ordered[:upto]:
                if feed.id in due_ids and feed.id not in submitted and not expired():
                    submitted.add(feed.id)
                    futures[feed.id] = pool.submit(
                        prefetch_download,
                        feed,
                        network_for(feed.network),
                        max_records=max_records,
                        max_bytes=budget,
                        at=datetime.now(UTC),
                    )

        for index, feed in enumerate(ordered):
            if feed.id in due_ids and expired():
                if deferred is not None:
                    deferred.append(feed.id)
                continue
            prefetch(index + lookahead)
            try:
                prefetched = futures.pop(feed.id).result() if feed.id in futures else None
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
        # Son tarih nedeniyle kullanilmayan on indirmeler: bekleyen is iptal edilir,
        # calisanin dosyasi silinir (bir sonraki kosu yeniden indirir; yarim dosya kalmaz).
        for future in futures.values():
            if future.cancel():
                continue
            try:
                result = future.result()
            except Exception:  # noqa: BLE001 - zaten kayit altina alinmis indirme hatasi
                continue
            if result is not None:
                result[0].unlink(missing_ok=True)
    return outcomes


def pause(seconds: float, sleep: Callable[[float], None] = time.sleep) -> None:
    if seconds > 0:
        sleep(seconds)
