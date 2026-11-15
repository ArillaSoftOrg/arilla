"""Kaynak markasi -> mevcut marka baglama (karar 0209): saf kararlar, veritabani yok."""

from __future__ import annotations

import pytest

from classify.brand_link import (
    BrandIndex,
    NotLocalError,
    assert_local,
    decide_link,
    is_seller_like,
)
from classify.brands import clean_source_brand

INDEX = BrandIndex(
    [
        (1, "La Roche-Posay", "laroche-posay"),
        (2, "Xiaomi", "xiaomi"),
        (3, "Hill's", "hill's"),
        (4, "Acme", "acme"),
        (5, "ACME", "acme"),  # ayni anahtar, iki satir: belirsiz
    ]
)


def test_exact_normalized_match() -> None:
    assert decide_link("XIAOMI", "Hepsiburada", INDEX).brand_id == 2
    assert decide_link("xiaomi ", "Hepsiburada", INDEX).brand_id == 2
    assert decide_link("La Roche-Posay", "Hepsiburada", INDEX).brand_id == 1
    assert decide_link("Hill’s", "Hepsiburada", INDEX).brand_id == 3  # tipografik kesme


def test_no_fuzzy_match() -> None:
    v = decide_link("Xiaomi Mi", "Hepsiburada", INDEX)
    assert v.brand_id is None and v.reason == "no_match" and v.new_name == "Xiaomi Mi"
    assert decide_link("Xiaom", "Hepsiburada", INDEX).brand_id is None


def test_ambiguous_key_not_linked() -> None:
    v = decide_link("Acme", "Hepsiburada", INDEX)
    assert v.brand_id is None and v.reason == "ambiguous" and v.new_name is None


@pytest.mark.parametrize("raw", ["No Brand", "Markasız", "Diğer", "OEM", "1001", "", None])
def test_junk_and_empty(raw: str | None) -> None:
    v = decide_link(raw, "Hepsiburada", INDEX)
    assert v.brand_id is None and v.new_name is None and v.reason in ("empty", "junk")


def test_merchant_name_is_not_a_brand() -> None:
    assert decide_link("Hepsiburada", "Hepsiburada", INDEX).reason == "junk"


@pytest.mark.parametrize(
    "raw", ["Store", "Hype Store", "Senastore", "SesaShop", "Xml Bayiciniz", "Expermarket"]
)
def test_seller_like_values_are_skipped(raw: str) -> None:
    assert is_seller_like(raw)
    v = decide_link(raw, "Hepsiburada", INDEX)
    assert v.brand_id is None and v.new_name is None and v.reason == "seller_like"


def test_real_brands_not_seller_like() -> None:
    for name in ("Philips Avent", "Sudocrem", "Paşabahçe", "Karaca", "Decathlon"):
        assert not is_seller_like(name)


def test_turkish_uppercase_has_no_combining_dot() -> None:
    cleaned = clean_source_brand("LİVİNGSTORE")
    assert cleaned is not None and "̇" not in cleaned


class _Info:
    def __init__(self, host: str) -> None:
        self.host = host


class _Conn:
    def __init__(self, host: str) -> None:
        self.info = _Info(host)


@pytest.mark.parametrize("host", ["localhost", "127.0.0.1", "::1", "/var/run/postgresql"])
def test_local_hosts_allowed(host: str) -> None:
    assert_local(_Conn(host))  # type: ignore[arg-type]


@pytest.mark.parametrize("host", ["187.7.77.163", "db.example.com", "10.0.0.5"])
def test_remote_hosts_refused(host: str) -> None:
    with pytest.raises(NotLocalError):
        assert_local(_Conn(host))  # type: ignore[arg-type]
