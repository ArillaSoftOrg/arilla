"""`EMBEDDING_COST_MICROS_PER_1K_TOKENS`: fiyat uydurulmaz, gecersiz deger isi durdurmaz."""

from __future__ import annotations

import logging

import pytest

from db import usage


@pytest.fixture(autouse=True)
def _reset_warning(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(usage, "_cost_config_reported", False)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [(None, 0), ("", 0), ("0", 0), ("125", 125), (" 125 ", 125), ("-5", 0), ("1.5", 0), ("abc", 0)],
)
def test_cost_value(monkeypatch: pytest.MonkeyPatch, raw: str | None, expected: int) -> None:
    if raw is None:
        monkeypatch.delenv("EMBEDDING_COST_MICROS_PER_1K_TOKENS", raising=False)
    else:
        monkeypatch.setenv("EMBEDDING_COST_MICROS_PER_1K_TOKENS", raw)
    assert usage.cost_micros_per_1k_tokens() == expected


def test_missing_price_is_logged_once(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.delenv("EMBEDDING_COST_MICROS_PER_1K_TOKENS", raising=False)
    with caplog.at_level(logging.WARNING, logger="db.usage"):
        usage.cost_micros_per_1k_tokens()
        usage.cost_micros_per_1k_tokens()
    assert len(caplog.records) == 1


def test_configured_price_is_not_logged(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setenv("EMBEDDING_COST_MICROS_PER_1K_TOKENS", "125")
    with caplog.at_level(logging.WARNING, logger="db.usage"):
        usage.cost_micros_per_1k_tokens()
    assert caplog.records == []
