"""Eslestirme geri cagirma ozellikleri ve kademeler (docs/decisions/0034).

Ciftler gercek catisma corpus'undan (tests/fixtures/matching/overlap_pairs.json).
"""

from __future__ import annotations

from resolve.normalize import ProductKey, commercial_title
from resolve.products import infer_brand
from resolve.score import ScoreResult, auto_eligible, combine, queue_threshold

KORENDY_ROLLER = (
    "Dr. Althea - Retinol Flat Iron Eye Roller (Elastikiyet Koruyucu Masaj Başlıklı "
    "Retinollü Göz Serumu) 25ml"
)
VIONINE_ROLLER = "Dr. Althea Retinol Eye Roller - Kırışıklık Karşıtı Göz Bakımı 25ml"


def test_commercial_title_drops_descriptions_but_keeps_identity() -> None:
    assert commercial_title(KORENDY_ROLLER, "Dr. Althea").split() == [
        "Retinol",
        "Flat",
        "Iron",
        "Eye",
        "Roller",
        "25ml",
    ]
    assert commercial_title(VIONINE_ROLLER, "Dr.Althea") == "Dr. Althea Retinol Eye Roller"
    # Kisa parantez ve koseli parantez kimliktir, silinmez.
    assert "(24EA)" in commercial_title("Cosrx Acne Pimple Master Patch (24EA) - Sivilce Bandı")
    assert "[Ravenfall]" in commercial_title("Wraith Ace Series [Ravenfall] Poron Mousepad")
    # Kelime ici tire ayirici degildir.
    assert commercial_title("COSRX Oil-Free Ultra-Moisturizing Lotion - Yağsız Losyon") == (
        "COSRX Oil-Free Ultra-Moisturizing Lotion"
    )


def test_description_noise_no_longer_hides_the_same_product() -> None:
    left = ProductKey.build(title=KORENDY_ROLLER, brand="Dr. Althea")
    right = ProductKey.build(title=VIONINE_ROLLER, brand="Dr.Althea")
    assert combine(left, right).score >= queue_threshold()


def test_volume_written_into_color_option_is_not_a_color() -> None:
    key = ProductKey.build(title="Dr. Althea Rapid Hypochlorous Acid Rescue Mist", color="100ml")
    assert key.color is None


def test_brand_is_inferred_only_from_known_brand_prefix() -> None:
    brands = {"cosrx": "COSRX", "dr.althea": "Dr. Althea", "anua": "Anua"}
    assert infer_brand("Cosrx - AHA 7 Whitehead Power Liquid", brands) == "COSRX"
    assert infer_brand("Dr. Althea 345 Relief Cream", brands) == "Dr. Althea"
    assert infer_brand("Heartleaf Toner Anua", brands) is None  # onek degil
    assert infer_brand("Ab Krem", {"ab": "AB"}) is None  # cok kisa


def test_different_valid_barcodes_are_a_veto() -> None:
    """Reju 2000 / 5000: basliklar neredeyse ayni, barkodlar farkli.
    Barkod degerleri ORNEKTIR (kural gecerlilige degil esitsizlige bakar)."""
    left = ProductKey.build(
        title="Dr. Althea PDRN Reju 2000 Cream 20g", brand="Dr. Althea", gtin="8809447257341"
    )
    right = ProductKey.build(
        title="Dr. Althea PDRN Reju 5000 Cream 20g", brand="Dr. Althea", gtin="8809447258805"
    )
    assert combine(left, right).vetoed


def test_auto_accept_needs_strong_identity() -> None:
    """Karar 0115: benzer ad ve ayni marka kimlik degildir; yalnizca GTIN/MPN."""
    same_brand = ProductKey.build(
        title="Numbuzin No.9 NAD Bio Lifting-sil Essence 50 ml", brand="Numbuzin"
    )
    other = ProductKey.build(
        title="Numbuzin No.9 NAD Bio Lifting-Sil Essence 50ml", brand="Numbuzin"
    )
    no_brand = ProductKey.build(title="Numbuzin No.9 NAD Bio Lifting-Sil Essence 50ml")

    strong = combine(same_brand, other)
    assert strong.score >= queue_threshold()
    # Esik ustu metin skoru + ayni marka -> REVIEW, otomatik degil.
    assert not auto_eligible(strong, same_brand, other)
    assert not auto_eligible(combine(same_brand, no_brand), same_brand, no_brand)
    # Kesin kimlik markasiz da yeter.
    exact = ScoreResult(score=1.0, method="gtin")
    assert auto_eligible(exact, no_brand, no_brand)


def test_restricted_gtin_and_brandless_mpn_are_not_identity() -> None:
    # 20-29 onekli magaza ici numara: iki farkli magazada ayni olabilir.
    left = ProductKey.build(title="Dana Kiyma 500 g", brand="Kasap", gtin="2000000000008")
    right = ProductKey.build(title="Tavuk But 500 g", brand="Kasap", gtin="2000000000008")
    assert combine(left, right).method != "gtin"

    # Ayni MPN, farkli ya da bilinmeyen marka: kimlik degil.
    a = ProductKey.build(title="Sarj Adaptoru 20W", brand="Anker", mpn="A2633")
    b = ProductKey.build(title="Sarj Adaptoru 20W", brand="Baseus", mpn="A2633")
    c = ProductKey.build(title="Sarj Adaptoru 20W", mpn="A2633")
    assert combine(a, b).method != "mpn"
    assert combine(a, c).method != "mpn"
    same = ProductKey.build(title="Anker Nano 20W", brand="Anker", mpn="A2633")
    assert combine(a, same).method == "mpn"


def test_high_image_similarity_alone_never_auto_accepts() -> None:
    left = ProductKey.build(title="Zade Serisi Vintage Desenli Tezgah Dokuma Halı")
    right = ProductKey.build(title="Zade Serisi Vintage Desenli Tezgah Dokuma Halı")
    vector = [1.0] + [0.0] * 767
    result = combine(left, right, left_vector=vector, right_vector=vector)
    # Metin + gorsel tam ortusse bile marka bilinmiyorsa otomatik degil.
    assert not auto_eligible(result, left, right)
