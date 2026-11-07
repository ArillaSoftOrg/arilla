"""Shopify -> CanonicalListing adapter'i ve magaza kaynak tanimi. Hicbir test aga cikmaz."""

from __future__ import annotations

from datetime import UTC, datetime

import httpx
import pytest

from collect.records import RawRecord
from collect.sources.shopify import ShopifyConnector
from platforms import registry
from platforms.adapters.shopify import ShopifyListingAdapter, listing_fields, to_listing
from platforms.contract import CanonicalListing, Checkpoint, Rejection, SourceAdapter
from platforms.shopify_sources import (
    PILOT_MAX_PRODUCTS,
    pilot_feed_config,
    shopify_store_definition,
)

NOW = datetime(2026, 11, 7, 12, 0, tzinfo=UTC)
STORE = "https://shop.example/products.json"
VALID_EAN = "8690000000012"  # GS1 Turkiye oneki, gecerli kontrol basamagi


def _client(products: list[dict]) -> httpx.Client:
    def route(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/robots.txt":
            return httpx.Response(404)
        page = int(request.url.params.get("page", 1))
        return httpx.Response(200, json={"products": products if page == 1 else []})

    return httpx.Client(transport=httpx.MockTransport(route))


def _variant(id_: int, *, color: str | None = None, size: str | None = None, **over) -> dict:
    return {
        "id": id_,
        "title": "Default Title",
        "option1": color or "Default Title",
        "option2": size,
        "available": True,
        "price": "2100.00",
        "compare_at_price": None,
        "barcode": None,
        "sku": "SKU-1",
        **over,
    }


def _product(id_: int, variants: list[dict], **over) -> dict:
    return {
        "id": id_,
        "handle": f"urun-{id_}",
        "title": "Termos 500 ml",
        "vendor": "Stanley",
        "product_type": "Mutfak > Termos",
        "body_html": "<p>aciklama</p>",
        "variants": variants,
        "images": [{"src": f"https://cdn.example/{id_}.jpg"}],
        **over,
    }


def _listings(products: list[dict], color_option: str | None = None) -> list:
    connector = ShopifyConnector(
        base_url=STORE,
        config=pilot_feed_config(color_option=color_option),
        client=_client(products),
        sleep=lambda _s: None,
    )
    adapter = ShopifyListingAdapter("shop-example", connector.fetch, observed_at=NOW)
    return list(adapter.fetch())


def test_single_variant_maps_all_seen_fields() -> None:
    [item] = _listings([_product(1, [_variant(11, barcode=VALID_EAN, compare_at_price="2500.00")])])
    assert isinstance(item, CanonicalListing)
    assert item.listing_id == "1"
    assert item.url == "https://shop.example/products/urun-1"
    assert item.price == 210_000 and item.list_price == 250_000
    assert item.currency == "TRY"
    assert item.in_stock is True
    assert item.brand == "Stanley"
    assert item.category_path == ("Mutfak", "Termos")
    assert item.gtin == "0" + VALID_EAN
    assert item.mpn is None  # SKU magaza ici koddur
    assert item.image_urls == ("https://cdn.example/1.jpg",)
    assert item.options == {}


def test_color_split_keeps_external_id_rule_and_skips_ambiguous_gtin() -> None:
    variants = [
        _variant(21, color="Siyah", size="S", barcode=VALID_EAN, available=False),
        _variant(22, color="Siyah", size="M", barcode=VALID_EAN, available=True),
        _variant(23, color="Krem", size="M", barcode=VALID_EAN, available=False),
    ]
    items = _listings([_product(2, variants)], color_option="option1")
    by_id = {i.listing_id: i for i in items}
    assert set(by_id) == {"2-siyah", "2-krem"}
    assert by_id["2-siyah"].options == {"renk": "Siyah"}
    assert by_id["2-siyah"].in_stock is True  # en az bir beden satilabilir
    assert by_id["2-krem"].in_stock is False
    # Iki bedenli grupta barkod hangi varyanti temsil ediyor belli degil.
    assert by_id["2-siyah"].gtin is None
    # Tek bedenli renk grubunda gecerli barkod yazilir.
    assert by_id["2-krem"].gtin == "0" + VALID_EAN


def test_compare_at_not_above_price_is_not_list_price() -> None:
    [item] = _listings([_product(3, [_variant(31, compare_at_price="2100.00")])])
    assert item.list_price is None


def test_invalid_or_restricted_barcode_is_dropped() -> None:
    items = _listings(
        [
            _product(4, [_variant(41, barcode="123")]),
            _product(5, [_variant(51, barcode="2000000000008")]),  # magaza ici (kisitli)
        ]
    )
    assert [i.gtin for i in items] == [None, None]


def test_missing_vendor_and_type_stay_empty() -> None:
    [item] = _listings([_product(6, [_variant(61)], vendor="", product_type="")])
    assert item.brand is None
    assert item.category_path == ()


def test_unknown_availability_is_none_not_false() -> None:
    variant = _variant(71)
    del variant["available"]
    [item] = _listings([_product(7, [variant])])
    assert item.in_stock is None


def test_bad_records_become_rejections_not_exceptions() -> None:
    base = {"external_id": "8", "title": "X", "url": "https://shop.example/products/x"}
    cases = {
        "missing_price": RawRecord(fields=base, source_ref="a"),
        "price_not_numeric": RawRecord(fields={**base, "price": "abc"}, source_ref="b"),
        "bad_listing_id": RawRecord(
            fields={**base, "external_id": "x y", "price": "1"}, source_ref="c"
        ),
        "bad_url": RawRecord(
            fields={**base, "url": "http://shop.example/p", "price": "1"}, source_ref="d"
        ),
        "missing_required": RawRecord(fields={"external_id": "9"}, source_ref="e"),
    }
    for code, record in cases.items():
        result = to_listing(record, platform="shop-example", currency="TRY", observed_at=NOW)
        assert isinstance(result, Rejection) and result.code == code, code


def test_adapter_is_source_adapter_and_resumes_from_checkpoint() -> None:
    products = [_product(i, [_variant(i * 10)]) for i in range(1, 6)]
    connector = ShopifyConnector(
        base_url=STORE, config=pilot_feed_config(), client=_client(products), sleep=lambda _s: None
    )
    adapter = ShopifyListingAdapter("shop-example", connector.fetch, observed_at=NOW)
    assert isinstance(adapter, SourceAdapter)
    first = []
    for item in adapter.fetch():
        first.append(item.listing_id)
        if len(first) == 2:
            break
    saved = adapter.checkpoint
    assert saved == Checkpoint({"offset": 2}, 2)
    rest = [i.listing_id for i in adapter.fetch(saved)]
    assert first + rest == ["1", "2", "3", "4", "5"]
    # Ayni imlecle ikinci cagri ayni kayitlari verir (idempotent).
    assert [i.listing_id for i in adapter.fetch(saved)] == rest


def test_listing_fields_summary_has_no_content() -> None:
    [item] = _listings([_product(1, [_variant(11)])])
    summary = listing_fields(item)
    assert summary["brand"] is True and summary["gtin"] is False
    assert "title" not in summary


def test_store_definition_is_sample_and_reports_license_gap() -> None:
    before = registry.catalog_definitions()
    definition = shopify_store_definition(
        slug="termos-dunyasi", name="Termos Dunyasi", domain="termos-dunyasi.myshopify.com"
    )
    assert definition.status == "sample"
    assert definition.currency == "TRY"
    assert definition.constraints.rights.may_store_prices is False
    assert registry.onboarding_problems(definition) == ["data_license_unknown"]
    # Tanim uretmek kayit defterini degistirmez; uretim hattina giremez.
    assert registry.get("termos-dunyasi") is None
    assert registry.catalog_definitions() == before


def test_store_definition_rejects_url_as_domain() -> None:
    with pytest.raises(ValueError):
        shopify_store_definition(slug="x-store", name="X", domain="https://x.example/")


def test_pilot_config_caps_products() -> None:
    config = pilot_feed_config(color_option="option1")
    connector = ShopifyConnector(base_url=STORE, config=config, client=_client([]))
    assert connector.max_products == PILOT_MAX_PRODUCTS
    assert connector.page_size == 250
