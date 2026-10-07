"""`EMBEDDING_COST_MICROS_PER_1K_TOKENS` ayristirmasi.

`packages/core/src/embedding/embed-uploaded-image.ts`
(`costMicrosPerThousandTokens`) ile ayni kural: yalnizca negatif olmayan duz
tamsayi gecerli, gecersiz deger 0 ve surec basina tek uyari.
"""

from __future__ import annotations

import logging

import pytest

from db import usage

ENV = "EMBEDDING_COST_MICROS_PER_1K_TOKENS"


@pytest.fixture(autouse=True)
def _reset_warning_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(usage, "_invalid_cost_rate_reported", False)


def test_unset_or_blank_rate_is_zero(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(ENV, raising=False)
    assert usage.cost_micros_per_1k_tokens() == 0
    for raw in ("", "   "):
        monkeypatch.setenv(ENV, raw)
        assert usage.cost_micros_per_1k_tokens() == 0


@pytest.mark.parametrize(("raw", "expected"), [("0", 0), ("250", 250), (" 1200 ", 1200)])
def test_plain_non_negative_integer_is_used(
    monkeypatch: pytest.MonkeyPatch, raw: str, expected: int
) -> None:
    monkeypatch.setenv(ENV, raw)
    assert usage.cost_micros_per_1k_tokens() == expected


def test_invalid_rate_is_zero_and_warns_once_without_value(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.WARNING, logger=usage.__name__)
    for raw in ("abc", "-5", "1.5", "1e3", "0x10", "12abc", "٣", "99999999999999999999"):
        monkeypatch.setenv(ENV, raw)
        assert usage.cost_micros_per_1k_tokens() == 0
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert "abc" not in warnings[0].getMessage()
