"""Kaynak akis kosucusu: SAF, bagimliligi disaridan verilen ice aktarim akisi (karar 0163).

Veritabani, ag, gercek saat ve uyku YOK: saat, uyku, sink (yazici), kontrol noktasi deposu,
`throttle` (WAL geri basinci, `db/wal_pressure.py`) ve `should_stop` disaridan verilir. Boylece
akis hizi, durdurma, devam etme ve hata izolasyonu birim testle KESIN olculur.

Garanti modeli: **en az bir kez + idempotent yazici**.

- Kontrol noktasi YALNIZCA bir parti kalici yazildiktan sonra saklanir. Yazici ortasinda
  coker ya da surec olurse son kalici noktadan devam edilir; en kotu durumda son parti bir
  daha yazilir (yazici `(merchant_id, external_id)` ile idempotent olmali, kural 7).
- Tek bozuk kayit (`Rejection`) sayilir, kosuyu DURDURMAZ.
- Durma nedenleri (`stopped`): `should_stop`, `backpressure` (throttle False), gunluk butce
  bitti, ardisik sink hatasi siniri. Kaynagin tamami erisilemezse (`adapter_error`) o kaynak
  `failed` olur; baska kaynak etkilenmez.

Bir "istek" birimi = adapter'dan cekilen bir parti (adapter sayfa boyu ~ `batch_size` olmali).

Adapter istege bagli `checkpoint() -> Checkpoint` sunabilir: bir parti cekildikten SONRA
cagrilir ve adapter'in tuketilen son kayittan sonraki imlecini dondurur. Yoksa kosucu
`Checkpoint(cursor={"offset": tuketilen}, processed=tuketilen)` uretir (`offset` yorumu
adapter'a aittir).
"""

from __future__ import annotations

import hashlib
import threading
from collections import Counter
from collections.abc import Callable, Iterator, Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal, Protocol

from platforms.constraints import SourceConstraints, refresh_due
from platforms.contract import CanonicalListing, Checkpoint, Rejection, SourceAdapter

Clock = Callable[[], float]  # epoch saniye (gun siniri icin de kullanilir)
Sleep = Callable[[float], None]

RunStatus = Literal["completed", "stopped", "failed", "skipped"]

#: Sink hatasinda parti basina en fazla bu kadar hizli yeniden deneme (ustel geri cekilme).
DEFAULT_SINK_RETRIES = 3
BACKOFF_BASE_S = 0.5
BACKOFF_CAP_S = 30.0
_EPS = 1e-9


# --- hiz sinirlayici ----------------------------------------------------------------


class TokenBucket:
    """Belirtec kovasi: dakikada `rate_per_minute` istek, `burst` birikim. Is parcacigi guvenli."""

    def __init__(self, rate_per_minute: float, burst: int = 1, *, clock: Clock) -> None:
        if rate_per_minute <= 0 or burst < 1:
            raise ValueError("rate_per_minute > 0 ve burst >= 1 olmali")
        self._rate = rate_per_minute / 60.0
        self._capacity = float(burst)
        self._tokens = float(burst)
        self._clock = clock
        self._last = clock()
        self._lock = threading.Lock()

    def reserve(self) -> float:
        """Belirtec alindiysa 0.0, yoksa beklenecek saniye (belirteç alinmaz)."""
        with self._lock:
            now = self._clock()
            self._tokens = min(
                self._capacity, self._tokens + max(0.0, now - self._last) * self._rate
            )
            self._last = now
            if self._tokens >= 1.0 - _EPS:
                self._tokens -= 1.0
                return 0.0
            return (1.0 - self._tokens) / self._rate

    def acquire(self, sleep: Sleep) -> float:
        """Belirtec alinana dek uyur; toplam beklenen sureyi dondurur."""
        waited = 0.0
        while True:
            wait = self.reserve()
            if wait <= 0.0:
                return waited
            sleep(wait)
            waited += wait


class DailyBudget:
    """Gunluk istek butcesi (UTC gunu = `clock() // 86400`). `limit=None` sinirsiz."""

    def __init__(self, limit: int | None, *, clock: Clock) -> None:
        self._limit = limit
        self._clock = clock
        self._day = int(clock() // 86400)
        self._used = 0
        self._lock = threading.Lock()

    @property
    def used(self) -> int:
        return self._used

    def try_consume(self, n: int = 1) -> bool:
        with self._lock:
            day = int(self._clock() // 86400)
            if day != self._day:
                self._day, self._used = day, 0
            if self._limit is not None and self._used + n > self._limit:
                return False
            self._used += n
            return True


# --- degisiklik suzgeci -------------------------------------------------------------


def listing_fingerprint(listing: CanonicalListing) -> str:
    """Fiyat/liste fiyati/stok/baslik/para birimi/satici icin sha256. `observed_at` DAHIL DEGIL."""
    parts = (
        listing.platform,
        listing.listing_id,
        "" if listing.price is None else str(listing.price),
        "" if listing.list_price is None else str(listing.list_price),
        "" if listing.in_stock is None else ("1" if listing.in_stock else "0"),
        listing.title,
        listing.currency,
        listing.seller_id or "",
    )
    return hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()


ListingKey = tuple[str, str, str]


def listing_key(listing: CanonicalListing) -> ListingKey:
    return (listing.platform, listing.listing_id, listing.seller_id or "")


class ChangeFilter:
    """Kosular arasi degismeyen ilanlari eler.

    `split` yalniz sinifLar; bilinen parmak izi `commit` ile, YAZMA KALICI olduktan sonra
    guncellenir (yazma cokerse ilan "degismemis" sayilmaz). Degismeyenler `unchanged` olarak
    ayri doner: satir yeniden yazilmaz ama `last_seen_at` tazelenir (gorulme kaydi korunur).
    """

    def __init__(self, known: Mapping[ListingKey, str] | None = None) -> None:
        self._known: dict[ListingKey, str] = dict(known or {})

    def __len__(self) -> int:
        return len(self._known)

    def snapshot(self) -> dict[ListingKey, str]:
        return dict(self._known)

    def split(
        self, listings: Sequence[CanonicalListing]
    ) -> tuple[list[tuple[CanonicalListing, str]], list[CanonicalListing]]:
        changed: list[tuple[CanonicalListing, str]] = []
        unchanged: list[CanonicalListing] = []
        known = self._known
        for listing in listings:
            fp = listing_fingerprint(listing)
            if known.get(listing_key(listing)) == fp:
                unchanged.append(listing)
            else:
                changed.append((listing, fp))
        return changed, unchanged

    def commit(self, changed: Sequence[tuple[CanonicalListing, str]]) -> None:
        for listing, fp in changed:
            self._known[listing_key(listing)] = fp


# --- sink ve depo sozlesmeleri ------------------------------------------------------


@dataclass(frozen=True)
class BatchResult:
    written: int
    unchanged: int = 0
    #: Yalniz `last_seen_at` tazelenen satir sayisi (yeniden yazilmadi).
    touched: int = 0


class ListingSink(Protocol):
    def write_batch(self, listings: list[CanonicalListing]) -> BatchResult:
        """Partiyi KALICI yazar (commit sonrasi doner). Idempotent olmali."""
        ...


class CheckpointStore(Protocol):
    def load(self, key: str) -> Checkpoint | None: ...

    def save(self, key: str, checkpoint: Checkpoint) -> None: ...


class FilteringSink:
    """`ChangeFilter` ile sink sarar: yalniz degisenleri yazar, digerleri `touch_seen`e gider.

    `inner.touch_seen(listings) -> int` istege baglidir; yoksa degismeyen ilanlar yalnizca
    `unchanged` olarak sayilir.
    """

    def __init__(self, inner: ListingSink, change_filter: ChangeFilter) -> None:
        self._inner = inner
        self._filter = change_filter

    def write_batch(self, listings: list[CanonicalListing]) -> BatchResult:
        changed, unchanged = self._filter.split(listings)
        written = 0
        if changed:
            written = self._inner.write_batch([listing for listing, _ in changed]).written
            self._filter.commit(changed)
        touched = 0
        touch = getattr(self._inner, "touch_seen", None)
        if unchanged and callable(touch):
            touched = int(touch(unchanged))
        return BatchResult(written=written, unchanged=len(unchanged), touched=touched)


# --- sonuc --------------------------------------------------------------------------


@dataclass
class SourceResult:
    platform: str
    status: RunStatus = "completed"
    stop_reason: str | None = None
    read: int = 0
    written: int = 0
    unchanged: int = 0
    touched: int = 0
    rejected_by_code: dict[str, int] = field(default_factory=dict)
    batches: int = 0
    retries: int = 0
    consecutive_errors: int = 0
    error: str | None = None
    checkpoint: Checkpoint | None = None

    @property
    def rejected(self) -> int:
        return sum(self.rejected_by_code.values())


# --- tek kaynak ---------------------------------------------------------------------


def _backoff(attempt: int) -> float:
    return min(BACKOFF_CAP_S, BACKOFF_BASE_S * (2**attempt))


def _checkpoint_after(adapter: SourceAdapter, consumed: int) -> Checkpoint:
    # Adapter kontrol noktasini nitelik ya da cagrilabilir olarak verebilir.
    provider = getattr(adapter, "checkpoint", None)
    cp = provider() if callable(provider) else provider
    if isinstance(cp, Checkpoint):
        return cp
    return Checkpoint(cursor={"offset": consumed}, processed=consumed)


def _err(exc: BaseException) -> str:
    return f"{type(exc).__name__}: {str(exc)[:200]}"


def run_source(
    adapter: SourceAdapter,
    sink: ListingSink,
    constraints: SourceConstraints,
    *,
    store: CheckpointStore,
    clock: Clock,
    sleep: Sleep,
    throttle: Callable[[], bool] | None = None,
    should_stop: Callable[[], bool] = lambda: False,
    key: str | None = None,
    bucket: TokenBucket | None = None,
    budget: DailyBudget | None = None,
    burst: int = 1,
    sink_retries: int = DEFAULT_SINK_RETRIES,
    on_batch: Callable[[SourceResult], None] | None = None,
) -> SourceResult:
    """Bir kaynagi sinirlar icinde calistirir. Beklenen adapter/sink hatalari ISTISNA FIRLATMAZ."""
    limits = constraints.update
    ckey = key or adapter.platform
    bucket = bucket or TokenBucket(limits.requests_per_minute, burst, clock=clock)
    budget = budget or DailyBudget(limits.daily_request_budget, clock=clock)
    result = SourceResult(platform=adapter.platform)

    durable = store.load(ckey)
    result.checkpoint = durable
    base = durable.processed if durable else 0  # kalici olarak tuketilen kayit sayisi
    iterator: Iterator[CanonicalListing | Rejection] | None = None
    max_errors = limits.max_consecutive_errors

    def stop(reason: str) -> SourceResult:
        result.status, result.stop_reason = "stopped", reason
        return result

    while True:
        if should_stop():
            return stop("should_stop")
        if throttle is not None and not throttle():
            return stop("backpressure")
        if not budget.try_consume(1):
            return stop("budget_exhausted")
        bucket.acquire(sleep)

        # Partiyi cek. Hata olursa son kalici noktadan yeniden cekilir (parti bellekte, atilir).
        batch: list[CanonicalListing] = []
        rejected: Counter[str] = Counter()
        pulled = 0
        exhausted = False
        try:
            if iterator is None:
                iterator = iter(adapter.fetch(durable))
            while len(batch) < limits.batch_size:
                try:
                    item = next(iterator)
                except StopIteration:
                    exhausted = True
                    break
                pulled += 1
                if isinstance(item, Rejection):
                    rejected[item.code] += 1
                else:
                    batch.append(item)
        except Exception as exc:
            iterator = None
            result.error = _err(exc)
            result.consecutive_errors += 1
            if result.consecutive_errors >= max_errors:
                result.status, result.stop_reason = "failed", "adapter_error"
                return result
            result.retries += 1
            sleep(_backoff(result.consecutive_errors - 1))
            continue

        if batch:
            written: BatchResult | None = None
            for attempt in range(sink_retries + 1):
                try:
                    written = sink.write_batch(batch)
                    break
                except Exception as exc:
                    result.error = _err(exc)
                    if attempt < sink_retries:
                        result.retries += 1
                        sleep(_backoff(attempt))
            if written is None:
                # Hizli denemeler bitti: ardisik hata sayilir. Kalici nokta ilerlemedi; ayni
                # parti son kalici noktadan yeniden cekilir (bosluk ve tekrar yok).
                result.consecutive_errors += 1
                if result.consecutive_errors >= max_errors:
                    return stop("consecutive_errors")
                iterator = None
                sleep(_backoff(result.consecutive_errors - 1))
                continue
            result.consecutive_errors = 0
            result.written += written.written
            result.unchanged += written.unchanged
            result.touched += written.touched
            result.batches += 1
            base += pulled
            durable = _checkpoint_after(adapter, base)
            store.save(ckey, durable)  # YALNIZ kalici yazimdan sonra
            result.checkpoint = durable
        else:
            base += pulled
        result.read += pulled
        for code, n in rejected.items():
            result.rejected_by_code[code] = result.rejected_by_code.get(code, 0) + n
        if on_batch is not None:
            on_batch(result)
        if exhausted:
            # Tam tur bitti: sonraki kosu bastan baslasin (yenileme).
            done = Checkpoint(cursor={}, processed=0)
            store.save(ckey, done)
            result.checkpoint = done
            result.status = "completed"
            return result


# --- cok kaynak ---------------------------------------------------------------------


@dataclass
class SourceJob:
    """`run_sources` girdisi. `name`: ayni platformdaki isler icin kontrol noktasi anahtari."""

    adapter: SourceAdapter
    sink: ListingSink
    constraints: SourceConstraints
    last_run_at: datetime | None = None
    name: str | None = None

    @property
    def platform(self) -> str:
        return self.adapter.platform

    @property
    def key(self) -> str:
        return self.name or self.adapter.platform


def run_sources(
    jobs: Sequence[SourceJob],
    *,
    store: CheckpointStore,
    clock: Clock,
    sleep: Sleep,
    now: datetime,
    max_workers: int = 4,
    throttle: Callable[[], bool] | None = None,
    should_stop: Callable[[], bool] = lambda: False,
) -> dict[str, SourceResult]:
    """Kaynaklari hata izolasyonuyla calistirir; sonuc `job.key` ile anahtarlanir.

    - Her kaynak `refresh_due` ile sinanir; vadesi gelmeyen `skipped` olur.
    - Genel iscilik siniri `max_workers`; ayni platformda eszamanli is sayisi, o platformun
      islerinin en kucuk `max_concurrency` degeriyle sinirlidir.
    - Ayni platformun isleri TEK `TokenBucket` ve `DailyBudget` paylasir (platform siniri).
    - Beklenmeyen istisna yalnizca o kaynagi `failed` yapar.
    """
    keys = [j.key for j in jobs]
    if len(set(keys)) != len(keys):
        raise ValueError("job.key degerleri benzersiz olmali")
    results: dict[str, SourceResult] = {}
    runnable: list[SourceJob] = []
    for job in jobs:
        if refresh_due(job.constraints, job.last_run_at, now):
            runnable.append(job)
        else:
            results[job.key] = SourceResult(
                platform=job.platform, status="skipped", stop_reason="refresh_not_due"
            )

    buckets: dict[str, TokenBucket] = {}
    budgets: dict[str, DailyBudget] = {}
    concurrency: dict[str, int] = {}
    for job in runnable:
        platform, limits = job.platform, job.constraints.update
        if platform not in buckets:
            buckets[platform] = TokenBucket(limits.requests_per_minute, clock=clock)
            budgets[platform] = DailyBudget(limits.daily_request_budget, clock=clock)
        # Ayni platformda en siki sinir gecerli.
        concurrency[platform] = min(concurrency.get(platform, 10**9), limits.max_concurrency)
    gates = {p: threading.BoundedSemaphore(n) for p, n in concurrency.items()}

    def work(job: SourceJob) -> tuple[str, SourceResult]:
        with gates[job.platform]:
            try:
                res = run_source(
                    job.adapter,
                    job.sink,
                    job.constraints,
                    store=store,
                    clock=clock,
                    sleep=sleep,
                    throttle=throttle,
                    should_stop=should_stop,
                    key=job.key,
                    bucket=buckets[job.platform],
                    budget=budgets[job.platform],
                )
            except Exception as exc:  # hata izolasyonu: diger kaynaklar surer
                res = SourceResult(
                    platform=job.platform,
                    status="failed",
                    stop_reason="unexpected_error",
                    error=_err(exc),
                )
            return job.key, res

    if runnable:
        with ThreadPoolExecutor(max_workers=max(1, max_workers)) as pool:
            for key, res in pool.map(work, runnable):
                results[key] = res
    return {k: results[k] for k in keys}


__all__ = [
    "BatchResult",
    "ChangeFilter",
    "CheckpointStore",
    "DailyBudget",
    "FilteringSink",
    "ListingSink",
    "SourceJob",
    "SourceResult",
    "TokenBucket",
    "listing_fingerprint",
    "listing_key",
    "run_source",
    "run_sources",
]
