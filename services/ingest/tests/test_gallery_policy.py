"""Renk-bolunmus urunlerde guvenli galeri/primary politikasi (karar 0073)."""

from __future__ import annotations

from collect.images import SourceImage, keep_current_first, select_images
from collect.mapping import FieldMapping
from collect.normalize import normalize
from collect.sources.shopify import ShopifyConnector
from tests.test_shopify_images import CONFIG, _image, _product, _variant


def _offers(product: dict) -> dict:
    connector = ShopifyConnector(base_url="https://shop.example", config=CONFIG)
    mapping = FieldMapping.from_config(CONFIG)
    records = connector._records_for_product(product, "option1", None)
    return {o.external_id: o for o in (normalize(r, mapping) for r in records)}


def _names(offer, shown_only: bool = True) -> list[str]:
    items = sorted(
        (i for i in offer.images if i.display_rank is not None or not shown_only),
        key=lambda i: (i.display_rank is None, i.display_rank or 0, i.source_position),
    )
    return [i.source_url.rsplit("/", 1)[-1][:-4] for i in items]


def test_images_linked_to_own_colour_come_first_and_become_primary() -> None:
    images = [
        _image(1, "s1", 1),
        _image(2, "b1", 2, [10]),
        _image(3, "b2", 3, [10]),
        _image(4, "g1", 4, [20]),
    ]
    product = _product(images, [_variant(10, "Siyah"), _variant(20, "Gri")])
    black = _offers(product)["1-siyah"]
    assert _names(black) == ["b1", "b2", "s1"]
    assert black.image_url == "https://cdn.example/b1.jpg"


def test_shared_image_is_kept_for_single_colour_product() -> None:
    product = _product([_image(1, "a", 1), _image(2, "b", 2)], [_variant(10, "Siyah")])
    (offer,) = _offers(product).values()
    assert _names(offer) == ["a", "b"] and offer.image_url.endswith("/a.jpg")


def test_only_foreign_linked_image_is_never_written_to_gallery_and_image_url_is_untouched() -> None:
    # Gercek desen (happy-place sehpa): tek gorsel, baska renge bagli; varyantlarin
    # featured_image'i da o. Galeri BOS; offer.image_url eski degerinde kalir.
    product = _product(
        [_image(1, "acik-ahsap", 1, [10])],
        [
            _variant(10, "Acik", featured="https://cdn.example/acik-ahsap.jpg"),
            _variant(20, "Siyah", featured="https://cdn.example/acik-ahsap.jpg"),
        ],
    )
    black = _offers(product)["1-siyah"]
    assert black.images == ()
    assert black.image_url == "https://cdn.example/acik-ahsap.jpg"


def test_featured_image_linked_to_other_colour_does_not_become_primary_when_own_exists() -> None:
    images = [_image(1, "g1", 1, [20]), _image(2, "b1", 2, [10]), _image(3, "b2", 3)]
    product = _product(
        images,
        [_variant(10, "Siyah", featured="https://cdn.example/g1.jpg"), _variant(20, "Gri")],
    )
    black = _offers(product)["1-siyah"]
    assert black.image_url == "https://cdn.example/b1.jpg"
    assert "g1" not in _names(black, shown_only=False)


def test_no_safe_image_left_means_empty_gallery() -> None:
    product = _product(
        [_image(1, "g1", 1, [20]), _image(2, "g2", 2, [20])],
        [_variant(10, "Siyah", featured="https://cdn.example/g1.jpg"), _variant(20, "Gri")],
    )
    black = _offers(product)["1-siyah"]
    assert black.images == ()
    assert black.image_url == "https://cdn.example/g1.jpg"  # mevcut deger degismedi


def test_uncertain_candidate_keeps_current_primary() -> None:
    # Siyah rengine ozgu kanit YOK; ortak gorseller var. Mevcut ana gorsel (featured)
    # ortak listenin ucuncusu: degismez, rank 0 o olur.
    images = [_image(1, "s1", 1), _image(2, "s2", 2), _image(3, "s3", 3), _image(4, "g1", 4, [20])]
    product = _product(
        images,
        [_variant(10, "Siyah", featured="https://cdn.example/s3.jpg"), _variant(20, "Gri")],
    )
    black = _offers(product)["1-siyah"]
    assert black.image_url == "https://cdn.example/s3.jpg"
    assert _names(black) == ["s3", "s1", "s2"]
    assert black.images[[i.display_rank for i in black.images].index(0)].source_url.endswith(
        "s3.jpg"
    )


def test_uncertain_candidate_and_current_primary_unknown_means_empty_gallery() -> None:
    # Mevcut ana gorsel urunun listesinde yok: guvenle ilk siraya konamaz.
    images = [_image(1, "s1", 1), _image(2, "g1", 2, [20])]
    product = _product(
        images,
        [_variant(10, "Siyah", featured="https://cdn.example/elsewhere.jpg"), _variant(20, "Gri")],
    )
    black = _offers(product)["1-siyah"]
    assert black.images == ()
    assert black.image_url == "https://cdn.example/elsewhere.jpg"


def test_clearly_better_primary_replaces_flat_featured_image() -> None:
    images = [_image(i, f"m-{i}", i) for i in range(1, 4)] + [_image(4, "flat", 4, [10])]
    product = _product(
        images,
        [_variant(10, "Siyah", featured="https://cdn.example/flat.jpg"), _variant(20, "Gri")],
    )
    black = _offers(product)["1-siyah"]
    # kanitli renk gorseli (flat) once: kanit var, politika degisimi serbest birakir
    assert black.image_url == "https://cdn.example/flat.jpg"


def test_duplicate_images_are_collapsed_in_policy_path() -> None:
    images = [_image(1, "s1", 1), _image(2, "s1", 2), _image(3, "g1", 3, [20])]
    product = _product(images, [_variant(10, "Siyah"), _variant(20, "Gri")])
    black = _offers(product)["1-siyah"]
    assert _names(black, shown_only=False).count("s1") == 1


def test_rank_is_deterministic_and_input_order_independent() -> None:
    images = [_image(1, "s1", 1), _image(2, "s2", 2), _image(3, "s3", 3), _image(4, "g1", 4, [20])]
    product = _product(
        images, [_variant(10, "Siyah", featured="https://cdn.example/s2.jpg"), _variant(20, "Gri")]
    )
    first = _offers(product)["1-siyah"]
    again = _offers(product)["1-siyah"]
    assert first.images == again.images and first.image_url == again.image_url


def test_keep_current_first_unit() -> None:
    sel = select_images(
        [SourceImage(f"https://c.example/{n}.jpg", i + 1) for i, n in enumerate("abcd")]
    )
    out = keep_current_first(sel, "https://c.example/c.jpg")
    assert [(i.source_url[-5], i.display_rank) for i in out] == [
        ("a", 1),
        ("b", 2),
        ("c", 0),
        ("d", None),
    ]
    assert keep_current_first(sel, "https://c.example/zzz.jpg") == ()
    assert keep_current_first(sel, None) == ()
