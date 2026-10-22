"""Urun siniflandirma kurallari (karar 0133): saf fonksiyonlar, veritabani yok.

Regresyon seti (`classify_regression.json`) zorunludur: bir kural ya da esik degisince neyin
bozuldugu baska turlu gorulmez (CLAUDE.md).
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from classify.brands import brand_key, clean_source_brand, find_title_brand, name_norm
from classify.categories import common_ancestor, guess_source, guess_title
from classify.decide import ProductFacts, SourceVerdict, decide
from classify.lexicon import rows as lexicon_rows
from classify.taxonomy import APPLY_MIN_CONFIDENCE, DEVICE_PATHS, RULES, all_paths
from classify.text import PhraseIndex, path_norm, words

ROOT = Path(__file__).resolve().parents[3]
MIGRATIONS = tuple(
    ROOT / "packages" / "db" / "migrations" / name
    for name in (
        "0089_category_taxonomy.sql",
        "0091_category_taxonomy_v3.sql",
        "0094_category_taxonomy_v4.sql",
        "0095_category_taxonomy_v5.sql",
    )
)
NODE = re.compile(r"\('([a-z0-9/-]+)', '([^']+)', (?:TRUE|FALSE)\)")
REGRESSION = json.loads(
    (Path(__file__).parent / "classify_regression.json").read_text(encoding="utf-8")
)


def _migration_entries() -> list[tuple[str, str]]:
    return [
        entry
        for migration in MIGRATIONS
        for entry in NODE.findall(migration.read_text(encoding="utf-8"))
    ]


def _migration_paths() -> set[str]:
    return {path for path, _ in _migration_entries()}


# --- agac ve kural tutarliligi ---------------------------------------------------------


def test_every_rule_and_lexicon_path_exists_in_taxonomy_migration() -> None:
    tree = _migration_paths()
    assert len(tree) > 100
    missing = sorted(all_paths() - tree)
    assert missing == []


def test_taxonomy_migration_has_parents_before_children() -> None:
    tree = _migration_paths()
    for path in tree:
        if "/" in path:
            assert path.rsplit("/", 1)[0] in tree, path


def test_taxonomy_has_no_duplicate_paths_or_names_under_one_parent() -> None:
    entries = _migration_entries()
    paths = [p for p, _ in entries]
    # 0091 ana kategorileri tekrar etmez; 0089'daki tekrar yok (yol benzersiz).
    assert len(paths) == len(set(paths))
    siblings: dict[tuple[str, str], str] = {}
    for path, name in entries:
        parent = path.rsplit("/", 1)[0] if "/" in path else ""
        key = (parent, name.lower())
        assert key not in siblings, f"{path} ve {siblings.get(key)} ayni ad"
        siblings[key] = path


def test_rules_have_valid_confidence() -> None:
    for rule in RULES:
        assert 0 <= rule.confidence <= 100
        assert rule.phrases


def test_lexicon_rows_weight_by_depth() -> None:
    rows = {(r.kind, r.surface): r for r in lexicon_rows()}
    assert rows[("category", "kahve ekipmanları")].weight > rows[("category", "mutfak")].weight
    assert rows[("category", "oyuncu kulaklığı")].normalized == "elektronik/ses/kulaklik/oyuncu"
    surfaces = [(r.kind, r.surface) for r in lexicon_rows()]
    assert len(surfaces) == len(set(surfaces))


# --- metin -------------------------------------------------------------------------------


def test_fold_and_path_norm_are_stable() -> None:
    assert words("Phone Bags & Cases") == ["phone", "bag", "case"]
    assert words("Telefon Kılıfı") == ["telefon", "kilifi"]
    assert path_norm("Luggage & Bags > Women's Bags") == "luggage bags > women s bags"
    assert path_norm("Elektronik/Telefon") == "elektronik > telefon"
    assert path_norm("  ") == ""


def test_phrase_index_prefix_and_contiguity() -> None:
    index = PhraseIndex([("kilif*", "k"), ("phone case", "p")])
    assert [v for _, _, v in index.find(words("Silikon Kılıfları"))] == ["k"]
    assert [v for _, _, v in index.find(words("Phone Cases"))] == ["p"]
    assert index.find(words("case for phone")) == []
    with pytest.raises(ValueError):
        PhraseIndex([("ki*", "x")])


def test_common_ancestor() -> None:
    assert common_ancestor(["moda/canta/omuz-cantasi", "moda/canta/el-cantasi"]) == "moda/canta"
    assert common_ancestor(["moda/canta", "elektronik"]) is None


# --- regresyon seti ----------------------------------------------------------------------


@pytest.mark.parametrize("case", REGRESSION["source"], ids=lambda c: c["text"][:60])
def test_source_regression(case: dict) -> None:
    guess = guess_source(case["text"])
    if case["path"] is None:
        assert guess.path is None or guess.confidence < APPLY_MIN_CONFIDENCE
        return
    assert guess.path == case["path"]
    applies = guess.confidence >= APPLY_MIN_CONFIDENCE
    assert applies == case.get("apply", True), guess


@pytest.mark.parametrize("case", REGRESSION["title"], ids=lambda c: c["text"][:60])
def test_title_regression(case: dict) -> None:
    guess = guess_title(case["text"])
    applied = guess.path if guess.confidence >= APPLY_MIN_CONFIDENCE else None
    assert applied == case["path"], guess


@pytest.mark.parametrize("case", REGRESSION["brand"], ids=lambda c: c["text"][:60])
def test_brand_regression(case: dict) -> None:
    finding = find_title_brand(case["text"], accessory=case["accessory"])
    assert finding.brand == case["brand"]
    assert list(finding.compatible) == case["compatible"]


# --- marka normalizasyonu ------------------------------------------------------------------


def test_brand_key_merges_spellings() -> None:
    assert brand_key("XIAOMI") == brand_key("Xiaomi") == brand_key("xiaomi") == "xiaomi"
    assert brand_key("Xiao-mi") == "xiaomi"
    assert brand_key("L’Oréal Paris") == "lorealparis"
    assert name_norm("Royal Kludge") == "royalkludge"


@pytest.mark.parametrize(
    "raw", ["No Brand", "Markasız", "OEM", "generic", "Diğer", "-", "12345", "", None]
)
def test_junk_source_brand_is_dropped(raw: str | None) -> None:
    assert clean_source_brand(raw) is None


def test_source_brand_canonical_and_case() -> None:
    assert clean_source_brand("XIAOMI") == "Xiaomi"
    assert clean_source_brand("  Philips  ") == "Philips"
    assert clean_source_brand("JBL") == "JBL"
    assert clean_source_brand("KOTON") == "Koton"
    assert clean_source_brand("Trendyol", merchant_name="Trendyol") is None
    assert clean_source_brand("Trendyol Collection", merchant_name="Trendyol") == (
        "Trendyol Collection"
    )


def test_device_brand_needs_known_category() -> None:
    # Kategori bilinmiyorsa cihaz ureticisi marka olmaz (aksesuar olabilir).
    finding = find_title_brand("Xiaomi Mi Band 8 Silicone", accessory=False, category_known=False)
    assert finding.brand is None
    finding = find_title_brand("Baseus Cable 100W", accessory=False, category_known=False)
    assert finding.brand == "Baseus"


# --- karar birlesimi ----------------------------------------------------------------------


def _facts(
    title: str,
    source: SourceVerdict | None = None,
    *,
    brand_raw: str | None = None,
    kept_brand: bool = False,
    kept_category_path: str | None = None,
) -> ProductFacts:
    return ProductFacts(
        title=title,
        kept_brand=kept_brand,
        kept_category_path=kept_category_path,
        brand_raw=brand_raw,
        merchant_name=None,
        source=source,
    )


def test_source_wins_and_title_refines_below_it() -> None:
    src = SourceVerdict("elektronik/ses/kulaklik", 90, "suggested")
    d = decide(_facts("RGB Gaming Headset 7.1 Surround", src))
    assert (d.category_path, d.category_basis) == ("elektronik/ses/kulaklik/oyuncu", "source_title")
    # Karar 0138: baslik kaynak dalini hic desteklemeyip guclu bicimde baska dal gosteriyorsa
    # kaynak yazilmaz, baslik da kategoriyi tek basina degistirmez: inceleme.
    d = decide(_facts("Phone Case Silicone", src))
    assert (d.category_path, d.category_basis, d.detail) == (
        None,
        "conflict",
        "source_title_conflict",
    )


def test_weak_source_needs_title_agreement() -> None:
    weak = SourceVerdict("ev-yasam", 62, "suggested")
    d = decide(_facts("Moka Pot Espresso Maker", weak))
    assert d.category_path == "ev-yasam/mutfak/kahve-ekipmanlari"
    assert d.state == "applied"
    d = decide(_facts("Original Gift Hot Sale", weak))
    assert (d.category_path, d.category_basis, d.detail) == (None, "low_confidence", "weak_source")
    d = decide(_facts("Dog Collar Leather", weak))
    assert d.category_path is None and d.category_basis == "conflict"


def test_confirmed_and_rejected_source_map() -> None:
    confirmed = SourceVerdict("moda/canta", 40, "confirmed")
    d = decide(_facts("Totally Unrelated Words", confirmed))
    assert (d.category_path, d.confidence) == ("moda/canta", 100)
    rejected = SourceVerdict("moda/canta", 95, "rejected")
    d = decide(_facts("Totally Unrelated Words", rejected))
    assert d.category_path is None and d.state == "review"


def test_title_conflict_goes_to_review() -> None:
    d = decide(_facts("Yoga Mat and Phone Case Bundle"))
    assert d.category_path is None
    assert d.category_basis == "conflict"


def test_existing_values_are_kept() -> None:
    d = decide(_facts("Case for iPhone", kept_brand=True, kept_category_path="moda/canta"))
    assert (d.category_path, d.category_basis, d.brand_basis) == (
        "moda/canta",
        "existing",
        "existing",
    )


def test_compatible_accessory_never_gets_device_brand() -> None:
    src = SourceVerdict("elektronik/telefon/aksesuar/kilif", 90, "suggested")
    d = decide(_facts("Apple iPhone 16 Pro Max Clear Case MagSafe", src))
    assert d.brand_name is None
    assert "Apple" in d.compatible
    d = decide(_facts("Samsung Galaxy S24 Kılıf", src))
    assert d.brand_name is None and d.compatible == ("Samsung",)


def test_source_brand_beats_title() -> None:
    d = decide(_facts("Xiaomi uyumlu kablo", brand_raw="Ugreen"))
    assert (d.brand_name, d.brand_basis) == ("Ugreen", "source")
    assert d.compatible == ("Xiaomi",)


# --- karar 0138: kaynak/baslik celiskisi, parca/aksesuar, marka uyumlulugu ----------------


def _source(case: dict) -> SourceVerdict | None:
    src = case.get("source")
    if src is None:
        return None
    return SourceVerdict(src["path"], src["confidence"], src["status"])


@pytest.mark.parametrize("case", REGRESSION["decision"], ids=lambda c: c["text"][:60])
def test_decision_regression(case: dict) -> None:
    d = decide(_facts(case["text"], _source(case), brand_raw=case.get("brand_raw")))
    assert (d.category_path, d.state) == (case["path"], case["state"]), d
    if "detail" in case:
        assert d.detail == case["detail"], d
    if "brand" in case:
        assert d.brand_name == case["brand"], d
    if "compatible" in case:
        assert list(d.compatible) == case["compatible"], d


def test_independent_title_reading_does_not_override_source() -> None:
    """Baslik baska dali gosterse de kategoriyi kendisi DEGISTIRMEZ (olcumde yarisi yanlisti)."""
    kitchen = SourceVerdict("ev-yasam/mutfak", 88, "suggested")
    d = decide(
        _facts("LED screen treadmill intelligent commercial gym treadmill household", kitchen)
    )
    assert (d.category_path, d.detail) == (None, "source_title_conflict")
    # Ayni urun kaynaksiz gelseydi baslik tek basina yeterliydi.
    d = decide(_facts("LED screen treadmill intelligent commercial gym treadmill household"))
    assert d.category_path is None or d.category_basis == "title"


def test_title_support_keeps_source_despite_foreign_words() -> None:
    kitchen = SourceVerdict("ev-yasam/mutfak", 88, "suggested")
    # "car" yabanci alan isareti ama "coffee mug" kaynak dalini destekliyor.
    d = decide(_facts("Insulated Coffee Mug for Car Home Office", kitchen))
    assert d.state == "applied" and d.category_path.startswith("ev-yasam/mutfak")  # type: ignore[union-attr]


def test_same_domain_sibling_with_domain_cue_keeps_source() -> None:
    exterior = SourceVerdict("oto-bahce/oto-aksesuar", 88, "suggested")
    # "headlight" oto yedek parca kurali; "car" arac alani: urun arac aksesuari, kaynak surer.
    d = decide(_facts("Car Headlight Protective Film Smoke Black Tint", exterior))
    assert (d.category_path, d.category_basis) == ("oto-bahce/oto-aksesuar", "source")
    # Alan isareti olmadan kardes dal celiskisi incelemeye duser.
    d = decide(_facts("Motorcycle Exhaust Muffler Stainless", exterior))
    assert d.category_path is None and d.detail == "source_title_conflict"


def test_confirmed_source_map_keeps_priority_over_cues_but_not_over_strong_conflict() -> None:
    confirmed = SourceVerdict("ev-yasam/mutfak", 100, "confirmed")
    # Yalniz alan isareti: yonetici eslemesi korunur.
    d = decide(_facts("Car Cup Holder Organizer", confirmed))
    assert (d.category_path, d.confidence) == ("ev-yasam/mutfak", 100)
    # Guclu ve acik celiski: yonetici YOLU onayladi, bu urunu degil; yazilmaz, inceleme.
    d = decide(_facts("Phone Case Silicone Shockproof", confirmed))
    assert d.category_path is None and d.detail == "source_title_conflict"


def test_part_source_never_maps_to_the_device_itself() -> None:
    for raw in (
        "Computer & Office > Laptop Parts & Accessories",
        "Computer & Office > Tablet Accessories & Parts",
        "Home Appliances > Home Appliance Parts",
    ):
        guess = guess_source(raw)
        assert guess.path not in DEVICE_PATHS, raw
        assert guess.path is None or guess.confidence < APPLY_MIN_CONFIDENCE, (raw, guess)
    # Karar 0139: alet parcasi/aksesuari artik kendi dalina gider; karisik "Tool Parts" zayif kalir.
    guess = guess_source("Tools > Power Tool Parts & Accessories")
    # Satici cop kovasi: kaynak zayif, baslik dogrulamadikca yazilmaz (v3 olcumunde %88'de
    # kahve yazicisi ve motor kaputu "olcu aleti" oluyordu).
    assert guess.path == "ev-yasam/yapi-market/alet-yedek-parca"
    assert guess.confidence < APPLY_MIN_CONFIDENCE
    mixed = guess_source("Tools > Tool Parts")
    assert mixed.path == "ev-yasam/yapi-market" and mixed.confidence < APPLY_MIN_CONFIDENCE
    # Yalniz "aksesuar" diyen bolum cihazin aksesuar dalina gider.
    guess = guess_source("Consumer Electronics > Camera & Photo > Camera & Photo Accessories")
    assert (guess.path, guess.confidence >= APPLY_MIN_CONFIDENCE) == (
        "elektronik/kamera/aksesuar",
        True,
    )
    # Alan kategorisinde (bisiklet) parca kategorinin parcasidir: degismez.
    assert guess_source("Sports & Entertainment > Cycling > Bicycle Parts").path == (
        "spor-outdoor/bisiklet"
    )


def test_part_title_never_proves_a_device_category() -> None:
    weak_tools = SourceVerdict("ev-yasam/yapi-market", 70, "suggested")
    d = decide(
        _facts("SDS Plus Rotary Hammer Chuck Replacement for TE24 Rotary Hammers", weak_tools)
    )
    assert (d.category_path, d.detail) == (None, "part_title")
    # Ayni kaynakta gercek el aleti seti baslikla dogrulanir.
    d = decide(_facts("10Pcs Screwdriver Set Magnetic Bits", weak_tools))
    assert (d.category_path, d.category_basis) == (
        "ev-yasam/yapi-market/el-aletleri",
        "source_title",
    )
    # Kaynaksiz: cihaz basligi kategori olur, parca basligi olmaz.
    assert decide(_facts("Cordless Drill 21V Brushless Electric Drill")).category_basis == "title"
    d = decide(_facts("Suitable for Cordless Drill 21V Replacement Chuck"))
    assert d.category_path is None


def test_title_rules_do_not_fire_on_lookalike_words() -> None:
    assert guess_title("Food Grade Stainless Steel Drain Basket").path is None
    assert guess_title("Portable Small Air Conditioner Compressor").path is None
    assert guess_title("Kazakhstan Pizza Oven Door").path is None
    assert guess_title("Hair Conditioner Argan Oil 500ml").path == (
        "saglik-kozmetik/kozmetik/sac-bakimi"
    )


def test_ts_lexicon_fixture_matches_taxonomy() -> None:
    """TS sohbet/arama testleri ayni yuzeyleri kullanir; ayrisirsa fixture yeniden uretilir."""
    fixture = ROOT / "packages" / "core" / "src" / "search" / "classification-lexicon.fixture.json"
    want = [
        {"kind": r.kind, "surface": r.surface, "normalized": r.normalized, "weight": r.weight}
        for r in lexicon_rows()
    ]
    assert json.loads(fixture.read_text(encoding="utf-8")) == want
