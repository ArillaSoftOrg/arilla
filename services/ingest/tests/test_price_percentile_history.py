"""Yuzdelik yalnizca yeterli ve degisken fiyat gecmisi varken uretilir (AI denetimi A5).

`price_point` her calismada yazilir, fiyat degismese bile. Tek gozlem ya da sabit
fiyatli bir gecmis eskiden `below / n = 0` verip "son 90 gunun en ucuzu"
iddiasi uretiyordu; "En iyi firsatlar" sekmesi `current_percentile ASC` ile
siraladigi icin hic indirim gormemis urunler en uste yigiliyordu.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from similarity.prices import (
    MIN_PERCENTILE_DISTINCT_PRICES,
    MIN_PERCENTILE_OBSERVATIONS,
    MIN_PERCENTILE_SPAN,
    Observation,
    compute,
)

NOW = datetime(2026, 10, 1, tzinfo=UTC)


def _series(prices: list[int], *, step_days: float = 1.0) -> list[Observation]:
    start = NOW - timedelta(days=step_days * (len(prices) - 1))
    return [
        Observation(observed_at=start + timedelta(days=step_days * i), price=p, list_price=None)
        for i, p in enumerate(prices)
    ]


def test_single_observation_has_no_percentile() -> None:
    stats = compute({1: _series([1000])}, current_price=1000)
    assert stats.current_percentile is None


def test_flat_history_has_no_percentile() -> None:
    stats = compute({1: _series([1000] * 30)}, current_price=1000)
    assert stats.current_percentile is None


def test_too_few_observations_have_no_percentile() -> None:
    prices = [1200, 1100, 1000][: MIN_PERCENTILE_OBSERVATIONS - 1]
    stats = compute({1: _series(prices, step_days=5)}, current_price=prices[-1])
    assert stats.current_percentile is None


def test_history_shorter_than_the_minimum_span_has_no_percentile() -> None:
    step = (MIN_PERCENTILE_SPAN / 2).total_seconds() / 86400 / (MIN_PERCENTILE_OBSERVATIONS)
    prices = [1200, 1100] * MIN_PERCENTILE_OBSERVATIONS
    stats = compute({1: _series(prices, step_days=step)}, current_price=prices[-1])
    assert stats.current_percentile is None


def test_real_drop_to_the_lowest_price_is_still_the_cheapest() -> None:
    prices = [1200] * 20 + [1000]
    stats = compute({1: _series(prices)}, current_price=1000)
    assert stats.current_percentile == 0


def test_current_price_at_the_top_of_a_varied_history() -> None:
    prices = [1000] * 10 + [1200] * 10
    stats = compute({1: _series(prices)}, current_price=1200)
    assert stats.current_percentile == 50


def test_minimum_constants_are_sane() -> None:
    assert MIN_PERCENTILE_DISTINCT_PRICES >= 2
    assert MIN_PERCENTILE_OBSERVATIONS >= 3
    assert timedelta(days=1) <= MIN_PERCENTILE_SPAN


def test_other_statistics_are_unaffected_by_the_gate() -> None:
    stats = compute({1: _series([1000])}, current_price=1000)
    assert stats.min_90d == 1000
    assert stats.max_90d == 1000
    assert stats.median_90d == 1000
