"""Eslestirme veri butunlugu regresyonlari (AI denetimi A1, A2 ve ilgili).

Hepsi saf fonksiyon: veritabani gerektirmez. Her vaka denetimde somut bir
yanlis birlesmeyi (ya da gereksiz kacirilan gercek eslesmeyi) gosterdi.
"""

from __future__ import annotations

import pytest

from resolve.normalize import ProductKey, extract_color, extract_volume, title_tokens
from resolve.score import auto_eligible, combine, queue_threshold


def _key(title: str, brand: str | None = None, **extra: str) -> ProductKey:
    return ProductKey.build(title=title, brand=brand, **extra)


# --- A1: hacimdeki anlamli sifirlar -------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("100 ml", "100ml"),
        ("10 ml", "10ml"),
        ("1000 ml", "1000ml"),
        ("200ml", "200ml"),
        ("500 gr", "500gr"),
        ("50,0 ml", "50ml"),
        ("0,50 l", "0.5l"),
        ("1.50 lt", "1.5l"),
        ("250 g", "250gr"),
    ],
)
def test_volume_keeps_significant_zeros(raw: str, expected: str) -> None:
    assert extract_volume(f"Urun {raw}") == expected


@pytest.mark.parametrize(
    ("small", "large"),
    [("10 ml", "100 ml"), ("20 ml", "200 ml"), ("50 ml", "500 ml"), ("100 ml", "1000 ml")],
)
def test_volume_token_distinguishes_powers_of_ten(small: str, large: str) -> None:
    assert title_tokens(f"Krem {small}") != title_tokens(f"Krem {large}")


@pytest.mark.parametrize(
    ("small", "large"),
    [("10 ml", "100 ml"), ("20 ml", "200 ml"), ("50 ml", "500 ml"), ("100 ml", "1000 ml")],
)
def test_sizes_differing_by_a_zero_are_vetoed(small: str, large: str) -> None:
    left = _key(f"Anua Cleansing Oil {small}", "Anua")
    right = _key(f"Anua Cleansing Oil {large}", "Anua")
    result = combine(left, right)
    assert result.vetoed
    assert result.score == 0.0
    assert not auto_eligible(result, left, right)


def test_equivalent_volume_spellings_still_match() -> None:
    left = _key("Numbuzin No.9 NAD Essence 50 ml", "Numbuzin")
    right = _key("Numbuzin No.9 NAD Essence 50ml", "Numbuzin")
    other = _key("Numbuzin No.9 NAD Essence 50,0 ml", "Numbuzin")
    for pair in ((left, right), (left, other)):
        result = combine(*pair)
        assert not result.vetoed
        assert result.score >= queue_threshold()


# --- A2: tek haneli sayilar, model/kapasite/ekran/paket ------------------


def test_single_digit_tokens_are_kept() -> None:
    assert "7" in title_tokens("iPhone 7")
    assert title_tokens("iPhone 7") != title_tokens("iPhone 6")


@pytest.mark.parametrize(
    ("left_title", "right_title", "brand"),
    [
        ("iPhone 7 32 GB Siyah", "iPhone 6 32 GB Siyah", "Apple"),
        ("Galaxy S23 Ultra 256 GB Siyah", "Galaxy S22 Ultra 256 GB Siyah", "Samsung"),
        ("iPhone 15 Pro Max 256 GB Siyah", "iPhone 15 Pro Max 512 GB Siyah", "Apple"),
        ("Cep Telefonu 128 GB Siyah", "Cep Telefonu 1 TB Siyah", "Xiaomi"),
        ("Corap Seti 3'lu Siyah", "Corap Seti 6'li Siyah", "Penti"),
        ("Corap Seti 3 adet Siyah", "Corap Seti 6 adet Siyah", "Penti"),
        ("Akilli Televizyon 43 inc", "Akilli Televizyon 50 inc", "Vestel"),
        ("Akilli TV 55 inç Siyah", "Akilli TV 65 inç Siyah", "Samsung"),
    ],
)
def test_numeric_identity_conflicts_are_vetoed(
    left_title: str, right_title: str, brand: str
) -> None:
    left = _key(left_title, brand)
    right = _key(right_title, brand)
    result = combine(left, right)
    assert result.vetoed, f"{left_title} / {right_title}: {result.score:.3f}"
    assert result.score == 0.0
    assert not auto_eligible(result, left, right)


@pytest.mark.parametrize(
    ("left_title", "right_title", "brand"),
    [
        # Bir tarafta fazladan sayi eksikliktir, celiski degil.
        ("iPhone 15 Siyah", "iPhone 15 128 GB Siyah", "Apple"),
        ("Galaxy A54 5G 128 GB Siyah", "Galaxy A54 128GB Siyah", "Samsung"),
        # Ayni kimlik farkli yazim.
        ("Spor Ayakkabi AB-1234 Siyah", "Spor Ayakkabi AB1234 Siyah", "Nike"),
        ("Corap Seti 3'lu Siyah", "Corap Seti 3 lu Siyah", "Penti"),
        ("Akilli TV 55 inç Siyah", "Akilli TV 55 inc Siyah", "Samsung"),
    ],
)
def test_numeric_rule_does_not_over_veto(left_title: str, right_title: str, brand: str) -> None:
    result = combine(_key(left_title, brand), _key(right_title, brand))
    assert not result.vetoed, result.veto


# --- Kimlik alanlari: gecersiz/ortak cop degerler ------------------------


@pytest.mark.parametrize(
    "junk",
    ["0000000000000", "1111111111111", "123456789012", "12345678", "00000000", "abc", "", "  "],
)
def test_junk_gtin_is_discarded(junk: str) -> None:
    assert _key("Urun A Siyah", "Marka", gtin=junk).gtin is None


def test_valid_gtin_is_kept() -> None:
    # Gecerli bir EAN-13 (kontrol basamagi dogru):
    assert _key("Urun A Siyah", "Marka", gtin="4006381333931").gtin == "4006381333931"


def test_shared_junk_gtin_does_not_create_an_exact_match() -> None:
    left = _key("Deri Cuzdan Siyah", "Kuzey", gtin="0000000000000")
    right = _key("Deri Kemer Siyah", "Kuzey", gtin="0000000000000")
    result = combine(left, right)
    assert result.method != "gtin"
    assert result.score < 1.0


@pytest.mark.parametrize(
    "junk", ["-", "yok", "N/A", "null", "0", "000000", "aaaa", "STANDART", " "]
)
def test_junk_mpn_is_discarded(junk: str) -> None:
    assert _key("Urun A Siyah", "Marka", mpn=junk).mpn is None


def test_real_mpn_is_kept_and_matches() -> None:
    left = _key("Kulaklik Siyah", "Sony", mpn="WH-1000XM5")
    right = _key("Sony Kablosuz Kulaklik Siyah", "Sony", mpn="WH-1000XM5")
    assert left.mpn == "WH-1000XM5"
    assert combine(left, right).method == "mpn"


# --- Renk/marka yanlis pozitifleri ---------------------------------------


def test_coffee_noun_is_not_a_color() -> None:
    assert extract_color("Philips Kahve Makinesi Siyah") == "siyah"
    assert extract_color("Kahve Fincani Seti Beyaz") == "beyaz"


def test_real_brown_still_detected() -> None:
    assert extract_color("Deri Bot Kahve") == "kahverengi"
    assert extract_color("Deri Bot Kahverengi") == "kahverengi"


def test_brand_name_is_not_a_color() -> None:
    key = ProductKey.build(title="Mavi Jeans Siyah Pantolon", brand="Mavi")
    assert key.color == "siyah"
    only_brand = ProductKey.build(title="Mavi Jeans Pantolon", brand="Mavi")
    assert only_brand.color is None


def test_real_blue_still_detected_with_other_brand() -> None:
    assert ProductKey.build(title="Levis Mavi Pantolon", brand="Levis").color == "mavi"


def test_two_color_order_is_irrelevant() -> None:
    left = _key("Spor Ayakkabi Siyah/Beyaz", "Nike")
    right = _key("Spor Ayakkabi Beyaz/Siyah", "Nike")
    assert not combine(left, right).vetoed
    assert left.color == right.color


def test_single_color_difference_is_still_vetoed() -> None:
    left = _key("Spor Ayakkabi Siyah/Beyaz", "Nike")
    right = _key("Spor Ayakkabi Siyah/Kirmizi", "Nike")
    assert combine(left, right).vetoed
