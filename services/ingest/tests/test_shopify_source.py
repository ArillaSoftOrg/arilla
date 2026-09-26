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
    # /products.json para birimi tasimaz; merchant duzeyinde dogrulanmis (0029).
    "currency": "TRY",
    "currency_verified": True,
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
    config = {"transport": {"pagination": {"size": 50}, "shopify": {"color_option": "option1"}}}
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
    config = {"transport": {"pagination": {"size": 50}, "shopify": {"color_option": "option1"}}}
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


def _paged_client(total: int, calls: list[int]) -> httpx.Client:
    """`total` tek varyantli urunu Shopify gibi sayfalar; istenen sayfalari kaydeder."""

    def handler(request: httpx.Request) -> httpx.Response:
        page = int(request.url.params["page"])
        limit = int(request.url.params["limit"])
        calls.append(page)
        start = (page - 1) * limit
        products = []
        for index in range(start, min(start + limit, total)):
            product = _single_variant_product()
            product["id"] = index + 1
            product["handle"] = f"urun-{index + 1}"
            products.append(product)
        return httpx.Response(200, json={"products": products})

    return httpx.Client(transport=httpx.MockTransport(handler))


def test_max_products_caps_canonical_products_and_stops_paging() -> None:
    calls: list[int] = []
    config = {
        **_SHOPIFY_CONFIG,
        "transport": {"pagination": {"size": 10}, "shopify": {"max_products": 25}},
    }
    connector = ShopifyConnector(
        base_url="https://shop.example/products.json",
        config=config,
        client=_paged_client(100, calls),
    )

    records = list(connector.fetch())

    assert len(records) == 25
    # 3. sayfa tavani doldurur; 4. sayfa hic istenmez.
    assert calls == [1, 2, 3]


def test_max_products_counts_products_not_color_records() -> None:
    """Renk bolmesi tavani yemez: tavan kanonik Shopify urunu sayisidir."""
    config = {
        **_SHOPIFY_CONFIG,
        "transport": {"shopify": {"color_option": "option1", "max_products": 1}},
    }
    connector = ShopifyConnector(
        base_url="https://shop.example/products.json",
        config=config,
        client=_client([_multi_color_product(), _single_variant_product()]),
    )

    records = list(connector.fetch())

    assert len(records) > 1
    assert {record.fields["id"] for record in records} == {str(_multi_color_product()["id"])}


def _flaky_client(statuses: list[int], calls: list[int]) -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        status = statuses.pop(0) if statuses else 200
        if status != 200:
            return httpx.Response(status, headers={"Retry-After": "1"})
        return httpx.Response(200, json={"products": []})

    return httpx.Client(transport=httpx.MockTransport(handler))


def test_retries_transient_errors_with_bounded_backoff(monkeypatch) -> None:
    sleeps: list[float] = []
    monkeypatch.setattr("collect.sources.shopify.time.sleep", sleeps.append)
    calls: list[int] = []
    config = {
        **_SHOPIFY_CONFIG,
        "transport": {"retry": {"max_retries": 2, "backoff_seconds": 2, "max_backoff_seconds": 3}},
    }
    connector = ShopifyConnector(
        base_url="https://shop.example/products.json",
        config=config,
        client=_flaky_client([429, 503], calls),
    )

    assert list(connector.fetch()) == []
    assert len(calls) == 3
    # 2 * 2**0 = 2, 2 * 2**1 = 4 -> 3 ile sinirlanir.
    assert sleeps == [2, 3]


def test_does_not_retry_forbidden_or_without_retry_config(monkeypatch) -> None:
    monkeypatch.setattr("collect.sources.shopify.time.sleep", lambda _: None)
    for statuses, config in (
        ([403], {"retry": {"max_retries": 3}}),  # bot korumasi: israr yok
        ([503], {}),  # ayar yoksa tek deneme (0023)
    ):
        calls: list[int] = []
        connector = ShopifyConnector(
            base_url="https://shop.example/products.json",
            config={**_SHOPIFY_CONFIG, "transport": config},
            client=_flaky_client(list(statuses), calls),
        )
        try:
            list(connector.fetch())
        except httpx.HTTPStatusError:
            pass
        else:
            raise AssertionError("hata bekleniyordu")
        assert len(calls) == 1


def test_zero_price_record_is_rejected() -> None:
    import pytest

    from collect.records import RecordRejected

    product = _single_variant_product()
    product["variants"][0]["price"] = "0.00"
    connector = ShopifyConnector(
        base_url="https://shop.example/products.json",
        config=_SHOPIFY_CONFIG,
        client=_client([product]),
    )
    (record,) = list(connector.fetch())
    with pytest.raises(RecordRejected, match="gecersiz fiyat"):
        normalize(record, FieldMapping.from_config(_SHOPIFY_CONFIG))


_BY_NAME_CONFIG = {
    **_SHOPIFY_CONFIG,
    "mapping": {
        **_SHOPIFY_CONFIG["mapping"],
        "variants": {**_SHOPIFY_CONFIG["mapping"]["variants"], "size": "size"},
    },
    "transport": {
        "shopify": {
            "color_option_names": ["Renk", "Color", "Kumaş"],
            "size_option_names": ["Beden", "Size"],
        }
    },
}


def _product_with_options(options: list[str], variants: list[tuple]) -> dict:
    return {
        "id": 7,
        "handle": "urun",
        "title": "Urun",
        "vendor": "Marka",
        "product_type": "Tip",
        "options": [{"name": name} for name in options],
        "variants": [
            {
                "id": 700 + index,
                "option1": values[0],
                "option2": values[1] if len(values) > 1 else None,
                "available": True,
                "price": "100.00",
            }
            for index, values in enumerate(variants)
        ],
        "images": [{"src": "https://cdn.example/u.png"}],
    }


def _normalized(product: dict) -> list:
    connector = ShopifyConnector(
        base_url="https://shop.example/products.json",
        config=_BY_NAME_CONFIG,
        client=_client([product]),
    )
    mapping = FieldMapping.from_config(_BY_NAME_CONFIG)
    return [normalize(record, mapping) for record in connector.fetch()]


def test_size_in_option1_is_not_split_into_products() -> None:
    """Casadora Baby: tek secenek `Beden`, option1'de. Beden kardesleri ayri urun degil."""
    offers = _normalized(_product_with_options(["Beden"], [("0-3 Ay",), ("3-6 Ay",)]))

    assert len(offers) == 1
    assert [v.size_label for v in offers[0].variants] == ["0-3 Ay", "3-6 Ay"]


def test_color_found_by_name_even_when_second() -> None:
    """For Fun: (`Beden`, `Renk`) sirasi. Renge gore bolunur, beden varyant olur."""
    offers = _normalized(
        _product_with_options(["Beden", "Renk"], [("S", "Siyah"), ("M", "Siyah"), ("S", "Bej")])
    )

    assert sorted(o.attributes_raw["color"] for o in offers) == ["Bej", "Siyah"]
    black = next(o for o in offers if o.attributes_raw["color"] == "Siyah")
    assert [v.size_label for v in black.variants] == ["S", "M"]


def test_non_size_option_is_not_stored_as_size() -> None:
    """Normod: (`Kumaş`, `Ayak`). Ayak tipi beden degildir."""
    offers = _normalized(
        _product_with_options(["Kumaş", "Ayak"], [("Granit", "Ahşap"), ("Granit", "Metal")])
    )

    assert len(offers) == 1
    assert offers[0].variants == ()


def test_unverified_currency_is_rejected_not_assumed_try() -> None:
    """0029: kaynak para birimi tasimiyorsa ve merchant icin dogrulanmamissa
    kayit reddedilir; TRY varsayilmaz."""
    import pytest

    from collect.records import RecordRejected

    connector = ShopifyConnector(
        base_url="https://shop.example/products.json",
        config=_SHOPIFY_CONFIG,
        client=_client([_single_variant_product()]),
    )
    (record,) = list(connector.fetch())
    for config in (
        {**_SHOPIFY_CONFIG, "currency_verified": False},
        {key: value for key, value in _SHOPIFY_CONFIG.items() if key != "currency"},
    ):
        with pytest.raises(RecordRejected, match="para birimi bilinmiyor"):
            normalize(record, FieldMapping.from_config(config))

    assert normalize(record, FieldMapping.from_config(_SHOPIFY_CONFIG)).currency == "TRY"


# --- max_products tavani (0031) ----------------------------------------------


def _capped_client(
    total: int, requests: list[tuple[int, int]], *, ignore_limit_with: int | None = None
) -> httpx.Client:
    """`total` urunluk magaza. Istenen (sayfa, limit) ciftlerini kaydeder.
    `ignore_limit_with`: sunucu `limit`i yok sayip her sayfada bu kadar dondurur."""

    def handler(request: httpx.Request) -> httpx.Response:
        page = int(request.url.params["page"])
        limit = int(request.url.params["limit"])
        requests.append((page, limit))
        size = ignore_limit_with or limit
        start = (page - 1) * size
        products = []
        for index in range(start, min(start + size, total)):
            product = _single_variant_product()
            product["id"] = index + 1
            product["handle"] = f"urun-{index + 1}"
            products.append(product)
        return httpx.Response(200, json={"products": products})

    return httpx.Client(transport=httpx.MockTransport(handler))


def _capped(
    total: int, transport: dict, **client_kwargs: int
) -> tuple[list[str], list[tuple[int, int]]]:
    requests: list[tuple[int, int]] = []
    connector = ShopifyConnector(
        base_url="https://shop.example/products.json",
        config={**_SHOPIFY_CONFIG, "transport": transport},
        client=_capped_client(total, requests, **client_kwargs),
    )
    return [record.fields["id"] for record in connector.fetch()], requests


def test_default_cap_is_30_when_absent() -> None:
    ids, requests = _capped(100, {"pagination": {"size": 50}})

    assert ids == [str(i) for i in range(1, 31)]
    # Sayfa boyu tavana kisilir; 30 urun tek istekte gelir, 2. sayfa istenmez.
    assert requests == [(1, 30)]


def test_fewer_products_than_cap() -> None:
    ids, requests = _capped(7, {"pagination": {"size": 50}})

    assert len(ids) == 7
    assert requests == [(1, 30)]


def test_exactly_cap_does_not_request_another_page() -> None:
    ids, requests = _capped(20, {"pagination": {"size": 10}, "shopify": {"max_products": 20}})

    assert len(ids) == 20
    # 2. sayfa tavani tam doldurur; bos 3. sayfayi sormaya gerek yok.
    assert requests == [(1, 10), (2, 10)]


def test_cap_crossed_inside_a_page() -> None:
    ids, requests = _capped(100, {"pagination": {"size": 10}, "shopify": {"max_products": 15}})

    assert ids == [str(i) for i in range(1, 16)]
    assert requests == [(1, 10), (2, 10)]


def test_cap_crossed_between_pages_stops_paging() -> None:
    ids, requests = _capped(100, {"pagination": {"size": 10}, "shopify": {"max_products": 20}})

    assert len(ids) == 20
    assert [page for page, _ in requests] == [1, 2]


def test_cap_holds_even_when_server_ignores_limit() -> None:
    ids, requests = _capped(100, {"pagination": {"size": 50}}, ignore_limit_with=50)

    assert len(ids) == 30
    assert requests == [(1, 30)]


def test_configured_lower_cap() -> None:
    ids, requests = _capped(100, {"shopify": {"max_products": 3}})

    assert ids == ["1", "2", "3"]
    assert requests == [(1, 3)]


def test_invalid_cap_fails_before_any_request() -> None:
    import pytest

    for bad in ("30", 0, -5, 2.5, True, 3501):
        requests: list[tuple[int, int]] = []
        with pytest.raises(ValueError, match="max_products"):
            ShopifyConnector(
                base_url="https://shop.example/products.json",
                config={**_SHOPIFY_CONFIG, "transport": {"shopify": {"max_products": bad}}},
                client=_capped_client(100, requests),
            )
        assert requests == []
