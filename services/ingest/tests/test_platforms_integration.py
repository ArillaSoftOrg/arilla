"""Adapter -> akis -> eslestirme uc uca (bellek ici, DB/ag yok; ornek veriyle)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

from platforms.adapters import build_adapter
from platforms.adapters.samples import (
    HEPSIBURADA_SAMPLE_MAPPING,
    TRENDYOL_SAMPLE_MAPPING,
)
from platforms.constraints import SourceConstraints, UpdateLimits
from platforms.contract import CanonicalListing, Checkpoint
from platforms.flow import BatchResult, ChangeFilter, FilteringSink, run_source
from platforms.matching import match_listings
from platforms.registry import HEPSIBURADA, TRENDYOL

FIXTURES = Path(__file__).parent / "fixtures" / "platforms"
NOW = datetime(2026, 10, 31, 12, 0, tzinfo=UTC)


class Sink:
    def __init__(self) -> None:
        self.rows: list[CanonicalListing] = []

    def write_batch(self, listings: list[CanonicalListing]) -> BatchResult:
        self.rows.extend(listings)
        return BatchResult(written=len(listings))


class Store:
    def __init__(self) -> None:
        self.data: dict[str, Checkpoint] = {}

    def load(self, key: str) -> Checkpoint | None:
        return self.data.get(key)

    def save(self, key: str, checkpoint: Checkpoint) -> None:
        self.data[key] = checkpoint


def _constraints(batch: int) -> SourceConstraints:
    return SourceConstraints(
        update=UpdateLimits(batch_size=batch, requests_per_minute=60_000, max_concurrency=1)
    )


def _trendyol():
    return build_adapter(
        TRENDYOL,
        FIXTURES / "trendyol_sample.json",
        TRENDYOL_SAMPLE_MAPPING,
        records_path="content",
        observed_at=NOW,
    )


def _hepsiburada():
    return build_adapter(
        HEPSIBURADA,
        FIXTURES / "hepsiburada_sample.json",
        HEPSIBURADA_SAMPLE_MAPPING,
        records_path="products",
        observed_at=NOW,
    )


class _Clock:
    def __init__(self) -> None:
        self.t = 0.0

    def now(self) -> float:
        return self.t

    def sleep(self, seconds: float) -> None:
        self.t += seconds


def _run(adapter, sink, store, batch, **kw):
    clk = _Clock()
    return run_source(
        adapter,
        sink,
        _constraints(batch),
        store=store,
        clock=clk.now,
        sleep=clk.sleep,
        **kw,
    )


def test_adapter_resume_through_flow_matches_full_run() -> None:
    full = Sink()
    full_result = _run(_trendyol(), full, Store(), 4)
    assert full_result.status == "completed"
    assert full_result.rejected > 0  # ornekte bilincli bozuk kayitlar var

    # Ilk partiden sonra dur (geri basinc), sonra yeni adapter ile kalinan yerden surdur.
    store, part = Store(), Sink()
    calls = {"n": 0}

    def throttle() -> bool:
        calls["n"] += 1
        return calls["n"] <= 1

    first = _run(_trendyol(), part, store, 4, throttle=throttle)
    assert first.status == "stopped"
    assert 0 < len(part.rows) < len(full.rows)
    second = _run(_trendyol(), part, store, 4)
    assert second.status == "completed"
    assert [(x.listing_id, x.seller_id) for x in part.rows] == [
        (x.listing_id, x.seller_id) for x in full.rows
    ]
    assert first.rejected + second.rejected == full_result.rejected


def test_second_run_writes_nothing_through_change_filter() -> None:
    inner = Sink()
    sink = FilteringSink(inner, ChangeFilter())
    _run(_hepsiburada(), sink, Store(), 5)
    written = len(inner.rows)
    assert written > 0
    again = _run(_hepsiburada(), sink, Store(), 5)
    assert len(inner.rows) == written
    assert again.written == 0 and again.unchanged == written


def test_cross_platform_match_on_sample_data_never_merges_uncertain() -> None:
    inner = Sink()
    _run(_hepsiburada(), inner, Store(), 100)
    _run(_trendyol(), inner, Store(), 100)
    result = match_listings(inner.rows)
    assert result.stats.listings >= 15
    for cluster in result.clusters:
        if cluster.status == "merged":
            assert cluster.basis in {"gtin", "brand_mpn"}
    # Ayni listing'i satan farkli saticilar tek urun kumesinde kalir, ayri urun olmaz.
    sellers = {(x.listing_id) for x in inner.rows if x.platform == "trendyol"}
    members = [m for c in result.clusters for m in c.members if m[0] == "trendyol"]
    assert len({(m[0], m[1]) for m in members}) == len(sellers)


def test_stale_price_is_not_displayable_after_constraint_window() -> None:
    from platforms.constraints import price_displayable

    c = HEPSIBURADA.constraints
    ok, _ = price_displayable(c, currency="TRY", observed_at=NOW, now=NOW)
    assert ok
    ok, reason = price_displayable(
        c, currency="TRY", observed_at=NOW, now=NOW + c.update.max_price_age + timedelta(seconds=1)
    )
    assert (ok, reason) == (False, "price_stale")
