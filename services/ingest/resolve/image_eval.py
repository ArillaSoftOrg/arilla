"""Gorsel benzerlik olcum seti (Faz 1A) — cevrimdisi, Jina cagrisi yok.

Ucretli embedding API'si testte zorunlu degildir. Olcum, ONCEDEN uretilmis
embedding'ler uzerinde calisir:

    python -m resolve.image_eval --dataset yol/image_pairs.json

Veri bicimi (`image_pairs.json`):

    {
      "model": "jina-clip-v2", "dim": 1024,
      "items": {"<id>": [0.1, ...]},
      "pairs": [
        {"a": "<id>", "b": "<id>", "same_product": true,  "label_source": "human"},
        {"a": "<id>", "b": "<id>", "same_product": false, "label_source": "human"}
      ]
    }

Yalnizca `label_source == "human"` ciftleri olcume girer; digerleri aday
havuzunda kalir ve ayrica raporlanir. Gorsel dosyalar depoya konmaz (KVKK,
kural 10): yalnizca vektor ve etiket tutulur.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path

from resolve.score import image_similarity


@dataclass(frozen=True)
class ImageEvalReport:
    pairs: int
    skipped_unverified: int
    auc: float
    best_threshold: float
    precision: float
    recall: float
    f1: float
    false_match_rate: float
    #: Her "same" ciftin en yuksek "different" ciftten yuksek skorlu oldugu oran
    #: AUC ile ayni; ayrica ayrim boslugu (en dusuk same - en yuksek different).
    margin: float


def _auc(positives: list[float], negatives: list[float]) -> float:
    """Mann-Whitney U: rastgele secilen bir pozitifin negatiften yuksek olma olasiligi."""
    if not positives or not negatives:
        return 0.0
    wins = sum(1.0 if p > n else 0.5 if p == n else 0.0 for p in positives for n in negatives)
    return wins / (len(positives) * len(negatives))


def evaluate_vectors(data: dict, threshold: float | None = None) -> ImageEvalReport:
    items = data["items"]
    positives: list[float] = []
    negatives: list[float] = []
    skipped = 0
    for pair in data["pairs"]:
        if pair.get("label_source") != "human":
            skipped += 1
            continue
        score = image_similarity(items[pair["a"]], items[pair["b"]])
        (positives if pair["same_product"] else negatives).append(score)

    candidates = sorted(set(positives + negatives))
    if threshold is None:
        # Esik verilmediyse F1'i en yuksek yapan; ESIKLER URETIMDE DEGISTIRILMEZ,
        # bu yalnizca ayrim kalitesini gosterir.
        threshold = max(candidates, key=lambda t: _f1_at(positives, negatives, t), default=0.0)
    tp = sum(1 for s in positives if s >= threshold)
    fp = sum(1 for s in negatives if s >= threshold)
    fn = len(positives) - tp
    tn = len(negatives) - fp
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    return ImageEvalReport(
        pairs=len(positives) + len(negatives),
        skipped_unverified=skipped,
        auc=_auc(positives, negatives),
        best_threshold=threshold,
        precision=p,
        recall=r,
        f1=2 * p * r / (p + r) if p + r else 0.0,
        false_match_rate=fp / (fp + tn) if fp + tn else 0.0,
        margin=(min(positives) - max(negatives)) if positives and negatives else 0.0,
    )


def _f1_at(positives: list[float], negatives: list[float], t: float) -> float:
    tp = sum(1 for s in positives if s >= t)
    fp = sum(1 for s in negatives if s >= t)
    fn = len(positives) - tp
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    return 2 * p * r / (p + r) if p + r else 0.0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="resolve.image_eval")
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--threshold", type=float)
    args = parser.parse_args(argv)
    data = json.loads(args.dataset.read_text(encoding="utf-8"))
    report = evaluate_vectors(data, args.threshold)
    for name, value in report.__dict__.items():
        print(f"  {name:<20} {value}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
