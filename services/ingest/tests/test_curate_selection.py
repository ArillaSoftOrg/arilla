"""Trend eslestirme: metin katlama, terim eslestirme, puanlama ve cesitlilikli secim.

Regresyon seti (`REGRESSION`) gercek katalogdan alinmis basliklarla "bu urun bu
trende girer / girmez" kararlarini sabitler: bir terim ya da esik degisince
neyin bozuldugu burada gorunur (.claude/rules/ingest-python.md).
"""

from __future__ import annotations

import pytest

from curate.profiles import BY_SLUG
from curate.selection import (
    MAX_PER_BRAND,
    Candidate,
    Profile,
    Scored,
    score_candidate,
    select_diverse,
)
from curate.text import fold, jaccard, matches, signature, sql_pattern, term_regex


def cand(
    pid: int,
    title: str,
    *,
    brand: str | None = None,
    path: str | None = "moda",
    merchant: str = "m1",
    price: int = 10_000,
    offers: int = 1,
) -> Candidate:
    return Candidate(pid, title, brand, path, merchant, price, offers)


# --- metin --------------------------------------------------------------------


def test_fold_matches_sql_translate():
    assert fold("ÇOCUK ŞAPKASI ığüöİ") == "cocuk sapkasi iguoi"
    assert fold("Işıl Işıl") == "isil isil"
    assert fold("ÂÎÛ âîû") == "aiu aiu"


def test_sql_pattern_is_folded_and_escaped():
    assert sql_pattern("Güneş") == "%gunes%"
    assert sql_pattern("bot$") == "%bot%"
    assert sql_pattern("100%") == "%100\\%%"


def test_plain_term_is_word_prefix():
    assert matches("kazak", fold("Oversize Kazaklar"))
    assert matches("kazak", fold("Triko Kazak Vizon"))
    assert not matches("kazak", fold("Pazakazak"))  # kelime ortasi degil


def test_dollar_term_is_whole_word_with_turkish_suffix():
    assert matches("bot$", fold("Kadın Siyah Chelsea Bot"))
    assert matches("bot$", fold("Botlar"))
    assert not matches("bot$", fold("Water Bottle 0.5L"))
    assert not matches("bot$", fold("Robotik Süpürge"))
    assert not matches("deniz$", fold("Denizli Halı"))  # 'li' eki "Denizli"yi yutmasin diye
    assert matches("deniz sort", fold("Erkek Deniz Şortu"))


def test_multiword_term_tolerates_separators():
    assert matches("mouse pad", fold("Cam Mouse-Pad"))
    assert matches("mouse pad", fold("Büyük mouse   pad"))


def test_signature_drops_sizes_colors_and_noise():
    a = signature("Cosrx Hyaluronic Acid Intensive Cream 100ml")
    b = signature("Cosrx Hyaluronic Acid Intensive Cream 50 ml SKT İndirimi")
    assert a == b
    assert jaccard(a, b) == 1.0
    siyah = signature("Basic Tişört Siyah")
    beyaz = signature("Basic Tişört Beyaz")
    assert siyah == beyaz  # renk varyanti = ayni urun ailesi


# --- puanlama -------------------------------------------------------------------

PROFILE = Profile(
    "test",
    core=("kazak", "triko"),
    boost=("oversize", "yun"),
    exclude=("cocuk",),
    categories=("moda",),
    price_max=50_000,
)


def test_core_is_required():
    assert score_candidate(PROFILE, cand(1, "Oversize Yün Pantolon")) is None


def test_exclude_category_and_price_gates():
    assert score_candidate(PROFILE, cand(1, "Çocuk Kazak")) is None
    assert score_candidate(PROFILE, cand(1, "Kazak", path="ev-yasam/x")) is None
    assert score_candidate(PROFILE, cand(1, "Kazak", path=None)) is None
    assert score_candidate(PROFILE, cand(1, "Kazak", price=50_001)) is None
    assert score_candidate(PROFILE, cand(1, "Kazak", path="moda/ust-giyim")) is not None


def test_score_is_core_plus_boost_plus_small_multi_offer_bonus():
    plain = score_candidate(PROFILE, cand(1, "Kazak"))
    rich = score_candidate(PROFILE, cand(2, "Oversize Yün Triko Kazak"))
    multi = score_candidate(PROFILE, cand(3, "Kazak", offers=2))
    assert plain and rich and multi
    assert rich.score > multi.score > plain.score
    assert multi.score - plain.score < 1  # komisyon degil, kucuk karsilastirma bonusu


def test_min_boost_and_min_score():
    strict = Profile("t", core=("kazak",), boost=("yun", "oversize"), min_boost=1)
    assert score_candidate(strict, cand(1, "Kazak")) is None
    assert score_candidate(strict, cand(1, "Yün Kazak")) is not None
    high = Profile("t", core=("kazak",), min_score=4.0)
    assert score_candidate(high, cand(1, "Kazak")) is None


def test_profile_without_core_selects_nothing():
    assert score_candidate(Profile("t", note="sinyal yok"), cand(1, "Kazak")) is None


# --- secim ----------------------------------------------------------------------


def scored(profile: Profile, items: list[Candidate]) -> list[Scored]:
    return [s for c in items if (s := score_candidate(profile, c)) is not None]


def test_brand_cap_and_unknown_brand_not_capped():
    p = Profile("t", core=("kazak",))
    items = [
        cand(i, f"Kazak {w} model", brand="Acme", merchant=f"m{i}")
        for i, w in enumerate(["ala", "bere", "cilek", "dere", "elma", "fidan"])
    ]
    items += [
        cand(10 + i, f"Kazak {w} seri", brand=None, merchant=f"x{i}")
        for i, w in enumerate(["gul", "hasir", "isik"])
    ]
    picked = select_diverse(p, scored(p, items))
    assert sum(1 for s in picked if s.candidate.brand == "Acme") == MAX_PER_BRAND
    assert sum(1 for s in picked if s.candidate.brand is None) == 3


def test_placeholder_brand_is_not_a_brand():
    p = Profile("t", core=("hali",), target=10)
    words = ["ala", "bere", "cilek", "dere", "elma", "fidan"]
    items = [
        cand(i, f"Hali {word} seri", brand="Diğer", path="ev-yasam", merchant=f"m{i}")
        for i, word in enumerate(words)
    ]
    assert len(select_diverse(p, scored(p, items))) == 6


def test_merchant_cap_does_not_backfill_with_unfit_items():
    p = Profile("t", core=("kazak",), target=10)
    words = ["ala", "bere", "cilek", "dere", "elma", "fidan", "gul", "hasir", "isik", "jale"]
    items = [cand(i, f"Kazak {w}", merchant="tek") for i, w in enumerate(words)]
    picked = select_diverse(p, scored(p, items))
    # hedefin yarisi (>=4) kadar; kalan doldurmak icin kisit gevsetilmez
    assert len(picked) == 5


def test_near_duplicates_are_dropped():
    p = Profile("t", core=("krem",), target=10)
    items = [
        cand(1, "Marka Yoğun Nemlendirici Krem 50 ml", merchant="a"),
        cand(2, "Marka Yoğun Nemlendirici Krem 100 ml", merchant="b"),
        cand(3, "Marka Yoğun Nemlendirici Krem 50 ml SKT İndirimi", merchant="c"),
        cand(4, "Başka Marka Onarıcı Gece Kremi", merchant="d"),
    ]
    picked = select_diverse(p, scored(p, items))
    assert sorted(s.candidate.product_id for s in picked) == [1, 4]


def test_subcategory_cap_but_root_category_is_not_capped():
    p = Profile("t", core=("canta",), target=8)  # kategori siniri = 4
    names = ["ala", "bere", "cilek", "dere", "elma", "fidan", "gul"]
    leaf = [
        cand(i, f"Canta {n} model", path="moda/canta", merchant=f"m{i}")
        for i, n in enumerate(names)
    ]
    assert len(select_diverse(p, scored(p, leaf))) == 4
    root = [cand(i, f"Canta {n} model", path="moda", merchant=f"m{i}") for i, n in enumerate(names)]
    assert len(select_diverse(p, scored(p, root))) == 7


def test_selection_is_deterministic_and_score_ordered():
    p = Profile("t", core=("kazak",), boost=("yun",), target=3)
    items = [
        cand(3, "Kazak ayri3 uc", merchant="a"),
        cand(1, "Yün Kazak ayri1 bir", merchant="b"),
        cand(2, "Kazak ayri2 iki", merchant="c"),
    ]
    first = [s.candidate.product_id for s in select_diverse(p, scored(p, items))]
    second = [s.candidate.product_id for s in select_diverse(p, scored(p, list(reversed(items))))]
    assert first == second == [1, 2, 3]


# --- regresyon seti: gercek katalog basliklari ----------------------------------

REGRESSION: list[tuple[str, str, str | None, bool]] = [
    # (trend, baslik, kategori, girmeli mi)
    (
        "kuru-ciltlere-son",
        "Isntree - Hyaluronic Acid Aqua Gel Cream - 100ml ( Yoğun Nemlendirici",
        "saglik-kozmetik/kozmetik",
        True,
    ),
    (
        "kuru-ciltlere-son",
        "Coskim Yoğun Nemlendirici ve Bariyer Güçlendirici Günlük Bakım Kremi",
        "saglik-kozmetik/kozmetik",
        True,
    ),
    (
        "kuru-ciltlere-son",
        "Herbasist Herbajel Masaj Jeli 200 ml SKT İndirimi",
        "saglik-kozmetik/kozmetik",
        False,
    ),
    (
        "kuru-ciltlere-son",
        "Swissoderm Anti Flake Shampoo 300 ml",
        "saglik-kozmetik/kozmetik",
        False,
    ),
    (
        "kuru-ciltlere-son",
        "Nemlendirici Vücut Losyonu Yedek 400 ml",
        "ev-yasam",
        False,
    ),  # kategori disi
    (
        "sivilceye-karsi-favoriler",
        "SKIN401 Pro %10 Azelaic Acid Intensive Gel Serum",
        "saglik-kozmetik/kozmetik",
        True,
    ),
    (
        "sivilceye-karsi-favoriler",
        "Wefood Organik Nohut Unu 350 gr SKT İndirimi",
        "saglik-kozmetik/kozmetik",
        False,
    ),
    (
        "gozenek-gorunumune-karsi",
        "TIAM Pore Minimizing 21 Serum 40ml SKT İndirimi",
        "saglik-kozmetik/kozmetik",
        True,
    ),
    (
        "cildi-isil-isil-yapanlar",
        "Clara Hygienics Bright Touch External Intimate Cream 50 ml",
        "saglik-kozmetik/kozmetik",
        False,
    ),
    ("bordo-geri-dondu", "Kadın Bordo Örgülü Süet Omuz Çantası", "moda/ayakkabi", True),
    ("bordo-geri-dondu", "Bordo Ruj", "saglik-kozmetik/kozmetik", False),  # moda disi
    ("bordo-geri-dondu", "Çocuk Bordo Tişört", "moda", False),
    ("kazak-mevsimi-basladi", "Grafik Desenli Oversize Triko Kazak Vizon", "moda", True),
    ("kazak-mevsimi-basladi", "Matcha Baskılı Oversize Sweatshirt Ekru", "moda", False),
    ("kis-gelmeden-al", "Kadın Siyah Kalın Tabanlı Deri Chelsea Bot", "moda/ayakkabi", True),
    ("kis-gelmeden-al", "Stanley Water Bottle 1.4 LT", "spor-outdoor", False),
    ("sahile-giderken", "Regular Fit Bağcıklı Allover Volley Erkek Deniz Şortu", "moda", True),
    ("sahile-giderken", "El Dokuma Kök Boyalı Antika Denizli Çal Seccade Halı", "ev-yasam", False),
    ("masa-basinda-daha-keyifli", "Nuphy Halo75 V2 IO Series Mekanik Klavye", "elektronik", True),
    ("masa-basinda-daha-keyifli", "ATK Dragonfly A9 Mini Wireless Mouse", "elektronik", True),
    ("masa-basinda-daha-keyifli", "DYSPHORIA Booby Mouse Skates", "elektronik", False),
    ("masa-basinda-daha-keyifli", "Gateron PCB Mount V2 Stabilizer", "elektronik", False),
    (
        "masa-basinda-daha-keyifli",
        "Uncle Panda Atlantis Cam Mousepad [Ön Sipariş]",
        "elektronik",
        False,
    ),
    (
        "kahve-kosesi-kuruyoruz",
        "Note Ultra Rich Color Göz Kalemi 09 Espresso - Acı Kahve",
        "saglik-kozmetik/kozmetik",
        False,
    ),
    ("kahve-kosesi-kuruyoruz", "Stanley The Transit Fliptop Mug 0.35L", "spor-outdoor", False),
    (
        "evi-daha-pahali-gosteren-seyler",
        "Klem Üçlü Blok Sırt Minderi Kılıfı 90 Cm - Fitilli Kadife",
        "ev-yasam",
        True,
    ),
    (
        "evi-daha-pahali-gosteren-seyler",
        "Grohe Lavabo Bataryası Atrio L Boyut Brushed Cool Sunrise",
        "ev-yasam",
        False,
    ),
    (
        "kyk-odasinin-olmazsa-olmazlari",
        "Night Night %100 Organik Pamuk Saten Bebek Lastikli Çarşaf 70 x 140 cm",
        "anne-bebek",
        False,
    ),
    # Production katalogundan (salt-okunur kuru kosu) yakalanan yanlis eslesmeler:
    ("sahile-giderken", "Mantar Şapkalı Metal Lambader", "ev-yasam", False),
    ("tatile-cikmadan-once", "Jüt Şapkalı Ahşap Küre Abajur", "ev-yasam", False),
    ("ege-yazi", "North Sails Erkek Keten Şapka", "moda", True),
    (
        "kahve-tonlari",
        "Pruva Kalın Tabanlı Kadın Sneaker",
        "spor-outdoor",
        False,
    ),  # "taba" != "Tabanlı"
    ("bu-sonbaharin-renkleri", "Pruva Kalın Tabanlı Kadın Sneaker", "spor-outdoor", False),
    ("kahve-tonlari", "Süet Taba Rengi Bot", "moda", True),
    ("kis-gelmeden-al", "Su Geçirmez Yazlık Parka Mont", "spor-outdoor", False),
    ("kis-gelmeden-al", "Naomi Dolgulu Kadın Şişme Mont", "spor-outdoor", True),
    ("bu-sonbaharin-renkleri", "Stanley Quencher Termos Haki 0.9 LT", "spor-outdoor", False),
    (
        "ogrenci-evi-kurtaricilari",
        "Stanley Classic Legendary Yemek Termosu 0.4L",
        "ev-yasam",
        False,
    ),
    ("kyk-odasinin-olmazsa-olmazlari", "Ahşap Çekmeceli Komodin", "ev-yasam", False),
    ("kyk-odasinin-olmazsa-olmazlari", "Jüt Sarkıt Aydınlatma", "ev-yasam", False),
    ("kyk-odasinin-olmazsa-olmazlari", "El Dokuma Yün Halı Yastık", "ev-yasam", False),
]


@pytest.mark.parametrize(("slug", "title", "path", "expected"), REGRESSION)
def test_regression_membership(slug: str, title: str, path: str | None, expected: bool):
    profile = BY_SLUG[slug]
    result = score_candidate(profile, cand(1, title, path=path, price=10_000))
    assert (result is not None) is expected, f"{slug}: {title}"


def test_term_regex_cache_is_stable():
    assert term_regex("kazak") is term_regex("kazak")


def test_kyk_price_ceiling_blocks_expensive_furniture():
    profile = BY_SLUG["kyk-odasinin-olmazsa-olmazlari"]
    assert (
        score_candidate(profile, cand(1, "Çalışma Masası", path="ev-yasam", price=9_975_000))
        is None
    )
    assert (
        score_candidate(profile, cand(2, "Masa Lambası", path="ev-yasam", price=199_500))
        is not None
    )


def test_home_trends_reject_extreme_prices():
    for slug in (
        "evi-daha-pahali-gosteren-seyler",
        "yeni-eve-cikanlar-icin",
        "evde-sonbahar-havasi",
    ):
        profile = BY_SLUG[slug]
        title = "El Dokuma Kahverengi Yün Halı"
        assert score_candidate(profile, cand(1, title, path="ev-yasam", price=30_000_000)) is None
        assert score_candidate(profile, cand(2, title, path="ev-yasam", price=500_000)) is not None
