"""Shopify /products.json tasimasi. Hicbir test aga cikmaz."""

from __future__ import annotations

import httpx

from collect.mapping import FieldMapping
from collect.normalize import normalize
from collect.sources.shopify import ShopifyConnector

# Sayisal alanlar Shopify'in kendi bicimiyle: nokta ondalik, virgul yok
# (docs/decisions/0024 — Turkce varsayilanla parse edilirse fiyat 100 kat
# buyuk okunur).
_SHOPIFY_CONFIG = {
    "value_formats": {"decimal_separator": ".", "thousands_separator": ","},
    "mapping": {
        "external_id": "external_id",
        "url": "url",
        "title": "title",
        "brand": "vendor",
        "category": "product_type",
        "price": "price",
        "list_price": "compare_at_price",
        "image_url": "image_url",
        "variants": {
            "path": "variants",
            "size": "option2",
            "availability": "available",
            "external_id": "id",
            "price": "price",
            "sku": "sku",
        },
    },
}


def _client(products: list[dict]) -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        page = int(request.url.params.get("page", 1))
        return httpx.Response(200, json={"products": products if page == 1 else []})

    return httpx.Client(transport=httpx.MockTransport(handler))


def _single_variant_product() -> dict:
    """Eubos Turkiye orneginden — tek varyant, renk/beden yok."""
    return {
        "id": 1,
        "handle": "diyabetik-yuz-kremi",
        "title": "Diyabetik Yüz Kremi 50 ml",
        "vendor": "Eubos Türkiye",
        "product_type": "Cilt Bakım",
        "variants": [
            {
                "id": 101,
                "title": "Default Title",
                "option1": "Default Title",
                "option2": None,
                "sku": None,
                "available": True,
                "price": "2100.00",
                "compare_at_price": None,
            }
        ],
        "images": [{"src": "https://cdn.example/face-cream.png"}],
    }


def _multi_color_product() -> dict:
    """North Sails Turkiye orneginden — renk (option1) x beden (option2)."""

    def variant(id_: int, color: str, size: str, available: bool) -> dict:
        return {
            "id": id_,
            "title": f"{color} / {size}",
            "option1": color,
            "option2": size,
            "sku": "NS0000692462",
            "available": available,
            "price": "3486.00",
            "compare_at_price": "4980.00",
            "featured_image": {"src": f"https://cdn.example/{color}.jpg"},
        }

    return {
        "id": 2,
        "handle": "polo-yaka-tisort",
        "title": "Regular Fit Polo Yaka Tişört",
        "vendor": "North Sails Türkiye",
        "product_type": "Giyim",
        "variants": [
            variant(201, "Defne Yeşili", "S", False),
            variant(202, "Defne Yeşili", "M", True),
            variant(203, "Lacivert", "M", True),
        ],
        "images": [{"src": "https://cdn.example/default.jpg"}],
    }


def test_single_variant_product_yields_one_record() -> None:
    config = {"transport": {"pagination": {"size": 50}}}
    connector = ShopifyConnector(
        base_url="https://eubos-turkiye.myshopify.com/products.json",
        config=config,
        client=_client([_single_variant_product()]),
    )
    records = list(connector.fetch())
    assert len(records) == 1
    assert records[0].fields["price"] == "2100.00"
    assert records[0].fields["title"] == "Diyabetik Yüz Kremi 50 ml"
    assert (
        records[0].fields["url"]
        == "https://eubos-turkiye.myshopify.com/products/diyabetik-yuz-kremi"
    )
    assert records[0].fields["image_url"] == "https://cdn.example/face-cream.png"
    assert "color" not in records[0].fields


def test_single_variant_product_normalizes_without_size_variant() -> None:
    """option2 bos oldugu icin beden satiri uretilmemeli, ama offer gecerli olmali."""
    mapping = FieldMapping.from_config(_SHOPIFY_CONFIG)
    connector = ShopifyConnector(
        base_url="https://eubos-turkiye.myshopify.com/products.json",
        config={"transport": {"pagination": {"size": 50}}},
        client=_client([_single_variant_product()]),
    )
    record = next(iter(connector.fetch()))
    offer = normalize(record, mapping)
    assert offer.current_price == 210000  # "2100.00" -> kurus, nokta ondalik
    assert offer.variants == ()


def test_color_option_splits_product_into_multiple_records() -> None:
    config = {
        "transport": {"pagination": {"size": 50}, "shopify": {"color_option": "option1"}}
    }
    connector = ShopifyConnector(
        base_url="https://north-sails-turkey.myshopify.com/products.json",
        config=config,
        client=_client([_multi_color_product()]),
    )
    records = list(connector.fetch())
    assert len(records) == 2

    green = next(r for r in records if r.fields["color"] == "Defne Yeşili")
    assert green.fields["external_id"] == "2-defne-yesili"
    assert "?variant=" in green.fields["url"]
    assert len(green.groups["variants"]) == 2

    navy = next(r for r in records if r.fields["color"] == "Lacivert")
    assert len(navy.groups["variants"]) == 1


def test_color_option_absent_keeps_single_record() -> None:
    """color_option ayarlanmamissa mevcut connector'larla ayni davranis: tek kayit."""
    config = {"transport": {"pagination": {"size": 50}}}
    connector = ShopifyConnector(
        base_url="https://north-sails-turkey.myshopify.com/products.json",
        config=config,
        client=_client([_multi_color_product()]),
    )
    records = list(connector.fetch())
    assert len(records) == 1
    assert len(records[0].groups["variants"]) == 3
    assert "color" not in records[0].fields


def test_multi_color_normalizes_with_per_variant_price_and_sku() -> None:
    mapping = FieldMapping.from_config(_SHOPIFY_CONFIG)
    config = {
        "transport": {"pagination": {"size": 50}, "shopify": {"color_option": "option1"}}
    }
    connector = ShopifyConnector(
        base_url="https://north-sails-turkey.myshopify.com/products.json",
        config=config,
        client=_client([_multi_color_product()]),
    )
    records = list(connector.fetch())
    green = next(r for r in records if r.fields["color"] == "Defne Yeşili")
    offer = normalize(green, mapping)

    assert offer.current_price == 348600  # "3486.00" -> kurus
    assert offer.list_price == 498000  # "4980.00" -> kurus
    assert len(offer.variants) == 2

    by_size = {v.size_label: v for v in offer.variants}
    assert by_size["S"].in_stock is False
    assert by_size["M"].in_stock is True
    assert by_size["M"].sku == "NS0000692462"
    assert by_size["M"].price_override == 348600
