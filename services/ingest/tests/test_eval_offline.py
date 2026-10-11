"""Faz 1A cevrimdisi degerlendirme altyapisi testleri (DB / API yok)."""

from __future__ import annotations

import json

import pytest

from resolve.eval_metrics import (
    Confusion,
    compare,
    confusion,
    f1,
    false_match_rate,
    macro_f1,
    precision,
    recall,
)
from resolve.eval_offline import BASELINE_PATH, evaluate
from resolve.image_eval import evaluate_vectors


def test_confusion_and_basic_metrics() -> None:
    c = confusion([True, True, False, False, True], [True, False, True, False, True])
    assert c == Confusion(tp=2, fp=1, fn=1, tn=1)
    assert precision(c) == pytest.approx(2 / 3)
    assert recall(c) == pytest.approx(2 / 3)
    assert f1(c) == pytest.approx(2 / 3)
    assert false_match_rate(c) == pytest.approx(0.5)


def test_undefined_ratios_are_zero_not_error() -> None:
    assert precision(Confusion()) == 0.0
    assert false_match_rate(Confusion(tp=3)) == 0.0


def test_macro_f1_averages_both_classes() -> None:
    perfect = Confusion(tp=5, tn=5)
    assert macro_f1(perfect) == 1.0
    # Hep "ayni" diyen model: pozitif F1 iyi, negatif F1 0 -> macro dusuk.
    always_match = Confusion(tp=5, fp=5)
    assert macro_f1(always_match) < f1(always_match)


def test_compare_flags_worse_in_each_direction() -> None:
    base = {"queue_precision": 1.0, "queue_false_match_rate": 0.0}
    cur = {"queue_precision": 0.9, "queue_false_match_rate": 0.05}
    changes = {c["metric"]: c for c in compare(base, cur)}
    assert changes["queue_precision"]["regressed"]
    assert changes["queue_false_match_rate"]["regressed"]
    assert not any(c["regressed"] for c in compare(cur, base))


def test_current_matching_does_not_regress_against_committed_baseline() -> None:
    """Esik/agirlik degisirse bu test hangi metrigin bozuldugunu soyler."""
    baseline = json.loads(BASELINE_PATH.read_text(encoding="utf-8"))
    report = evaluate()
    regressed = [c for c in compare(baseline["metrics"], report["metrics"]) if c["regressed"]]
    assert regressed == []
    assert report["pairs"] == baseline["pairs"], "set degisti; temel cizgiyi bilincli yenile"


def test_evaluation_is_deterministic() -> None:
    assert evaluate() == evaluate()


def test_image_eval_ignores_unverified_pairs_and_measures_separation() -> None:
    """SENTETIK vektorler: yalnizca kodun dogrulugunu sinar, model kalitesini degil."""
    data = {
        "items": {
            "a1": [1.0, 0.0],
            "a2": [0.99, 0.1],
            "b1": [0.0, 1.0],
            "c1": [0.7, 0.7],
        },
        "pairs": [
            {"a": "a1", "b": "a2", "same_product": True, "label_source": "human"},
            {"a": "a1", "b": "b1", "same_product": False, "label_source": "human"},
            # Dogrulanmamis: olcume girmemeli, yoksa metrik yapay sismis olur.
            {"a": "a1", "b": "c1", "same_product": True, "label_source": "model"},
        ],
    }
    report = evaluate_vectors(data)
    assert report.pairs == 2
    assert report.skipped_unverified == 1
    assert report.auc == 1.0
    assert report.false_match_rate == 0.0
    assert report.margin > 0
