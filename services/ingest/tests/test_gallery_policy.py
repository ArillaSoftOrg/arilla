"""`unknown != safe`: renk-bolunmus urunde yalniz kanitli gorseller galeriye girer (karar 0073)."""

from __future__ import annotations

from collect.mapping import FieldMapping
from collect.normalize import normalize
from collect.sources.shopify import ShopifyConnector
from tests.test_shopify_images import CONFIG, _image, _product, _variant


def _offers(product: dict) -> dict:
    connector = ShopifyConnector(base_url="https://shop.example", config=CONFIG)
    mapping = FieldMapping.from_config(CONFIG)
    records = connector._records_for_product(product, "option1", None)
    return {o.external_id: o for o in (normalize(r, mapping) for r in records)}


def _names(offer, *, shown_only: bool = False) -> list[str]:
    items = sorted(
        (i for i in offer.images if i.display_rank is not None or not shown_only),
        key=lambda i: (i.display_rank is None, i.display_rank or 0, i.source_position),
    )
    return [i.source_url.rsplit("/", 1)[-1][:-4] for i in items]


def test_colour_split_with_only_shared_unbound_images_gets_no_gallery() -> None:
    product = _product(
        [_image(1, "s1", 1), _image(2, "s2", 2), _image(3, "s3", 3)],
        [_variant(10, "Siyah"), _variant(20, "Gri")],
    )
    for offer in _offers(product).values():
        assert offer.images == ()


def test_colour_split_with_only_other_colour_images_gets_no_gallery() -> None:
    product = _product(
        [_image(1, "g1", 1, [20]), _image(2, "g2", 2, [20])],
        [_variant(10, "Siyah", featured="https://cdn.example/g1.jpg"), _variant(20, "Gri")],
    )
    black = _offers(product)["1-siyah"]
    assert black.images == ()
    # mevcut offer.image_url (kaynagin eski degeri) bu yuzden degismez
    assert black.image_url == "https://cdn.example/g1.jpg"


def test_colour_split_with_own_and_shared_images_keeps_only_the_evidenced_ones() -> None:
    images = [
        _image(1, "s1", 1),
        _image(2, "b1", 2, [10]),
        _image(3, "s2", 3),
        _image(4, "b2", 4, [10]),
        _image(5, "g1", 5, [20]),
    ]
    product = _product(images, [_variant(10, "Siyah"), _variant(20, "Gri")])
    black = _offers(product)["1-siyah"]
    assert _names(black) == ["b1", "b2"]
    assert all(i.is_variant_specific for i in black.images)
    assert black.image_url == "https://cdn.example/b1.jpg"


def test_colour_split_with_several_own_images_gets_a_safe_gallery() -> None:
    images = [_image(i, f"b{i}", i, [10]) for i in range(1, 6)] + [_image(9, "g1", 9, [20])]
    product = _product(images, [_variant(10, "Siyah"), _variant(20, "Gri")])
    black = _offers(product)["1-siyah"]
    assert _names(black, shown_only=True) == ["b1", "b2", "b3"]
    assert [i.display_rank for i in black.images if i.display_rank is not None] == [0, 1, 2]
    assert "g1" not in _names(black)


def test_single_colour_product_with_unbound_images_keeps_the_normal_gallery() -> None:
    product = _product(
        [_image(1, "a", 1), _image(2, "b", 2), _image(3, "c", 3)], [_variant(10, "Siyah")]
    )
    (offer,) = _offers(product).values()
    assert _names(offer, shown_only=True) == ["a", "b", "c"]
    assert offer.image_url == "https://cdn.example/a.jpg"


def test_existing_primary_is_kept_when_there_is_no_evidence() -> None:
    product = _product(
        [_image(1, "s1", 1), _image(2, "s2", 2)],
        [_variant(10, "Siyah", featured="https://cdn.example/s2.jpg"), _variant(20, "Gri")],
    )
    black = _offers(product)["1-siyah"]
    assert black.images == ()
    assert black.image_url == "https://cdn.example/s2.jpg"  # kaynagin mevcut degeri aynen


def test_colour_words_in_file_names_are_not_evidence() -> None:
    # Dosya adlari renk soyluyor ama hicbiri varyanta bagli degil ve bagli kardes yok.
    product = _product(
        [
            _image(1, "kanepe-siyah-on", 1),
            _image(2, "kanepe-gri-on", 2),
            _image(3, "kanepe-siyah-yan", 3),
        ],
        [_variant(10, "Siyah"), _variant(20, "Gri")],
    )
    for offer in _offers(product).values():
        assert offer.images == ()


def test_file_name_stem_counts_only_when_anchored_to_a_variant_linked_image() -> None:
    images = [
        _image(1, "p-0421-1", 1),
        _image(2, "p-0421-2", 2),
        _image(3, "p-0421-3", 3, [10]),
        _image(4, "p-0802-1", 4),
    ]
    product = _product(images, [_variant(10, "Yesil"), _variant(20, "Gri")])
    offers = _offers(product)
    assert _names(offers["1-yesil"]) == ["p-0421-1", "p-0421-2", "p-0421-3"]
    assert offers["1-gri"].images == ()  # "p-0802-1" bagsiz ve kendi rengine bagli kardesi yok


def test_duplicate_images_and_rank_are_deterministic() -> None:
    images = [
        _image(1, "b1", 1, [10]),
        _image(2, "b1", 2, [10]),
        _image(3, "b2", 3, [10]),
        _image(4, "g1", 4, [20]),
    ]
    product = _product(images, [_variant(10, "Siyah"), _variant(20, "Gri")])
    first = _offers(product)["1-siyah"]
    again = _offers(product)["1-siyah"]
    assert first.images == again.images and first.image_url == again.image_url
    assert _names(first).count("b1") == 1
    assert [i.display_rank for i in first.images] == [0, 1]
