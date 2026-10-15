"""Kaynak ilani -> urun uygunluk kurallari (karar 0121). Veritabani yok."""

from __future__ import annotations

import pytest

from catalog_build.policy import POLICIES, SourceOffer, clean_title, evaluate, source_slug

ALI = POLICIES["aliexpress"]
ITEM = "1005006123456789"


def offer(**overrides) -> SourceOffer:
    base = {
        "offer_id": 1,
        "external_id": ITEM,
        "url": f"https://www.aliexpress.com/item/{ITEM}.html",
        "title_raw": "Wireless Bluetooth Earbuds Noise Cancelling Headphones 5.3",
        "image_url": "https://ae01.alicdn.com/kf/Sabc123.jpg",
        "current_price": 1299,
        "currency": "USD",
        "is_active": True,
    }
    base.update(overrides)
    return SourceOffer(**base)


def skip_of(**overrides) -> str | None:
    return evaluate(offer(**overrides), ALI).skip


def test_valid_offer_becomes_draft_without_invented_fields():
    verdict = evaluate(offer(), ALI)
    assert verdict.skip is None
    draft = verdict.draft
    assert draft is not None
    assert draft.external_id == ITEM
    assert draft.slug.endswith(f"-{ITEM}")
    assert draft.title == "Wireless Bluetooth Earbuds Noise Cancelling Headphones 5.3"
    # Taslak yalnizca bunlari tasir: marka, renk, GTIN, kategori uretilmez.
    assert set(draft.__dataclass_fields__) == {
        "offer_id",
        "external_id",
        "slug",
        "title",
        "image_url",
    }


def test_unknown_source_has_no_policy_and_builds_nothing():
    assert evaluate(offer(), None).skip == "source_policy_missing"


@pytest.mark.parametrize(
    ("overrides", "reason"),
    [
        ({"is_active": False}, "inactive"),
        ({"external_id": "abc"}, "source_id_invalid"),
        ({"external_id": "12345"}, "source_id_invalid"),
        # Teklif kimligi ile adresteki urun kimligi ayni kavram degil:
        (
            {"url": "https://www.aliexpress.com/item/1005006999999999.html"},
            "source_id_url_mismatch",
        ),
        ({"url": "https://example.com/item/1005006123456789.html"}, "source_id_url_mismatch"),
        (
            {"url": "https://www.aliexpress.com/item/1005006123456789.html?x=1"},
            "source_id_url_mismatch",
        ),
        ({"title_raw": "Kulak"}, "title_too_short"),
        ({"title_raw": "x" * 301}, "title_too_long"),
        ({"title_raw": "null"}, "title_placeholder"),
        ({"title_raw": "12345678 99999 000 1111"}, "title_not_text"),
        ({"title_raw": "https://spam.example/buy now cheap"}, "title_has_url"),
        ({"title_raw": "deal deal deal deal deal deal deal deal"}, "title_repetitive"),
        ({"image_url": None}, "no_image"),
        ({"image_url": "   "}, "no_image"),
        ({"image_url": "http://ae01.alicdn.com/kf/a.jpg"}, "bad_image"),
        ({"image_url": "https://localhost/a.jpg"}, "bad_image"),
        ({"image_url": "https://10.0.0.1/a.jpg"}, "bad_image"),
        ({"image_url": "https://ae01.alicdn.com/a b.jpg"}, "bad_image"),
        ({"current_price": None}, "no_price"),
        ({"current_price": 0}, "no_price"),
    ],
)
def test_ineligible_offers_are_kept_out_with_a_reason(overrides, reason):
    assert skip_of(**overrides) == reason


def test_title_cleaning_only_normalises_whitespace():
    assert clean_title("  Kahve \t Makinesi\n Pro  ") == "Kahve Makinesi Pro"
    # Icerik yeniden yazilmaz: buyuk/kucuk harf ve sayilar oldugu gibi kalir.
    assert clean_title("USB-C 65W GaN Charger") == "USB-C 65W GaN Charger"


def test_slug_is_ascii_stable_and_unique_by_source_id():
    a = source_slug("Çay Bardağı Seti İnce Belli 6'lı", "1005006123456789")
    assert a == "cay-bardagi-seti-ince-belli-6-li-1005006123456789"
    # Ayni baslik, farkli ilan: kimlik son ekte, cakisma yok.
    assert source_slug("Same Title", "100500000000001") != source_slug(
        "Same Title", "100500000000002"
    )
    # Latin disi baslik bile gecerli ASCII slug uretir.
    assert source_slug("无线耳机 蓝牙", "1005006123456789") == "urun-1005006123456789"
    assert len(source_slug("a " * 300, ITEM)) <= 80 + 1 + len(ITEM)


def test_similar_titles_never_merge_different_variants_or_colors():
    """Ilan = urun: renk/kapasite farki olan iki ilan ayri taslak urundur."""
    red = evaluate(
        offer(
            offer_id=1,
            external_id="1005006000000001",
            url="https://www.aliexpress.com/item/1005006000000001.html",
            title_raw="Phone Case Red 128GB Compatible",
        ),
        ALI,
    ).draft
    blue = evaluate(
        offer(
            offer_id=2,
            external_id="1005006000000002",
            url="https://www.aliexpress.com/item/1005006000000002.html",
            title_raw="Phone Case Blue 256GB Compatible",
        ),
        ALI,
    ).draft
    assert red is not None and blue is not None
    assert red.slug != blue.slug
    assert red.external_id != blue.external_id
