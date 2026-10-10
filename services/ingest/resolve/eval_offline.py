"""Cevrimdisi eslestirme degerlendirmesi: `python -m resolve.eval_offline`.

Veritabani, Redis, Gemini ya da Jina gerektirmez; ayni girdi ayni cikti.
Cikis kodu: temel cizgiye gore regresyon varsa 1.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from resolve.calibrate import _key, load_pairs
from resolve.eval_metrics import Confusion, compare, confusion, summarize
from resolve.score import auto_eligible, combine, queue_threshold

BASELINE_PATH = (
    Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "matching" / "baseline.json"
)


def evaluate(path: Path | None = None) -> dict:
    data = load_pairs(path) if path else load_pairs()
    expected: list[bool] = []
    queued: list[bool] = []
    auto: list[bool] = []
    errors: list[dict] = []
    for want, group in ((True, data["should_match"]), (False, data["should_not_match"])):
        for pair in group:
            left, right = _key(pair["a"]), _key(pair["b"])
            result = combine(left, right)
            in_queue = result.score >= queue_threshold()
            in_auto = auto_eligible(result, left, right)
            expected.append(want)
            queued.append(in_queue)
            auto.append(in_auto)
            if in_queue != want or (in_auto and not want):
                errors.append(
                    {
                        "case": pair["case"],
                        "expected_match": want,
                        "score": round(result.score, 4),
                        "queued": in_queue,
                        "auto": in_auto,
                        "veto": result.veto,
                    }
                )
    queue_c: Confusion = confusion(expected, queued)
    auto_c: Confusion = confusion(expected, auto)
    metrics = {**summarize(queue_c, "queue"), **summarize(auto_c, "auto")}
    return {
        "pairs": len(expected),
        "positives": sum(expected),
        "negatives": len(expected) - sum(expected),
        "queue_confusion": queue_c.__dict__,
        "auto_confusion": auto_c.__dict__,
        "metrics": metrics,
        "errors": errors,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="resolve.eval_offline")
    parser.add_argument("--baseline", type=Path, default=BASELINE_PATH)
    parser.add_argument("--write-baseline", type=Path)
    parser.add_argument("--tolerance", type=float, default=0.0)
    parser.add_argument("--json", action="store_true", help="ham sonucu JSON yaz")
    args = parser.parse_args(argv)

    report = evaluate()
    if args.write_baseline:
        args.write_baseline.write_text(
            json.dumps({"metrics": report["metrics"], "pairs": report["pairs"]}, indent=2) + "\n",
            encoding="utf-8",
        )
        print(f"temel cizgi yazildi: {args.write_baseline}")
        return 0
    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
        return 0

    print(
        f"cift: {report['pairs']} ({report['positives']} eslesme, {report['negatives']} eslesmeme)"
    )
    for name, value in report["metrics"].items():
        print(f"  {name:<26} {value:.4f}")
    for error in report["errors"]:
        print(f"  HATA {error}")

    if not args.baseline.exists():
        print("temel cizgi yok; karsilastirma atlandi")
        return 0
    baseline = json.loads(args.baseline.read_text(encoding="utf-8"))
    changes = compare(baseline["metrics"], report["metrics"], args.tolerance)
    regressed = [c for c in changes if c["regressed"]]
    for change in regressed:
        print(
            f"  REGRESYON {change['metric']}: {change['baseline']:.4f} -> {change['current']:.4f}"
        )
    return 1 if regressed else 0


if __name__ == "__main__":
    raise SystemExit(main())
