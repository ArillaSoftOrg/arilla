"""Eslestirme degerlendirme metrikleri (Faz 1A) — veritabani, ag, model yok.

    python -m resolve.eval_offline [--baseline yol] [--write-baseline yol]

`pairs.json` (elle yazilmis regresyon seti) uretimdeki `combine()` ile
skorlanir; iki karar noktasi ayri olculur:

- kuyruk  (skor >= queue_threshold):   insana gosterilir
- otomatik (`auto_eligible`):          insan gormeden baglanir

Esikler ve agirliklar BURADA DEGISTIRILMEZ; yalnizca mevcut degerler olculur.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Confusion:
    tp: int = 0
    fp: int = 0
    fn: int = 0
    tn: int = 0


def _ratio(numerator: float, denominator: float) -> float:
    return 0.0 if denominator == 0 else numerator / denominator


def precision(c: Confusion) -> float:
    return _ratio(c.tp, c.tp + c.fp)


def recall(c: Confusion) -> float:
    return _ratio(c.tp, c.tp + c.fn)


def f1(c: Confusion) -> float:
    p, r = precision(c), recall(c)
    return _ratio(2 * p * r, p + r)


def false_match_rate(c: Confusion) -> float:
    """Gercekte farkli ciftlerin "ayni" sayilma orani: FP / (FP + TN)."""
    return _ratio(c.fp, c.fp + c.tn)


def macro_f1(c: Confusion) -> float:
    """Iki sinif ("ayni", "farkli") uzerinden macro-F1."""
    inverse = Confusion(tp=c.tn, fp=c.fn, fn=c.fp, tn=c.tp)
    return (f1(c) + f1(inverse)) / 2


def confusion(expected_match: list[bool], predicted_match: list[bool]) -> Confusion:
    tp = fp = fn = tn = 0
    for want, got in zip(expected_match, predicted_match, strict=True):
        if want and got:
            tp += 1
        elif not want and got:
            fp += 1
        elif want and not got:
            fn += 1
        else:
            tn += 1
    return Confusion(tp, fp, fn, tn)


def summarize(c: Confusion, prefix: str) -> dict[str, float]:
    return {
        f"{prefix}_precision": precision(c),
        f"{prefix}_recall": recall(c),
        f"{prefix}_f1": f1(c),
        f"{prefix}_macro_f1": macro_f1(c),
        f"{prefix}_false_match_rate": false_match_rate(c),
    }


#: Metrik adi -> iyi yon. `lower` ise artis regresyondur.
DIRECTIONS: dict[str, str] = {
    "queue_precision": "higher",
    "queue_recall": "higher",
    "queue_f1": "higher",
    "queue_macro_f1": "higher",
    "queue_false_match_rate": "lower",
    "auto_precision": "higher",
    "auto_recall": "higher",
    "auto_f1": "higher",
    "auto_macro_f1": "higher",
    "auto_false_match_rate": "lower",
}


def compare(
    baseline: dict[str, float], current: dict[str, float], tolerance: float = 0.0
) -> list[dict]:
    """Iki kosuyu karsilastirir; kotulesen metrikler `regressed=True` olur."""
    changes: list[dict] = []
    for metric, direction in DIRECTIONS.items():
        if metric not in baseline or metric not in current:
            continue
        delta = current[metric] - baseline[metric]
        worse = -delta if direction == "higher" else delta
        changes.append(
            {
                "metric": metric,
                "baseline": baseline[metric],
                "current": current[metric],
                "delta": delta,
                "regressed": worse > tolerance + 1e-12,
            }
        )
    return changes
