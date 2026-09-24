"""Renk yalnizca bir tarafta biliniyorsa otomatik kabul yok (0029).

Gercek bootstrap vakasi: Stanley TR renk bolmesi ("Spring Green") ile
Termos Dunyasi'nin basligindaki renk ("... Ash") sozlukte yok; veto
calismiyordu ve farkli renkler 0.91 skorla otomatik birlesti.
"""

from __future__ import annotations

from resolve.normalize import ProductKey
from resolve.score import auto_accept_threshold, combine, queue_threshold

STANLEY = "The Transit Fliptop Mug 0.59L"


def test_other_color_in_title_is_not_auto_accepted() -> None:
    offer = ProductKey.build(title=STANLEY, brand="Stanley", color="Spring Green")
    other_color = ProductKey.build(title=f"Stanley {STANLEY} Ash", brand="Stanley")

    result = combine(offer, other_color)

    assert not result.vetoed  # veto degil: kanit yok, fark da kanitlanmadi
    assert result.review is not None
    # Skor yuksek kalabilir; karar pipeline'da `review` ile kuyruga duser.
    assert result.score >= 0.63


def test_same_color_in_title_is_verified() -> None:
    offer = ProductKey.build(title=STANLEY, brand="Stanley", color="Spring Green")
    same = ProductKey.build(title=f"Stanley {STANLEY} Spring Green", brand="Stanley")

    result = combine(offer, same)

    assert result.review is None and not result.vetoed
    # "Spring Green" acik alani baslikta "Spring Green" = ayni renk; eskiden
    # 'spring-green' != 'yesil' diye vetolaniyordu.
    assert result.score >= queue_threshold()


def test_no_color_on_either_side_is_unaffected() -> None:
    left = ProductKey.build(
        title="Numbuzin No.9 NAD Bio Lifting-sil Essence 50 ml", brand="Numbuzin"
    )
    right = ProductKey.build(
        title="Numbuzin No.9 NAD Bio Lifting-Sil Essence 50ml", brand="Numbuzin"
    )
    assert combine(left, right).review is None


def test_different_shades_of_same_hue_stay_vetoed() -> None:
    offer = ProductKey.build(title=STANLEY, brand="Stanley", color="Hammertone Green")
    other = ProductKey.build(title=f"Stanley {STANLEY} Spring Green", brand="Stanley")
    assert combine(offer, other).vetoed


def test_near_identical_images_alone_do_not_make_an_exact_match() -> None:
    """Halicizade: farkli el dokuma halilar gorselde 0.93-0.99 benzer (0027
    olcumu). Gorsel benzerlik tek basina 'ayni urun' degildir. Renkler
    cikarildi ki renk vetosu degil gorsel agirligi olculsun. Ayni baslikli
    tekil halilar ise ayni merchant dislamasiyla korunur
    (test_resolve_same_merchant.py)."""
    rug_a = ProductKey.build(
        title="Zade Serisi Vintage Desenli Tezgah Dokuma Halı", brand="Halıcızade"
    )
    rug_b = ProductKey.build(title="El Dokuma Afgan Desenli Yün Bilicik Halı", brand="Halıcızade")
    vector = [1.0] + [0.0] * 767
    near = [0.99] + [0.14] + [0.0] * 766  # kosinus ~0.99

    result = combine(rug_a, rug_b, left_vector=vector, right_vector=near)

    assert result.method == "hybrid"
    assert result.score < auto_accept_threshold()
