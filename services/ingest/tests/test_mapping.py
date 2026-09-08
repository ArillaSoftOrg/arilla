"""Deger cozumleme. Para float'a HIC dusmemeli."""

from __future__ import annotations

import pytest

from collect.mapping import FieldMapping, ValueFormats
from collect.normalize import normalize_size
from collect.records import RecordRejected

tr = ValueFormats(decimal_separator=",", thousands_separator=".")
en = ValueFormats(decimal_separator=".", thousands_separator=",")


@pytest.mark.parametrize(
    ("formats", "raw", "expected"),
    [
        (tr, "1.234,56 TL", 123456),
        (tr, "1.234,56", 123456),
        (tr, "899,90 TL", 89990),
        (tr, "0,05", 5),
        (tr, "12", 1200),
        (en, "1,234.56", 123456),
        (en, "2074.00 TL", 207400),
        (tr, "", None),
        (tr, None, None),
    ],
)
def test_parse_price(formats: ValueFormats, raw: str | None, expected: int | None) -> None:
    assert formats.parse_price(raw) == expected


def test_parse_price_returns_int_not_float() -> None:
    """Kurus tamsayidir. float donerse fiyat karsilastirmasi guvenilmez olur."""
    value = tr.parse_price("1.234,56 TL")
    assert isinstance(value, int)
    assert not isinstance(value, float)


def test_parse_price_rejects_garbage() -> None:
    with pytest.raises(RecordRejected):
        tr.parse_price("fiyat sorunuz-,-")


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("in stock", True),
        ("IN_STOCK", True),
        ("1", True),
        ("var", True),
        ("out of stock", False),
        ("0", False),
        ("", False),
    ],
)
def test_parse_in_stock(raw: str, expected: bool) -> None:
    assert ValueFormats().parse_in_stock(raw) is expected


def test_missing_required_mapping_is_a_config_error() -> None:
    with pytest.raises(ValueError, match="feed_config.mapping eksik"):
        FieldMapping.from_config({"mapping": {"title": "t"}})


@pytest.mark.parametrize(
    ("label", "expected"),
    [("38", "38"), (" M ", "m"), ("Tek Ebat", "tek-ebat"), ("XL", "xl"), ("", None)],
)
def test_normalize_size(label: str, expected: str | None) -> None:
    assert normalize_size(label) == expected
