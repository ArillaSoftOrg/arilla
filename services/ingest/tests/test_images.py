"""Gorsel ayiklama ve gosterim secimi (karar 0073). Saf fonksiyon testleri."""

from __future__ import annotations

from collect.images import (
    MAX_DISPLAY_IMAGES,
    MAX_SOURCE_IMAGES,
    SourceImage,
    clean_url,
    normalize_key,
    select_images,
    url_hash,
)


def _imgs(count: int, **kwargs) -> list[SourceImage]:
    return [
        SourceImage(f"https://cdn.example/p/{i}.jpg", position=i + 1, **kwargs)
        for i in range(count)
    ]


def _shown(selected):
    return sorted((s for s in selected if s.display_rank is not None), key=lambda s: s.display_rank)


def _name(image) -> str:
    return image.source_url.rsplit("/", 1)[-1]


def test_limits_are_central_constants() -> None:
    assert MAX_SOURCE_IMAGES == 6
    assert MAX_DISPLAY_IMAGES == 3


def test_zero_images() -> None:
    assert select_images([]) == []
    junk = [SourceImage(""), SourceImage("   "), SourceImage("data:image/png;base64,AAAA")]
    assert select_images(junk) == []


def test_one_two_three_images_are_all_shown() -> None:
    for count in (1, 2, 3):
        selected = select_images(_imgs(count))
        assert len(selected) == count
        assert [s.display_rank for s in selected] == list(range(count))
        assert [s.source_position for s in selected] == list(range(count))


def test_six_images_keeps_all_but_shows_three() -> None:
    selected = select_images(_imgs(6))
    assert len(selected) == 6
    assert [s.display_rank for s in selected] == [0, 1, 2, None, None, None]


def test_ten_images_source_max_six_display_max_three() -> None:
    selected = select_images(_imgs(10))
    assert len(selected) == MAX_SOURCE_IMAGES
    assert len(_shown(selected)) == MAX_DISPLAY_IMAGES
    assert [s.source_position for s in selected] == list(range(6))


def test_limits_are_configurable_in_one_place() -> None:
    selected = select_images(_imgs(10), max_source=4, max_display=2)
    assert len(selected) == 4
    assert len(_shown(selected)) == 2


def test_duplicate_url_is_dropped() -> None:
    images = [
        SourceImage("https://cdn.example/a.jpg", 1),
        SourceImage("https://cdn.example/a.jpg", 2),
        SourceImage("https://cdn.example/b.jpg", 3),
    ]
    assert [_name(s) for s in select_images(images)] == ["a.jpg", "b.jpg"]


def test_same_image_with_different_version_query_is_one_image() -> None:
    images = [
        SourceImage("https://cdn.shopify.com/s/files/1/a.jpg?v=111", 1),
        SourceImage("https://cdn.shopify.com/s/files/1/a.jpg?v=222", 2),
        SourceImage("//cdn.shopify.com/s/files/1/a.jpg", 3),
    ]
    selected = select_images(images)
    assert len(selected) == 1
    assert selected[0].source_url.endswith("?v=111")  # ilk gorulen, kaynagin verdigi hali


def test_shopify_resize_suffix_and_params_are_same_image() -> None:
    sized = "https://cdn.shopify.com/s/files/1/a_800x.jpg?width=500&v=3"
    assert normalize_key(sized) == normalize_key("https://cdn.shopify.com/s/files/1/a.jpg")


def test_non_shopify_query_params_are_not_stripped() -> None:
    # Bilinmeyen sitede ?id= baska gorsel secebilir: guvenli normalizasyon dokunmaz.
    assert normalize_key("https://x.example/img?id=1") != normalize_key(
        "https://x.example/img?id=2"
    )
    assert normalize_key("https://x.example/img?v=1&id=2") == normalize_key(
        "https://x.example/img?id=2&v=9"
    )


def test_url_hash_is_16_bytes_and_stable() -> None:
    first = url_hash("https://cdn.example/a.jpg?v=1")
    assert len(first) == 16
    assert first == url_hash("HTTPS://CDN.example/a.jpg?v=2#frag")


def test_clean_url_rejects_invalid() -> None:
    assert clean_url(None) is None
    assert clean_url("ftp://x/y.jpg") is None
    assert clean_url("https://x/a b.jpg") is None
    assert clean_url("https://" + "a" * 3000) is None
    assert clean_url("//cdn.example/a.jpg") == "https://cdn.example/a.jpg"


def test_primary_image_is_rank_zero_even_if_not_first() -> None:
    images = _imgs(4)
    images[2] = SourceImage(images[2].url, images[2].position, primary=True)
    selected = select_images(images)
    primary = next(s for s in selected if s.display_rank == 0)
    assert primary.source_url == images[2].url


def test_primary_survives_source_cap() -> None:
    images = _imgs(10)
    images[8] = SourceImage(images[8].url, images[8].position, primary=True)
    selected = select_images(images)
    assert len(selected) == 6
    assert next(s for s in selected if s.display_rank == 0).source_url == images[8].url


def test_without_primary_first_image_is_rank_zero() -> None:
    assert select_images(_imgs(3))[0].display_rank == 0


def test_source_order_change_updates_positions_deterministically() -> None:
    a, b, c = (f"https://cdn.example/{n}.jpg" for n in "abc")
    original = select_images([SourceImage(a, 1), SourceImage(b, 2), SourceImage(c, 3)])
    reordered = select_images([SourceImage(c, 1), SourceImage(a, 2), SourceImage(b, 3)])
    assert [_name(s) for s in original] == ["a.jpg", "b.jpg", "c.jpg"]
    assert [_name(s) for s in reordered] == ["c.jpg", "a.jpg", "b.jpg"]
    again = select_images([SourceImage(a, 1), SourceImage(b, 2), SourceImage(c, 3)])
    assert again == original  # ayni girdi, ayni cikti


def test_strong_non_product_signals_are_dropped() -> None:
    images = [
        SourceImage("https://cdn.example/real.jpg", 1),
        SourceImage("https://cdn.example/size-chart.png", 2),
        SourceImage("https://cdn.example/beden_tablosu.jpg", 3),
        SourceImage("https://cdn.example/placeholder.png", 4),
        SourceImage("https://cdn.example/tiny.jpg", 5, width=40, height=40),
        SourceImage("https://cdn.example/other.jpg", 6),
    ]
    assert [_name(s) for s in select_images(images)] == ["real.jpg", "other.jpg"]


def test_ambiguous_names_are_kept() -> None:
    # "logo"/"icon" urun adinda gecebilir: guclu isaret degil, atilmaz.
    images = [
        SourceImage("https://cdn.example/icon-jacket-front.jpg", 1),
        SourceImage("https://cdn.example/logo-tee.jpg", 2),
    ]
    assert len(select_images(images)) == 2


def test_elimination_never_leaves_nothing() -> None:
    selected = select_images([SourceImage("https://cdn.example/placeholder.png", 1)])
    assert len(selected) == 1
    assert selected[0].display_rank == 0


def test_variant_specific_images_are_preferred_for_remaining_slots() -> None:
    images = [
        SourceImage("https://cdn.example/main.jpg", 1, primary=True),
        SourceImage("https://cdn.example/shared1.jpg", 2),
        SourceImage("https://cdn.example/shared2.jpg", 3),
        SourceImage("https://cdn.example/black-side.jpg", 4, variant_specific=True),
        SourceImage("https://cdn.example/black-back.jpg", 5, variant_specific=True),
    ]
    shown = _shown(select_images(images))
    assert [_name(s) for s in shown] == ["main.jpg", "black-side.jpg", "black-back.jpg"]
    assert shown[1].is_variant_specific and shown[2].is_variant_specific


def test_primary_image_is_never_dropped_by_heuristics() -> None:
    images = [
        SourceImage("https://cdn.example/placeholder.png", 1, primary=True),
        SourceImage("https://cdn.example/real.jpg", 2),
    ]
    selected = select_images(images)
    assert [_name(s) for s in selected] == ["placeholder.png", "real.jpg"]
    assert selected[0].display_rank == 0
