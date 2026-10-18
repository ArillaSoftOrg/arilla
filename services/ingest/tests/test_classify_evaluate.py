"""Dogruluk olcumu (karar 0139): olcer kendisi dogru olmali, yoksa rakamlara guvenilmez."""

from __future__ import annotations

from pathlib import Path

import pytest

from classify import evaluate as ev
from classify.decide import Decision


def _row(
    pid: str,
    title: str,
    source: str,
    category: str | None,
    brand: str | None = None,
) -> ev.LabeledRow:
    return ev.LabeledRow(pid, title, source, category, brand)


def _fixed(**by_id: Decision):
    return lambda row: by_id[row.product_id]


def _dec(path: str | None, brand: str | None = None, reason: str | None = None) -> Decision:
    return Decision(
        category_path=path,
        category_basis="source" if path else "conflict",
        confidence=88 if path else 0,
        brand_name=brand,
        brand_basis="title" if brand else "none",
        compatible=(),
        detail=None,
        brand_reason=reason,
    )


def test_unlabeled_rows_never_enter_precision() -> None:
    rows = [_row("a", "t", "s", None), _row("b", "t", "s", None)]
    m = ev.score(rows, _fixed(a=_dec("moda/canta"), b=_dec(None)))
    assert m.n_category_labeled == 0
    assert m.precision_strict is None and m.wrong_rate is None
    assert m.coverage_all == 0.5  # kapsama etiketsiz de hesaplanir; dogruluk hesaplanmaz


def test_exact_coarse_wrong_missed_and_correct_review() -> None:
    rows = [
        _row("exact", "t", "s", "moda/canta/omuz-cantasi"),
        _row("coarse", "t", "s", "moda/canta/omuz-cantasi"),
        _row("wrong", "t", "s", "moda/canta/omuz-cantasi"),
        _row("missed", "t", "s", "moda/canta/omuz-cantasi"),
        _row("ok_review", "t", "s", ev.NONE_LABEL),
        _row("bad_apply", "t", "s", ev.NONE_LABEL),
    ]
    m = ev.score(
        rows,
        _fixed(
            exact=_dec("moda/canta/omuz-cantasi"),
            coarse=_dec("moda/canta"),
            wrong=_dec("moda/canta/sirt-cantasi"),
            missed=_dec(None),
            ok_review=_dec(None),
            bad_apply=_dec("moda/canta"),
        ),
    )
    assert (m.exact, m.coarse, m.wrong, m.missed, m.correct_review) == (1, 1, 2, 1, 1)
    assert m.applied_labeled == 4
    assert m.precision_strict == 0.25 and m.precision_lenient == 0.5
    assert m.review_labeled == 2 and m.review_rate == pytest.approx(2 / 6, abs=1e-4)
    assert m.failures_by_source["s"] == {"wrong": 2, "missed": 1}


def test_accessory_main_confusion_is_counted_within_family_only() -> None:
    rows = [
        _row("a", "t", "s", "elektronik/telefon/cep-telefonu"),
        _row("b", "t", "s", "elektronik/telefon/aksesuar/kilif"),
        _row("c", "t", "s", "moda/canta"),
    ]
    m = ev.score(
        rows,
        _fixed(
            a=_dec("elektronik/telefon/aksesuar/kilif"),  # aksesuar yazildi, ana urun beklendi
            b=_dec("elektronik/telefon/cep-telefonu"),  # tersi
            c=_dec("elektronik/telefon/aksesuar/kilif"),  # baska aile: karisiklik degil
        ),
    )
    assert m.accessory_confusion == 2 and m.wrong == 3


def test_brand_precision_recall_and_empty_reasons() -> None:
    rows = [
        _row("a", "t", "s", None, "Keyence"),
        _row("b", "t", "s", None, ev.NONE_LABEL),
        _row("c", "t", "s", None, "Bosch"),
        _row("d", "t", "s", None, ev.NONE_LABEL),
    ]
    m = ev.score(
        rows,
        _fixed(
            a=_dec(None, "Keyence"),
            b=_dec(None, "Makita"),  # uyumlu marka urun markasi yazildi: yanlis
            c=_dec(None, None, "counterfeit_prone"),
            d=_dec(None, None, "compatible_only"),
        ),
    )
    assert (m.brand_predicted, m.brand_correct, m.brand_wrong) == (2, 1, 1)
    assert m.brand_precision == 0.5 and m.brand_recall == 0.5
    assert m.brand_empty_reasons == {"counterfeit_prone": 1, "compatible_only": 1}


def test_unknown_expected_path_is_rejected() -> None:
    with pytest.raises(ValueError, match="agacta yok"):
        ev.score([_row("a", "t", "s", "olmayan/yol")], _fixed(a=_dec(None)))


def test_split_is_stable_and_roughly_even() -> None:
    ids = [str(i) for i in range(2000)]
    first = [ev.split_of(i) for i in ids]
    assert first == [ev.split_of(i) for i in ids]
    assert 800 < first.count("dev") < 1200


def test_stratified_sample_caps_each_source_and_is_reproducible() -> None:
    recs = [("a", i) for i in range(50)] + [("b", i) for i in range(3)]
    one = ev.stratified_sample(recs, lambda r: r[0], 5, seed=1)
    assert [r[0] for r in one].count("a") == 5 and [r[0] for r in one].count("b") == 3
    assert one == ev.stratified_sample(recs, lambda r: r[0], 5, seed=1)


def test_read_labels_roundtrip(tmp_path: Path) -> None:
    path = tmp_path / "labels.tsv"
    path.write_text(
        "product_id\ttitle\tsource_category\texpected_category\texpected_brand\n"
        "1\tFoo\tHome\tev-yasam/mutfak\t-\n"
        "2\tBar\tHome\t\t\n",
        encoding="utf-8",
    )
    rows = ev.read_labels(path)
    assert rows[0].expected_category == "ev-yasam/mutfak" and rows[0].expected_brand == "-"
    assert rows[1].expected_category is None and rows[1].expected_brand is None


# --- sabit etiketli kume ve "onlenen hata geri gelmesin" korumasi (karar 0139) ----------------

FIXTURES = Path(__file__).parent


def test_prevented_errors_never_come_back() -> None:
    """v1/v2'nin yanlis yazdigi urunlere hicbir surum ayni yolu yeniden yazmaz."""
    import json

    from classify.decide import ProductFacts, decide

    cases = json.loads((FIXTURES / "classify_prevented_errors.json").read_text(encoding="utf-8"))
    assert len(cases["cases"]) >= 50
    back = []
    for case in cases["cases"]:
        d = decide(
            ProductFacts(
                title=case["title"],
                kept_brand=False,
                kept_category_path=None,
                brand_raw=None,
                merchant_name=None,
                source=ev.verdict_for(case["source_category"]),
            )
        )
        if d.state == "applied" and d.category_path == case["wrong_path"]:
            back.append((case["origin"], case["title"][:60], case["wrong_path"]))
    assert back == []


def test_frozen_eval_labels_score_is_sane() -> None:
    """Sabit etiketli kume (model etiketli, insan dogrulamasi yok): yalniz asiri gerileme alarmi."""
    rows = ev.read_labels(FIXTURES / "classify_eval_labels.tsv")
    assert len(rows) >= 200
    m = ev.score(rows)
    assert m.n_category_labeled == len(rows)
    # v1 ~%58 isabetti, %27 yanlisti; v2/v3 ~%71-72 ve ~%13-14. Esikler bilerek gevsek.
    assert m.precision_strict is not None and m.precision_strict >= 0.66
    assert m.wrong_rate is not None and m.wrong_rate <= 0.20
    assert m.accessory_confusion == 0
