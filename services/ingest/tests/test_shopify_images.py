"""Shopify galeri gorselleri: variant -> image iliskisi yalniz kanitliysa (karar 0073)."""

from __future__ import annotations

from collect.images import images_from_entries
from collect.mapping import FieldMapping
from collect.normalize import normalize
from collect.sources.shopify import ShopifyConnector

CONFIG = {
    "transport": {"shopify": {"color_option": "option1"}, "pagination": {"size": 50}},
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
    "currency": "TRY",
    "currency_verified": True,
    "value_formats": {"decimal_separator": ".", "thousands_separator": ","},
}


def _variant(id_: int, color: str, *, featured: str | None = None) -> dict:
    variant = {
        "id": id_,
        "option1": color,
        "option2": "M",
        "price": "100.00",
        "sku": f"s{id_}",
        "available": True,
        "compare_at_price": None,
    }
    if featured:
        variant["featured_image"] = {"src": featured}
    return variant


def _image(id_: int, name: str, position: int, variants: list[int] | None = None) -> dict:
    return {
        "id": id_,
        "src": f"https://cdn.example/{name}.jpg",
        "position": position,
        "width": 800,
        "height": 800,
        "variant_ids": variants or [],
    }


def _product(images: list[dict], variants: list[dict]) -> dict:
    return {
        "id": 1,
        "handle": "p",
        "title": "Urun",
        "vendor": "M",
        "product_type": "x",
        "variants": variants,
        "images": images,
    }


def _offers(product: dict) -> list:
    connector = ShopifyConnector(base_url="https://shop.example", config=CONFIG)
    mapping = FieldMapping.from_config(CONFIG)
    records = list(connector._records_for_product(product, "option1", None))
    return [normalize(record, mapping) for record in records]


def _rows(offer) -> list[tuple[str, int | None, bool]]:
    return [
        (i.source_url.rsplit("/", 1)[-1][:-4], i.display_rank, i.is_variant_specific)
        for i in offer.images
    ]


def test_single_color_product_takes_all_images_as_shared() -> None:
    product = _product(
        [_image(1, "a", 1), _image(2, "b", 2), _image(3, "c", 3), _image(4, "d", 4)],
        [_variant(10, "Siyah")],
    )
    (offer,) = _offers(product)
    rows = _rows(offer)
    assert [r[0] for r in rows] == ["a", "b", "c", "d"]
    assert [r[1] for r in rows] == [0, 1, 2, None]
    assert not any(r[2] for r in rows)  # iliski iddiasi yok


def test_variant_images_kept_per_color_and_other_colors_excluded() -> None:
    product = _product(
        [
            _image(1, "shared", 1),
            _image(2, "black-front", 2, [10]),
            _image(3, "black-side", 3, [10]),
            _image(4, "beige-front", 4, [20]),
        ],
        [
            _variant(10, "Siyah", featured="https://cdn.example/black-front.jpg"),
            _variant(20, "Bej", featured="https://cdn.example/beige-front.jpg"),
        ],
    )
    black, beige = _offers(product)
    black_rows = _rows(black)
    assert {r[0] for r in black_rows} == {"shared", "black-front", "black-side"}
    assert "black-front" not in {r[0] for r in _rows(beige)}
    # kanitli renk gorselleri once, kaynak sirasiyla; ortak gorsel sonra
    black_shown = sorted((r for r in black_rows if r[1] is not None), key=lambda r: r[1])
    assert [r[0] for r in black_shown] == ["black-front", "black-side", "shared"]
    assert next(r for r in _rows(beige) if r[1] == 0)[0] == "beige-front"
    # kanitli iliski isaretli, ortak olan degil
    flags = {r[0]: r[2] for r in black_rows}
    assert flags["black-side"] is True
    assert flags["shared"] is False


def test_no_variant_link_means_nothing_is_invented() -> None:
    product = _product(
        [_image(1, "a", 1), _image(2, "b", 2)],
        [_variant(10, "Siyah"), _variant(20, "Bej")],
    )
    black, beige = _offers(product)
    for offer in (black, beige):
        rows = _rows(offer)
        assert {r[0] for r in rows} == {"a", "b"}
        assert not any(r[2] for r in rows)


def test_image_url_equals_gallery_rank_zero() -> None:
    product = _product([_image(1, "a", 1), _image(2, "b", 2)], [_variant(10, "Siyah")])
    (offer,) = _offers(product)
    assert offer.image_url == "https://cdn.example/a.jpg"
    assert offer.images[0].source_url == offer.image_url
    assert offer.images[0].display_rank == 0


def test_flat_variant_featured_image_is_not_forced_to_primary() -> None:
    # Gercek payload deseni: varyantin featured_image'i duz urun fotografi ve
    # images[] icinde SON sirada; magazanin ilk gorselleri model fotograflari.
    images = [_image(i, f"model-{i}", i) for i in range(1, 5)] + [_image(5, "flat", 5)]
    product = _product(images, [_variant(10, "Siyah", featured="https://cdn.example/flat.jpg")])
    (offer,) = _offers(product)
    shown = sorted((r for r in _rows(offer) if r[1] is not None), key=lambda r: r[1])
    assert [r[0] for r in shown] == ["model-1", "model-2", "model-3"]
    assert offer.image_url == "https://cdn.example/model-1.jpg"


def test_featured_image_outside_images_is_not_prepended() -> None:
    product = _product(
        [_image(1, "a", 1), _image(2, "b", 2)],
        [_variant(10, "Siyah", featured="https://cdn.example/other-flat.jpg")],
    )
    (offer,) = _offers(product)
    assert [r[0] for r in _rows(offer)] == ["a", "b"]
    assert offer.image_url == "https://cdn.example/a.jpg"


def test_featured_image_is_fallback_when_product_has_no_images() -> None:
    product = _product([], [_variant(10, "Siyah", featured="https://cdn.example/f.jpg")])
    (offer,) = _offers(product)
    assert offer.image_url == "https://cdn.example/f.jpg"
    assert [(i.source_url, i.display_rank) for i in offer.images] == [
        ("https://cdn.example/f.jpg", 0)
    ]


def test_product_without_images_yields_no_gallery() -> None:
    (offer,) = _offers(_product([], [_variant(10, "Siyah")]))
    assert offer.images == ()
    assert offer.image_url is None


def test_ten_source_images_cap_at_six_and_three() -> None:
    product = _product([_image(i, f"i{i}", i) for i in range(1, 11)], [_variant(10, "Siyah")])
    (offer,) = _offers(product)
    assert len(offer.images) == 6
    assert sum(1 for i in offer.images if i.display_rank is not None) == 3


def test_entries_ignore_bad_numbers() -> None:
    images = images_from_entries([{"src": "https://x/a.jpg", "width": "abc", "position": "x"}])
    assert images[0].width is None
    assert images[0].position == 0


def test_color_split_uses_filename_stem_to_drop_other_colours_and_keep_own() -> None:
    """Gercek desen (North Sails 3393): her rengin yalniz bir gorseli varyanta bagli,
    gerisi bagsiz ama ayni dosya kokunu tasir. Baska rengin fotograflari alinmaz."""

    def img(id_: int, name: str, position: int, variants: list[int] | None = None) -> dict:
        return {**_image(id_, name, position, variants)}

    images = [
        img(1, "603349_0802_1", 1),
        img(2, "603349_0802_2", 2),
        img(3, "603349_0802_3", 3, [10]),
        img(4, "603349_0421_1", 4),
        img(5, "603349_0421_2", 5),
        img(6, "603349_0421_3", 6, [20]),
        img(7, "603349_0421_4", 7),
        img(8, "detay", 8),
    ]
    product = _product(images, [_variant(10, "Gri"), _variant(20, "Yesil")])
    grey, green = _offers(product)
    green_shown = sorted((r for r in _rows(green) if r[1] is not None), key=lambda r: r[1])
    assert [r[0] for r in green_shown] == ["603349_0421_1", "603349_0421_2", "603349_0421_3"]
    stored = {r[0] for r in _rows(green)}
    assert stored == {"603349_0421_1", "603349_0421_2", "603349_0421_3", "603349_0421_4", "detay"}
    assert not any("0802" in name for name in stored)
    assert green.image_url == "https://cdn.example/603349_0421_1.jpg"
    assert sorted(r[0] for r in _rows(grey) if r[1] is not None) == [
        "603349_0802_1",
        "603349_0802_2",
        "603349_0802_3",
    ]


def test_color_split_without_stem_evidence_keeps_unlinked_images_shared() -> None:
    product = _product(
        [_image(1, "a", 1), _image(2, "b", 2, [10]), _image(3, "c", 3, [20])],
        [_variant(10, "Siyah"), _variant(20, "Bej")],
    )
    black, _beige = _offers(product)
    assert {r[0] for r in _rows(black)} == {"a", "b"}
