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
from classify.taxonomy import APPLY_MIN_CONFIDENCE, RULES, all_paths
from classify.text import PhraseIndex, path_norm, words

ROOT = Path(__file__).resolve().parents[3]
MIGRATION = ROOT / "packages" / "db" / "migrations" / "0089_category_taxonomy.sql"
REGRESSION = json.loads(
    (Path(__file__).parent / "classify_regression.json").read_text(encoding="utf-8")
)


def _migration_paths() -> set[str]:
    sql = MIGRATION.read_text(encoding="utf-8")
    return set(re.findall(r"\('([a-z0-9/-]+)', '[^']+', (?:TRUE|FALSE)\)", sql))


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
    sql = MIGRATION.read_text(encoding="utf-8")
    entries = re.findall(r"\('([a-z0-9/-]+)', '([^']+)', (?:TRUE|FALSE)\)", sql)
    paths = [p for p, _ in entries]
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
    # Baslik baska bir dali gosterse de yapilandirilmis kaynak kazanir.
    d = decide(_facts("Phone Case Silicone", src))
    assert (d.category_path, d.category_basis) == ("elektronik/ses/kulaklik", "source")


def test_weak_source_needs_title_agreement() -> None:
    weak = SourceVerdict("ev-yasam", 62, "suggested")
    d = decide(_facts("Moka Pot Espresso Maker", weak))
    assert d.category_path == "ev-yasam/mutfak/kahve-ekipmanlari"
    assert d.state == "applied"
    d = decide(_facts("Original Gift Hot Sale", weak))
    assert d.category_path is None and d.state == "review"
    d = decide(_facts("Dog Collar Leather", weak))
    assert d.category_path is None and d.category_basis == "low_confidence"


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


def test_ts_lexicon_fixture_matches_taxonomy() -> None:
    """TS sohbet/arama testleri ayni yuzeyleri kullanir; ayrisirsa fixture yeniden uretilir."""
    fixture = ROOT / "packages" / "core" / "src" / "search" / "classification-lexicon.fixture.json"
    want = [
        {"kind": r.kind, "surface": r.surface, "normalized": r.normalized, "weight": r.weight}
        for r in lexicon_rows()
    ]
    assert json.loads(fixture.read_text(encoding="utf-8")) == want
