"""platforms.flow birim testleri: veritabani, ag ve gercek saat yok (sahte saat/uyku)."""

from __future__ import annotations

import threading
import time
from dataclasses import replace
from datetime import UTC, datetime, timedelta

import pytest

from platforms.constraints import SourceConstraints, UpdateLimits
from platforms.contract import CanonicalListing, Checkpoint, Rejection
from platforms.flow import (
    BatchResult,
    ChangeFilter,
    DailyBudget,
    FilteringSink,
    SourceJob,
    TokenBucket,
    listing_fingerprint,
    run_source,
    run_sources,
)

T0 = datetime(2026, 10, 1, 12, 0, tzinfo=UTC)
EPOCH0 = 1_000_000.0


class FakeClock:
    def __init__(self, start: float = EPOCH0) -> None:
        self.t = start
        self.sleeps: list[float] = []
        self._lock = threading.Lock()

    def __call__(self) -> float:
        return self.t

    def sleep(self, seconds: float) -> None:
        with self._lock:
            self.sleeps.append(seconds)
            self.t += seconds


def make(i: int, platform: str = "p1", **kw) -> CanonicalListing:
    return CanonicalListing(
        platform=platform,
        listing_id=f"L{i}",
        title=f"Urun {i}",
        url=f"https://example.test/{i}",
        currency="TRY",
        observed_at=kw.pop("observed_at", T0),
        price=kw.pop("price", 1000 + i),
        **kw,
    )


class FakeAdapter:
    kind = "json"

    def __init__(self, items, platform="p1", fail_always=False, fail_once_at=None):
        self.items = list(items)
        self.platform = platform
        self.fail_always = fail_always
        self.fail_once_at = fail_once_at

    def fetch(self, checkpoint=None):
        if self.fail_always:
            raise ConnectionError("source down")
        offset = checkpoint.cursor.get("offset", 0) if checkpoint else 0
        for idx in range(offset, len(self.items)):
            if self.fail_once_at is not None and idx == self.fail_once_at:
                self.fail_once_at = None
                raise ConnectionError("transient")
            yield self.items[idx]


class FakeStore:
    def __init__(self):
        self.data: dict[str, Checkpoint] = {}
        self.saves: list[tuple[str, Checkpoint]] = []

    def load(self, key):
        return self.data.get(key)

    def save(self, key, checkpoint):
        self.data[key] = checkpoint
        self.saves.append((key, checkpoint))


class Crash(BaseException):
    """Surec olumu benzetimi: Exception DEGIL, kosucu yakalamaz."""


class FakeSink:
    def __init__(self, fail_calls=(), always_fail=False, crash_on_call=None):
        self.written: list[CanonicalListing] = []
        self.touched: list[CanonicalListing] = []
        self.calls = 0
        self.fail_calls = set(fail_calls)
        self.always_fail = always_fail
        self.crash_on_call = crash_on_call

    def write_batch(self, listings):
        self.calls += 1
        if self.crash_on_call == self.calls:
            raise Crash
        if self.always_fail or self.calls in self.fail_calls:
            raise OSError("db down")
        self.written.extend(listings)
        return BatchResult(written=len(listings))

    def touch_seen(self, listings):
        self.touched.extend(listings)
        return len(listings)


def cons(**kw) -> SourceConstraints:
    base = {"requests_per_minute": 60, "batch_size": 10, "max_consecutive_errors": 3}
    base.update(kw)
    return SourceConstraints(update=UpdateLimits(**base))


def run(adapter, sink, constraints=None, store=None, clock=None, **kw):
    clock = clock or FakeClock()
    store = store if store is not None else FakeStore()
    result = run_source(
        adapter, sink, constraints or cons(), store=store, clock=clock, sleep=clock.sleep, **kw
    )
    return result, store, clock


def ids(listings):
    return [item.listing_id for item in listings]


def test_full_run_completes_and_resets_checkpoint():
    sink = FakeSink()
    result, store, _ = run(FakeAdapter([make(i) for i in range(25)]), sink)
    assert result.status == "completed"
    assert (result.read, result.written, result.batches) == (25, 25, 3)
    assert ids(sink.written) == [f"L{i}" for i in range(25)]
    assert store.data["p1"] == Checkpoint(cursor={}, processed=0)


def test_rate_limit_pacing_is_exact():
    # 45 ilan = 5 parti (son parti kismi, kaynak biter) = 5 istek; 60/dk, burst 1.
    result, _, clock = run(FakeAdapter([make(i) for i in range(45)]), FakeSink())
    assert result.batches == 5
    assert clock.t - EPOCH0 == pytest.approx(4.0)  # ilk istek bedava, 4 x 1 sn


def test_token_bucket_burst_and_refill():
    clock = FakeClock()
    bucket = TokenBucket(120, burst=3, clock=clock)
    assert [bucket.reserve() for _ in range(3)] == [0.0, 0.0, 0.0]
    assert bucket.reserve() == pytest.approx(0.5)
    clock.t += 0.5
    assert bucket.reserve() == 0.0


def test_daily_budget_resets_on_new_day():
    clock = FakeClock(start=86_400.0 * 10)
    budget = DailyBudget(2, clock=clock)
    assert budget.try_consume() and budget.try_consume() and not budget.try_consume()
    clock.t += 86_400
    assert budget.try_consume()


def test_budget_exhaustion_stops_with_checkpoint():
    result, store, _ = run(
        FakeAdapter([make(i) for i in range(100)]), FakeSink(), cons(daily_request_budget=3)
    )
    assert (result.status, result.stop_reason) == ("stopped", "budget_exhausted")
    assert result.written == 30
    assert store.data["p1"].cursor == {"offset": 30}


def test_backpressure_stop_and_resume_has_no_gap_or_duplicate():
    items = [make(i) for i in range(57)]
    full_sink = FakeSink()
    run(FakeAdapter(items), full_sink)

    calls = {"n": 0}

    def throttle():
        calls["n"] += 1
        return calls["n"] <= 3

    store, sink = FakeStore(), FakeSink()
    first, _, _ = run(FakeAdapter(items), sink, store=store, throttle=throttle)
    assert (first.status, first.stop_reason) == ("stopped", "backpressure")
    assert first.written == 30
    second, _, _ = run(FakeAdapter(items), sink, store=store)
    assert second.status == "completed"
    assert ids(sink.written) == ids(full_sink.written)  # ayni sira, tekrar yok, bosluk yok
    assert len(set(ids(sink.written))) == 57


def test_should_stop_before_first_batch():
    result, store, _ = run(FakeAdapter([make(1)]), FakeSink(), should_stop=lambda: True)
    assert (result.status, result.stop_reason) == ("stopped", "should_stop")
    assert store.saves == []


def test_checkpoint_saved_only_after_durable_write_and_crash_resume():
    items = [make(i) for i in range(35)]
    store = FakeStore()
    sink = FakeSink(crash_on_call=3)
    with pytest.raises(Crash):
        run(FakeAdapter(items), sink, store=store)
    # 3. parti yazilamadi: kontrol noktasi yalniz 2 kalici parti (20 kayit) gosterir.
    assert store.data["p1"].cursor == {"offset": 20}
    assert len(sink.written) == 20
    resumed = FakeSink()
    result, _, _ = run(FakeAdapter(items), resumed, store=store)
    assert result.status == "completed"
    assert ids(sink.written + resumed.written) == [f"L{i}" for i in range(35)]


def test_checkpoint_never_ahead_of_written_rows():
    store = FakeStore()
    sink = FakeSink()
    original_save = store.save

    def checked_save(key, checkpoint):
        assert checkpoint.processed <= len(sink.written)
        original_save(key, checkpoint)

    store.save = checked_save
    run(FakeAdapter([make(i) for i in range(33)]), sink, store=store)
    assert len(store.saves) == 5  # 4 parti + tamamlanma sifirlamasi


def test_sink_transient_error_retries_with_backoff_then_succeeds():
    sink = FakeSink(fail_calls={1, 2})
    result, _, clock = run(FakeAdapter([make(i) for i in range(10)]), sink)
    assert result.status == "completed"
    assert result.retries == 2 and result.written == 10 and result.consecutive_errors == 0
    assert clock.sleeps[:2] == [0.5, 1.0]  # ustel geri cekilme


def test_consecutive_sink_errors_cut_off_without_losing_position():
    sink = FakeSink(always_fail=True)
    result, store, _ = run(
        FakeAdapter([make(i) for i in range(30)]), sink, cons(max_consecutive_errors=3)
    )
    assert (result.status, result.stop_reason) == ("stopped", "consecutive_errors")
    assert result.written == 0 and store.saves == []
    assert sink.calls == 3 * 4  # 3 ardisik hata x (1 deneme + 3 yeniden deneme)


def test_adapter_total_failure_marks_source_failed():
    result, _, _ = run(
        FakeAdapter([], fail_always=True), FakeSink(), cons(max_consecutive_errors=2)
    )
    assert (result.status, result.stop_reason) == ("failed", "adapter_error")
    assert "ConnectionError" in (result.error or "")


def test_adapter_midstream_error_refetches_from_durable_checkpoint():
    items = [make(i) for i in range(30)]
    sink = FakeSink()
    result, _, _ = run(FakeAdapter(items, fail_once_at=15), sink)
    assert result.status == "completed" and result.retries == 1
    assert ids(sink.written) == [f"L{i}" for i in range(30)]


def test_rejections_are_counted_and_never_stop_the_run():
    items = [Rejection("bad_price")] * 7 + [make(i) for i in range(5)]
    items += [Rejection("no_title")] * 4 + [make(100)]
    result, _, _ = run(FakeAdapter(items), FakeSink(), cons(max_consecutive_errors=2))
    assert result.status == "completed"
    assert result.rejected_by_code == {"bad_price": 7, "no_title": 4}
    assert result.written == 6 and result.read == 17


def test_adapter_checkpoint_provider_is_used():
    class Provider(FakeAdapter):
        def checkpoint(self):
            return Checkpoint(cursor={"offset": 999, "page": "x"}, processed=7)

    store = FakeStore()
    with pytest.raises(Crash):
        run(Provider([make(i) for i in range(30)]), FakeSink(crash_on_call=2), store=store)
    assert store.data["p1"].cursor == {"offset": 999, "page": "x"}


def test_fingerprint_ignores_observed_at_but_tracks_price_and_stock():
    a = make(1)
    assert listing_fingerprint(a) == listing_fingerprint(
        replace(a, observed_at=T0 + timedelta(days=1))
    )
    assert listing_fingerprint(a) != listing_fingerprint(replace(a, price=a.price + 1))
    assert listing_fingerprint(a) != listing_fingerprint(replace(a, in_stock=False))
    assert listing_fingerprint(a) != listing_fingerprint(replace(a, seller_id="s1"))


def test_second_run_writes_zero_rows_via_change_filter():
    inner = FakeSink()
    cf = ChangeFilter()
    r1, _, _ = run(FakeAdapter([make(i) for i in range(25)]), FilteringSink(inner, cf))
    assert r1.written == 25 and r1.unchanged == 0

    later = [make(i, observed_at=T0 + timedelta(hours=12)) for i in range(25)]
    r2, _, _ = run(FakeAdapter(later), FilteringSink(inner, cf))
    assert (r2.written, r2.unchanged, r2.touched) == (0, 25, 25)
    assert len(inner.written) == 25  # yeni yazma yok
    assert len(inner.touched) == 25  # ama gorulme tazelendi

    changed = list(later)
    changed[3] = make(3, price=1)
    r3, _, _ = run(FakeAdapter(changed), FilteringSink(inner, cf))
    assert (r3.written, r3.unchanged) == (1, 24)


def test_change_filter_not_committed_when_write_fails():
    cf = ChangeFilter()
    failing = FilteringSink(FakeSink(always_fail=True), cf)
    run(FakeAdapter([make(i) for i in range(5)]), failing, cons(max_consecutive_errors=1))
    assert len(cf) == 0  # yazilamayan ilan "degismemis" sayilmaz


def test_run_sources_isolates_errors():
    clock = FakeClock()
    good_a, good_b = FakeSink(), FakeSink()
    jobs = [
        SourceJob(FakeAdapter([make(i, "good-a") for i in range(15)], "good-a"), good_a, cons()),
        SourceJob(FakeAdapter([], "bad-net", fail_always=True), FakeSink(), cons()),
        SourceJob(
            FakeAdapter([make(i, "bad-sink") for i in range(15)], "bad-sink"),
            FakeSink(always_fail=True),
            cons(max_consecutive_errors=1),
        ),
        SourceJob(FakeAdapter([make(i, "good-b") for i in range(15)], "good-b"), good_b, cons()),
    ]
    results = run_sources(
        jobs, store=FakeStore(), clock=clock, sleep=clock.sleep, now=T0, max_workers=3
    )
    assert results["good-a"].status == "completed" and len(good_a.written) == 15
    assert results["good-b"].status == "completed" and len(good_b.written) == 15
    assert results["bad-net"].status == "failed"
    assert results["bad-sink"].status == "stopped"


def test_run_sources_converts_unexpected_exception_to_failed():
    class BrokenStore(FakeStore):
        def load(self, key):
            raise RuntimeError("store exploded")

    clock = FakeClock()
    jobs = [SourceJob(FakeAdapter([make(1)], "p1"), FakeSink(), cons())]
    results = run_sources(jobs, store=BrokenStore(), clock=clock, sleep=clock.sleep, now=T0)
    assert results["p1"].status == "failed"
    assert results["p1"].stop_reason == "unexpected_error"


def test_run_sources_respects_refresh_due():
    clock = FakeClock()
    constraints = cons(min_refresh_interval=timedelta(hours=6))
    sink_wait = FakeSink()
    jobs = [
        SourceJob(
            FakeAdapter([make(1, "due")], "due"),
            FakeSink(),
            constraints,
            T0 - timedelta(hours=7),
        ),
        SourceJob(
            FakeAdapter([make(1, "wait")], "wait"),
            sink_wait,
            constraints,
            T0 - timedelta(hours=1),
        ),
        SourceJob(FakeAdapter([make(1, "never")], "never"), FakeSink(), constraints, None),
    ]
    results = run_sources(jobs, store=FakeStore(), clock=clock, sleep=clock.sleep, now=T0)
    assert results["due"].status == "completed"
    assert (results["wait"].status, results["wait"].stop_reason) == (
        "skipped",
        "refresh_not_due",
    )
    assert sink_wait.calls == 0
    assert results["never"].status == "completed"


class SlowAdapter(FakeAdapter):
    tracker: dict = {}

    def fetch(self, checkpoint=None):
        t = self.tracker
        with t["lock"]:
            t["active"] += 1
            t["peak"] = max(t["peak"], t["active"])
            t["by"][self.platform] = t["by"].get(self.platform, 0) + 1
            t["peak_by"][self.platform] = max(
                t["peak_by"].get(self.platform, 0), t["by"][self.platform]
            )
        try:
            time.sleep(0.02)
            yield from super().fetch(checkpoint)
        finally:
            with t["lock"]:
                t["active"] -= 1
                t["by"][self.platform] -= 1


def test_run_sources_global_cap_and_per_platform_concurrency():
    tracker = {"lock": threading.Lock(), "active": 0, "peak": 0, "by": {}, "peak_by": {}}
    SlowAdapter.tracker = tracker
    clock = FakeClock()
    one = cons(max_concurrency=1, requests_per_minute=6000)
    jobs = [
        SourceJob(SlowAdapter([make(1, "same")], "same"), FakeSink(), one, name=f"same-{k}")
        for k in range(3)
    ] + [SourceJob(SlowAdapter([make(1, f"o{k}")], f"o{k}"), FakeSink(), one) for k in range(4)]
    results = run_sources(
        jobs, store=FakeStore(), clock=clock, sleep=clock.sleep, now=T0, max_workers=3
    )
    assert all(r.status == "completed" for r in results.values())
    assert tracker["peak"] <= 3
    assert tracker["peak_by"]["same"] == 1
