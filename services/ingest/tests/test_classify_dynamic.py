"""Dinamik kategori adayi secimi (karar 0154): SAF birim testleri (veritabani yok).

Kapsam: kanit kurallari (bolge, kok, cinsiyet, parca/uyumluluk, rastgele onek), ayni adli
kategorilerin ebeveynle ayrilmasi, belirsizlikte geri cekilme, `refine` politikasi (V5'i
yalniz inceltir), veri dosyalarinin butunlugu.
"""

from __future__ import annotations

import csv
from pathlib import Path

from classify.decide import Decision
from classify.dynamic import (
    DIRECT_STEMS,
    UNRESOLVED_MIN_EVIDENCE,
    UNRESOLVED_MIN_SCORE,
    DynamicGuess,
    DynamicIndex,
    bridge,
    glossary,
    name_stems,
    refine,
    regions_for,
)
from classify.text import path_norm

ROOT = Path(__file__).resolve().parents[3]
PLAN = ROOT / "docs" / "reference" / "trendyol" / "category-tree-map.csv"

WOMEN_JUMPSUIT = "Women's Clothing > Jumpsuits&Rompers"
WOMEN_SLEEP = "Underwear > Women's Sleep & Lounge"
PENS = "Office & School Supplies > Pens, Pencils & Writing Supplies"
USED_PHONES = "Phones & Telecommunications > Used&Refurbished Phones"
ELECTRICAL = "Home Improvement > Electrical Equipment & Supplies"
WOMEN_BLOUSES = "Women's Clothing > Shirts & Blouses"

CATEGORIES = [
    ("giyim", "Giyim"),
    ("giyim/salopet-tulum", "Salopet & Tulum"),
    ("giyim/salopet-tulum/tulum", "Tulum"),
    ("giyim/ev-giyim", "Ev Giyim"),
    ("giyim/ev-giyim/pijama", "Pijama"),
    ("giyim/ic-giyim", "İç Giyim"),
    ("giyim/ic-giyim/pijama", "Pijama"),
    ("giyim/ic-giyim/corap", "Çorap"),
    ("giyim/ust-giyim", "Üst Giyim"),
    ("giyim/ust-giyim/kadin-bluz", "Kadın Bluz"),
    ("giyim/ust-giyim/bluz-tunik", "Bluz & Tunik"),
    ("giyim/ust-giyim/bluz-tunik/bluz", "Bluz"),
    ("giyim/diger-giyim", "Diğer Giyim"),
    ("kirtasiye-ofis-malzemeleri", "Kırtasiye & Ofis Malzemeleri"),
    ("kirtasiye-ofis-malzemeleri/kalem", "Kalem"),
    ("kirtasiye-ofis-malzemeleri/kalem/jel-murekkepli-kalem", "Jel Mürekkepli Kalem"),
    ("kirtasiye-ofis-malzemeleri/kalem/tukenmez-kalem", "Tükenmez Kalem"),
    ("kirtasiye-ofis-malzemeleri/kalem/dolma-kalem", "Dolma Kalem"),
    ("elektronik", "Elektronik"),
    ("elektronik/telefon", "Telefon"),
    ("elektronik/telefon/akilli-cep-telefonu", "Akıllı Cep Telefonu"),
    ("banyo-yapi-hirdavat", "Banyo Yapı & Hırdavat"),
    ("banyo-yapi-hirdavat/elektrik-tesisat-malzemesi", "Elektrik Tesisat Malzemesi"),
    ("banyo-yapi-hirdavat/elektrik-tesisat-malzemesi/transformator", "Transformatör"),
    ("banyo-yapi-hirdavat/elektrik-tesisat-malzemesi/guvenlik-urunleri", "Güvenlik Ürünleri"),
]
SCOPES = ["giyim", "kirtasiye-ofis-malzemeleri", "elektronik/telefon", "banyo-yapi-hirdavat"]


def index() -> DynamicIndex:
    return DynamicIndex(CATEGORIES, SCOPES)


def test_kapsam_disindaki_ve_kok_dugumler_aday_olmaz() -> None:
    idx = DynamicIndex(CATEGORIES, ["giyim"])
    assert "giyim/salopet-tulum/tulum" in idx.nodes
    assert "kirtasiye-ofis-malzemeleri/kalem" not in idx.nodes
    # Kapsam disi dal icin aday uretilmez: motor yalniz etkin kapsamda calisir.
    assert idx.guess("Gel Ink Pen", PENS).path is None
    # Kok sonuc vermez (kaynak zaten kaba dali soyler; dinamik motor INCELTIR).
    guess = idx.guess("Women Jumpsuit", WOMEN_JUMPSUIT)
    assert guess.path != "giyim"


def test_kaynak_bolgesi_yoksa_aday_yok() -> None:
    assert (
        index().guess("Women Jumpsuit Long Sleeve", "Special Category > Test").reason == "no_region"
    )
    assert index().guess("Women Jumpsuit Long Sleeve", None).path is None
    assert regions_for("Beauty & Health > Sex Products") == ()


def test_kaynak_yolu_tek_basina_yaprak_vermez() -> None:
    """Baslikta kanit yoksa kaynak ne derse desin aday yoktur."""
    guess = index().guess("Premium Quality Item 2024 New Arrival", WOMEN_JUMPSUIT)
    assert guess.path is None and guess.kind == "none"


def test_baslik_ve_kaynak_bolgesi_ayni_yaprakta_bulusur() -> None:
    guess = index().guess("Women Jumpsuit with Large Fur Collar Long Sleeve", WOMEN_JUMPSUIT)
    assert (guess.kind, guess.path) == ("match", "giyim/salopet-tulum/tulum")
    assert guess.confidence >= 88 and guess.runner_up is None


def test_ayni_adli_kategoriler_ebeveynle_ayrilir_ve_belirsizlik_yazilmaz() -> None:
    """'Pijama' iki ebeveynde var (ev-giyim, ic-giyim): baslik ayirmiyorsa YAZILMAZ."""
    idx = index()
    assert {"giyim/ev-giyim/pijama", "giyim/ic-giyim/pijama"} <= set(idx.nodes)
    assert idx.nodes["giyim/ev-giyim/pijama"].name == idx.nodes["giyim/ic-giyim/pijama"].name
    guess = idx.guess("Women Pajama Set Short Sleeve", WOMEN_SLEEP)
    assert guess.kind == "ambiguous" and guess.reason == "margin"
    assert guess.path in {"giyim/ev-giyim/pijama", "giyim/ic-giyim/pijama"}
    assert guess.runner_up in {"giyim/ev-giyim/pijama", "giyim/ic-giyim/pijama"}
    assert guess.path != guess.runner_up
    # Ata adi baslikta gecince ayni ad ebeveyn yoluyla cozulur.
    resolved = idx.guess("Women Home Wear Pajama Set", WOMEN_SLEEP)
    assert resolved.path == "giyim/ev-giyim/pijama" or resolved.kind == "ambiguous"


def test_kardes_yapraklar_yarisirsa_ust_dugume_geri_cekilir() -> None:
    idx = index()
    # Yalniz "pen": hicbir alt tur ayirt edilemez -> ortak ata `kalem`.
    guess = idx.guess("Luxury Pen Stationery Gift", PENS)
    assert guess.path == "kirtasiye-ofis-malzemeleri/kalem" and guess.kind == "match"
    # "Gel Ink Pen": yalniz jel murekkepli kalem TUM ayirt edici govdeleri karsilar -> iner.
    deep = idx.guess("Gel Ink Pen Black 0.5mm", PENS)
    assert deep.path == "kirtasiye-ofis-malzemeleri/kalem/jel-murekkepli-kalem"


def test_cinsiyet_celiskisi_adayi_eler() -> None:
    idx = index()
    men = idx.guess("Men Blouse Casual", WOMEN_BLOUSES)
    assert men.path != "giyim/ust-giyim/kadin-bluz"
    women = idx.guess("Women Elegant Blouse Summer", WOMEN_BLOUSES)
    assert women.path in {"giyim/ust-giyim/kadin-bluz", "giyim/ust-giyim/bluz-tunik/bluz"}


def test_parca_ve_uyumluluk_basligi_cihaz_kategorisine_girmez() -> None:
    """'Case for Samsung Phone': basliktaki telefon urunun kendisi degil uyumlu cihazdir."""
    idx = index()
    assert idx.guess("Case for Samsung Phone", USED_PHONES).path is None
    assert idx.guess("Samsung Smart Phone 128GB Unlocked Mobile", USED_PHONES).kind in {
        "match",
        "weak",
        "ambiguous",
    }


def test_rastgele_onek_cakismasi_eslesme_sayilmaz() -> None:
    """'transceiver', 'Transformatör' govdesiyle ('trans') yalnizca onek tutuyor diye eslesmez."""
    guess = index().guess("RS485 Optical Transceiver Ring Network Module", ELECTRICAL)
    assert guess.path is None
    assert "trans" not in DIRECT_STEMS


def test_tek_genel_sozcuk_kategoriyi_kanitlamaz() -> None:
    guess = index().guess("Boiler Safety Thermometer Gauge", ELECTRICAL)
    assert guess.path != "banyo-yapi-hirdavat/elektrik-tesisat-malzemesi/guvenlik-urunleri"


def test_dugum_adinin_tum_govdeleri_gecmeden_yaprak_secilmez() -> None:
    """'Akilli Aydinlatma': ata ile paylasilan 'akilli' de ad'in parcasidir (grow light degil)."""
    cats = [
        ("banyo-yapi-hirdavat", "Banyo Yapı & Hırdavat"),
        ("banyo-yapi-hirdavat/akilli-ev-aletleri", "Akıllı Ev Aletleri"),
        ("banyo-yapi-hirdavat/akilli-ev-aletleri/akilli-aydinlatma", "Akıllı Aydınlatma"),
    ]
    idx = DynamicIndex(cats, ["banyo-yapi-hirdavat"])
    node = "banyo-yapi-hirdavat/akilli-ev-aletleri/akilli-aydinlatma"
    assert idx.guess("LED Grow Lighting Lamp Full Spectrum", ELECTRICAL).path != node


def test_bas_sozcuge_bitisik_parca_adi_urunun_asil_turudur() -> None:
    """'Phone Holder Car Mount': urun telefon degil tutucudur; cihaz dugumune girmez."""
    idx = index()
    assert idx.guess("Smart Mobile Phone Holder Car Mount", USED_PHONES).path is None


def test_diger_artik_kovasi_aday_olmaz() -> None:
    assert (
        index().guess("Women Casual Other Clothing Item", WOMEN_BLOUSES).path != "giyim/diger-giyim"
    )


def test_ayni_girdi_ayni_sonuc_ve_motor_durumu_degistirmez() -> None:
    idx = index()
    first = idx.guess("Women Jumpsuit with Large Fur Collar", WOMEN_JUMPSUIT)
    again = idx.guess("Women Jumpsuit with Large Fur Collar", WOMEN_JUMPSUIT)
    assert first == again
    assert index().guess("Women Jumpsuit with Large Fur Collar", WOMEN_JUMPSUIT) == first


# --------------------------------------------------------------------------
# refine: V5 kararini yalniz inceltir
# --------------------------------------------------------------------------


def decision(
    path: str | None, basis: str, confidence: int = 90, detail: str | None = None
) -> Decision:
    return Decision(
        category_path=path,
        category_basis=basis,
        confidence=confidence,
        brand_name=None,
        brand_basis="none",
        compatible=(),
        detail=detail,
    )


def match(path: str, *, score: float = 0.92, n: int = 2) -> DynamicGuess:
    return DynamicGuess(path, 93, "match", score, None, ("hit:x",), None, n)


def test_refine_kaynak_yalniz_kararini_daha_derin_adayla_inceltir() -> None:
    old = decision("moda/kadin-giyim", "source")
    new = refine(old, match("giyim/salopet-tulum/tulum"))
    assert (new.category_path, new.category_basis, new.detail) == (
        "giyim/salopet-tulum/tulum",
        "source_title",
        None,
    )
    assert new.confidence == 93 and new.state == "applied"


def test_refine_ayni_ya_da_daha_sig_adayla_degistirmez() -> None:
    old = decision("anne-bebek/oyuncak/pelus", "source")
    assert refine(old, match("anne-bebek-cocuk/oyuncak")) is old  # daha sig
    assert refine(old, match("anne-bebek-cocuk/oyuncak/x")) is old  # ayni derinlik


def test_refine_mevcut_celiski_ve_baslik_dogrulanmis_karari_korur() -> None:
    deeper = match("giyim/salopet-tulum/tulum")
    for basis in ("existing", "conflict", "source_title", "title"):
        old = decision("moda/kadin-giyim", basis)
        assert refine(old, deeper) is old, basis


def test_refine_belirsiz_ve_zayif_adayi_yazmaz() -> None:
    old = decision("moda/kadin-giyim", "source")
    for kind in ("weak", "ambiguous", "none"):
        guess = DynamicGuess("giyim/salopet-tulum/tulum", 80, kind, 0.7)
        assert refine(old, guess) is old, kind


def test_refine_inceleme_bekleyen_urunde_siki_esik_ister() -> None:
    review = decision(None, "low_confidence", 60, "weak_source")
    strict = match(
        "giyim/salopet-tulum/tulum", score=UNRESOLVED_MIN_SCORE, n=UNRESOLVED_MIN_EVIDENCE
    )
    assert refine(review, strict).category_path == "giyim/salopet-tulum/tulum"
    assert refine(review, match("giyim/x/y", score=0.9, n=3)) is review  # puan dusuk
    assert refine(review, match("giyim/x/y", score=0.99, n=1)) is review  # tek kanit
    none = decision(None, "none", 0, "no_evidence")
    assert refine(none, strict).category_basis == "source_title"


def test_refine_marka_ve_diger_alanlara_dokunmaz() -> None:
    old = Decision("moda/kadin-giyim", "source", 90, "Acme", "title", ("Foo",), None, "r")
    new = refine(old, match("giyim/salopet-tulum/tulum"))
    assert (new.brand_name, new.brand_basis, new.compatible, new.brand_reason) == (
        "Acme",
        "title",
        ("Foo",),
        "r",
    )


# --------------------------------------------------------------------------
# Veri butunlugu
# --------------------------------------------------------------------------


def test_ad_govdeleri() -> None:
    assert name_stems("Kadın Spor Ayakkabı") == ("kadin", "spor", "ayakk")
    assert name_stems("Salopet & Tulum") == ("salop", "tulum")
    assert name_stems("Diğer 3D Ürünleri") == ("3d",) or name_stems("Diğer 3D Ürünleri") == ()


def test_sozluk_biçimi_ve_tutarliligi() -> None:
    entries, generic = glossary()
    assert len(entries) >= 550 and len(generic) >= 5
    assert not set(entries) & generic
    for stem, phrases in entries.items():
        assert 2 <= len(stem) <= 5 and stem == stem.lower(), stem
        assert phrases and all(all(w for w in phrase) for phrase in phrases), stem
    # Yinelenen govde satiri yok (ikinci satir ilkini sessizce ezerdi).
    lines = [
        line.split("\t")[0]
        for line in (ROOT / "services/ingest/classify/data/glossary_tr_en.tsv")
        .read_text(encoding="utf-8")
        .splitlines()
        if line.strip() and not line.startswith("#")
    ]
    assert len(lines) == len(set(lines))


def test_kaynak_koprusu_butunlugu_ve_bolgeler_trendyol_planinda() -> None:
    plan = list(csv.DictReader(PLAN.open(encoding="utf-8")))
    paths = {r["manicepte_path"] for r in plan}
    created = {r["manicepte_path"] for r in plan if r["action"] == "create"}
    table = bridge()
    assert len(table) >= 270
    raw_lines = [
        line
        for line in (ROOT / "services/ingest/classify/data/source_bridge.tsv")
        .read_text(encoding="utf-8")
        .splitlines()
        if line.strip() and not line.startswith("#")
    ]
    assert len(raw_lines) == len(table)  # her kaynak yolu tam bir kez
    for source, regions in table.items():
        assert source == path_norm(source)
        for region in regions:
            assert region in paths, (source, region)
    # Her bolge ya Trendyol'dan OLUSTURULMUS bir dugumdur ya da altinda olusturulmus dugum vardir.
    for regions in table.values():
        for region in regions:
            assert region in created or any(c.startswith(region + "/") for c in created), region
    assert sum(1 for regions in table.values() if not regions) >= 10  # bilerek bolgesiz yollar
