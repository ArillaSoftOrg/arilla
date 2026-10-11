"""Fiyat ayristirma ve para birimi korumalari (AI denetimi A6).

Eskiden: JSON-LD'deki "1.299,00" 130 kurus (1,30 TL), "1299,90" 12.999.000 kurus
oluyordu; eksik para birimi sessizce TRY sayiliyordu; varsayilan Turkce bicim
"12.5" ve "1299.90" gibi metinleri sessizce 10x-1000x yanlis okuyordu.
Kural: belirsiz ya da supheli fiyat REDDEDILIR; yanlis fiyat gostermek fiyat
gostermemekten kotudur.
"""

from __future__ import annotations

import pytest

from collect.link.extract import ExtractedProduct, _PageParser, from_heuristics
from collect.link.price import MAX_PRICE_KURUS, parse_structured_price
from collect.link.resolver import to_offer
from collect.link.urls import normalize as normalize_url
from collect.mapping import ValueFormats
from collect.pipeline import _check_currency
from collect.records import NormalizedOffer, RecordRejected

TURKISH = ValueFormats()


# --- makine/yapilandirilmis fiyat ------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("1899.90", 189990),
        ("1899", 189900),
        ("12.3456", 1235),
        ("1.299,00", 129900),
        ("1299,90", 129990),
        ("1,299.00", 129900),
        ("1.299.000,50", 129900050),
        ("1,299,000.50", 129900050),
        ("1.299.000", 129900000),
        ("TRY 1.299,90", 129990),
        ("₺1.299,90", 129990),
        ("1299,5", 129950),
        ("0,99", 99),
    ],
)
def test_unambiguous_prices_are_parsed_exactly(text: str, expected: int) -> None:
    assert parse_structured_price(text) == expected


@pytest.mark.parametrize(
    "text",
    [
        "1,299",  # binlik mi ondalik mi: belirsiz
        "1.299",
        "12.345",
        "0",
        "0.00",
        "-5",
        "abc",
        "",
        "1e5",
        "1.2.3,4,5",
        "1,299.5.0",
        "99999999999",
        "1,23,45",
    ],
)
def test_ambiguous_or_suspicious_prices_are_rejected(text: str) -> None:
    with pytest.raises(RecordRejected):
        parse_structured_price(text)


def test_price_above_the_sanity_cap_is_rejected() -> None:
    with pytest.raises(RecordRejected):
        parse_structured_price(str(MAX_PRICE_KURUS // 100 + 1))


# --- varsayilan Turkce bicim: sessiz yanlis okuma yok ----------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [("1.299,90", 129990), ("1299,90", 129990), ("12,5", 1250), ("1.299", 129900), ("85", 8500)],
)
def test_turkish_default_still_parses_valid_values(text: str, expected: int) -> None:
    assert TURKISH.parse_price(text) == expected


@pytest.mark.parametrize("text", ["12.5", "1299.90", "1,299.90", "1.29.9", "1.2999,00"])
def test_turkish_default_rejects_misformatted_values(text: str) -> None:
    with pytest.raises(RecordRejected):
        TURKISH.parse_price(text)


def test_declared_english_format_still_works() -> None:
    english = ValueFormats(decimal_separator=".", thousands_separator=",")
    assert english.parse_price("1,299.90") == 129990
    assert english.parse_price("1299.90") == 129990


# --- link teklifi: para birimi uydurulmaz ----------------------------------


def _offer(**fields: object):
    product = ExtractedProduct(
        title="Deneme Urun", price_text="1299.90", currency="TRY", source_layer="json_ld"
    )
    for key, value in fields.items():
        setattr(product, key, value)
    return to_offer(product, normalize_url("https://magaza.example/urun/deneme-1"))


def test_to_offer_parses_a_turkish_formatted_json_ld_price() -> None:
    assert _offer(price_text="1.299,00").current_price == 129900
    assert _offer(price_text="1299,90").current_price == 129990


def test_to_offer_rejects_a_missing_currency_on_structured_layers() -> None:
    with pytest.raises(RecordRejected):
        _offer(currency=None)


@pytest.mark.parametrize("currency", ["USD", "EUR", "GBP", "usd"])
def test_to_offer_rejects_non_try_currencies(currency: str) -> None:
    with pytest.raises(RecordRejected):
        _offer(currency=currency)


def test_to_offer_accepts_lowercase_try() -> None:
    assert _offer(currency="try").currency == "TRY"


def test_to_offer_rejects_a_zero_price() -> None:
    with pytest.raises(RecordRejected):
        _offer(price_text="0")


def test_heuristic_layer_keeps_try_because_the_page_text_carried_a_tl_marker() -> None:
    offer = _offer(price_text="1.249,50", currency="TRY", source_layer="heuristic")
    assert offer.current_price == 124950
    assert offer.currency == "TRY"


def test_list_price_that_cannot_be_read_is_dropped_not_fatal() -> None:
    offer = _offer(price_text="1299.90", list_price_text="1,299")
    assert offer.list_price is None
    assert offer.current_price == 129990


# --- besleme: TRY disi para birimi hicbir kaynak turunde yazilmaz ---------


def _feed_offer(currency: str) -> NormalizedOffer:
    return NormalizedOffer(
        external_id="x-1",
        url="https://magaza.example/x-1",
        title_raw="Deneme",
        current_price=1000,
        list_price=None,
        in_stock=True,
        currency=currency,
    )


@pytest.mark.parametrize("source_type", ["xml_feed", "csv_feed", "api", "shopify"])
def test_non_try_offers_are_rejected_for_every_source_type(source_type: str) -> None:
    with pytest.raises(RecordRejected):
        _check_currency(source_type, _feed_offer("EUR"))


def test_try_offers_pass() -> None:
    _check_currency("xml_feed", _feed_offer("TRY"))


# --- sezgisel katman: kargo/taksit esigi fiyat degildir --------------------


def _heuristic(*chunks: str) -> ExtractedProduct | None:
    parser = _PageParser()
    parser.title = "Deneme Urun"
    parser.text_chunks = list(chunks)
    return from_heuristics(parser)


def test_free_shipping_threshold_is_not_taken_as_the_price() -> None:
    product = _heuristic("500 TL ve uzeri alisverislerde kargo bedava", "1.249,50 TL")
    assert product is not None
    assert product.price_text == "1.249,50"


def test_installment_text_is_not_taken_as_the_price() -> None:
    product = _heuristic("3 x 416,50 TL taksit", "1.249,50 TL")
    assert product is not None
    assert product.price_text == "1.249,50"


def test_a_page_with_only_a_threshold_text_yields_no_price() -> None:
    assert _heuristic("500 TL üzeri kargo bedava") is None
