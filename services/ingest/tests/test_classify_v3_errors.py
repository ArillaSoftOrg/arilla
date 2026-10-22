"""Karar 0141 regresyon testleri: uretim ornegindeki (196 urun) yanlis atamalarin kok nedenleri.

`classify_error_cases.json` gercek baslik + kaynak yolu ve genellenmis/koruma vakalarini tasir.
Testler urun KIMLIGI ya da tek urune ozel kural icermez; karar `evaluate.verdict_for` ile
(kaynak onerisi + cinsiyet baglami, `Catalog.source_verdict` ile ayni) alinir.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from classify.categories import (
    guess_source,
    guess_title,
    has_part_number,
    source_gender,
    title_evidence,
)
from classify.decide import Decision, ProductFacts, decide
from classify.evaluate import verdict_for
from classify.taxonomy import ERKEK, KADIN, RULE_VERSION

CASES = json.loads((Path(__file__).parent / "classify_error_cases.json").read_text("utf-8"))[
    "cases"
]


def _decide(title: str, source_category: str | None, kept: str | None = None) -> Decision:
    return decide(
        ProductFacts(
            title=title,
            kept_brand=False,
            kept_category_path=kept,
            brand_raw=None,
            merchant_name=None,
            source=verdict_for(source_category) if source_category else None,
        )
    )


@pytest.mark.parametrize("case", CASES, ids=lambda c: c["title"][:70])
def test_error_case(case: dict) -> None:
    expect = case["expect"]
    d = _decide(case["title"], case["source_category"])
    if "path" in expect:
        assert d.category_path == expect["path"], d
    if "state" in expect:
        assert d.state == expect["state"], d
    if "detail" in expect:
        assert d.detail == expect["detail"], d
    assert d.category_path not in expect.get("must_not", []), d


def test_rule_version_was_bumped() -> None:
    assert RULE_VERSION >= 4


@pytest.mark.parametrize(
    "title",
    [
        "AINY-For Beetle Compatible Front Bumper Bracket(Left) Part Number 5C5807773",
        "LH Front Instrument Cup Holder 99155219401 For 997 Boxster Cayman",
        "Mud Flap Genuine OEM Part Number 76622-60170",
        "Motor Mount 69W-44555-00-4D for Outboard",
    ],
)
def test_part_number_is_detected(title: str) -> None:
    assert has_part_number(title)


@pytest.mark.parametrize(
    "title",
    [
        "iPhone 15 Pro Max Case Clear Shockproof",
        "USB Flash Drive 128GB 3.0 High Speed",
        "LED Strip 5050 12V 5M Waterproof",
        "Women Perfume Eau de Parfum 100ml",
        "Part nobody wants",
    ],
)
def test_ordinary_numbers_are_not_part_numbers(title: str) -> None:
    assert not has_part_number(title)


def test_gender_context_of_source_and_title() -> None:
    assert source_gender("Men's Clothing > Middle East Fashion") == {ERKEK}
    assert source_gender("Women's Bags > Shoulder Bags") == {KADIN}
    assert source_gender("Home & Garden > Kitchen,Dining & Bar") == frozenset()
    assert title_evidence("Men's Thobe Dress").gender == {ERKEK}
    assert title_evidence("Gift for Men and Women Dress").gender == {ERKEK, KADIN}


def test_opposite_gender_branch_is_not_a_candidate() -> None:
    assert guess_title("Men's Gown Dress Loose Casual").path != "moda/kadin-giyim/elbise"
    assert guess_title("Women's Maxi Dress Floral").path == "moda/kadin-giyim/elbise"
    # Iki cinsiyet de soyleniyorsa hicbiri elenmez.
    both = title_evidence("Maxi Dress for Men and Women Casual Loose")
    assert "moda/kadin-giyim/elbise" in both.paths


def test_specific_ancestor_outvotes_contradicting_leaf_but_generic_one_does_not() -> None:
    # "Tools" el aleti degil, peruk aksesuari (ust bolum ozel ve baska ana kategoride).
    wig = guess_source("Hair Extensions & Wigs > Hair Tools & Accessories")
    assert wig.path == "saglik-kozmetik/peruk"
    assert wig.confidence < 80  # zayif: baslik dogrulamadikca yazilmaz
    # Ust bolum yalniz genel bir ad ("Home & Garden"): yaprak (petshop) kazanir.
    assert guess_source("Home & Garden > Pet Products").path == "petshop"


def test_source_buckets_for_new_branches() -> None:
    assert guess_source("Motorcycle Equipments & Parts > Boats").path == "oto-bahce/tekne-deniz"
    assert (
        guess_source("Beauty & Health > Bath & Shower").path
        == "saglik-kozmetik/kisisel-bakim/banyo-vucut"
    )
    # Motosiklet bucket'i etkilenmez.
    assert (
        guess_source("Motorcycle Equipments & Parts > Motorcycle & ATV").path
        == "oto-bahce/motosiklet"
    )


def test_high_source_confidence_does_not_hide_a_part_number_listing() -> None:
    """Guven yuksek (90) olsa da parca numarali baslik tuketici kovasinda inceleme bekler."""
    title = "Rear Bumper Cover Trim 51127294 For X5 Genuine OEM Part Number 51127294"
    src = verdict_for("Mother & Kids > Baby Strollers&Accessories")
    assert src is not None and src.confidence >= 90
    d = decide(ProductFacts(title, False, None, None, None, src))
    assert (d.category_path, d.state, d.detail) == (None, "review", "part_number_conflict")


def test_existing_manual_category_is_still_kept() -> None:
    """v2/v3 guvenligi: yonetici/besleme degeri hicbir yeni kuralla ezilmez."""
    d = _decide(
        "Part Number 5C5807773 Bumper Bracket",
        "Mother & Kids > Baby Strollers&Accessories",
        kept="ev-yasam/mutfak",
    )
    assert (d.category_path, d.category_basis) == ("ev-yasam/mutfak", "existing")
