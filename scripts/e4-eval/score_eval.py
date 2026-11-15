"""E4: kor etiket puanlari + anahtar -> yontem basina nDCG@10, P@10, MRR (sorgu bazinda ve toplam).

    python score_eval.py <puanlar.csv> <anahtar.csv> <sorgular.tsv> <cikti.json> [--score-col oneri_puan_0_3]

Tanimlar (pooled judgment: her sorgunun havuzu = uc yontemin ilk 10'unun birlesimi, hepsi puanli):
- nDCG@10: kazanc (2^r - 1), indirim log2(sira + 1); ideal = havuzdaki puanlarin en iyi 10'u.
  Yontem 10'dan az donduyse eksik siralar 0 kazanctir. Havuzda alakali (r >= 1) hic oge yoksa
  sorgu nDCG ortalamasindan cikarilir ("katalogda yok" kumesi, ayrica raporlanir).
- P@10 (r >= 2) ve P@10 kati (r = 3): payda daima 10 (eksik sonuc alakasiz sayilir).
- MRR (r >= 2) ve MRR kati (r = 3): ilk alakali ogenin 1/sira'si, yoksa 0.
- Eslestirmeli karsilastirma: sorgu bazinda kazanma/kaybetme ve 10.000 tekrarli bootstrap %95 GA.
"""

from __future__ import annotations

import csv
import json
import math
import random
import sys
from collections import Counter, defaultdict
from pathlib import Path

METHODS = ("lexical", "dense", "hybrid")


def ndcg(gains: list[int], ideal: list[int]) -> float | None:
    def dcg(rs: list[int]) -> float:
        return sum((2**r - 1) / math.log2(i + 2) for i, r in enumerate(rs[:10]))

    best = dcg(sorted(ideal, reverse=True))
    return None if best == 0 else dcg(gains) / best


def mrr(rs: list[int], threshold: int) -> float:
    for i, r in enumerate(rs[:10]):
        if r >= threshold:
            return 1 / (i + 1)
    return 0.0


def boot(diffs: list[float], n: int = 10_000, seed: int = 7) -> tuple[float, float]:
    rng = random.Random(seed)
    means = sorted(sum(rng.choice(diffs) for _ in diffs) / len(diffs) for _ in range(n))
    return round(means[int(0.025 * n)], 4), round(means[int(0.975 * n)], 4)


def main() -> int:
    scores_path, key_path, queries_path, out_path = (Path(a) for a in sys.argv[1:5])
    col = (
        sys.argv[sys.argv.index("--score-col") + 1]
        if "--score-col" in sys.argv
        else "oneri_puan_0_3"
    )
    labels = {}
    conf = Counter()
    for row in csv.DictReader(scores_path.open(encoding="utf-8-sig")):
        value = row[col].strip()
        if value not in {"0", "1", "2", "3"}:
            raise SystemExit(f"{row['item_id']}: gecersiz puan {value!r}")
        labels[row["item_id"]] = (row["query_id"], int(value), row.get("guven", ""))
        conf[row.get("guven", "")] += 1
    key = list(csv.DictReader(key_path.open(encoding="utf-8")))
    if {k["item_id"] for k in key} != set(labels):
        raise SystemExit("anahtar ile puan dosyasindaki item_id kumeleri ayni degil")
    groups = {
        r["id"]: r["group"]
        for r in csv.DictReader(queries_path.open(encoding="utf-8"), delimiter="\t")
    }
    texts = {
        r["id"]: r["query"]
        for r in csv.DictReader(queries_path.open(encoding="utf-8"), delimiter="\t")
    }

    pool: dict[str, list[int]] = defaultdict(list)
    ranked: dict[str, dict[str, list[tuple[int, int]]]] = defaultdict(
        lambda: defaultdict(list)
    )
    for k in key:
        qid, score, _ = labels[k["item_id"]]
        if qid != k["query_id"]:
            raise SystemExit(f"{k['item_id']}: sorgu kimligi uyusmuyor")
        pool[qid].append(score)
        for m in METHODS:
            rank = k[f"{m}_rank"]
            if rank:
                ranked[qid][m].append((int(rank), score))

    per_query = []
    for qid in sorted(pool):
        entry = {
            "id": qid,
            "query": texts[qid],
            "group": groups[qid],
            "pool": len(pool[qid]),
            "pool_relevant_ge2": sum(1 for s in pool[qid] if s >= 2),
            "pool_any_relevant": any(s >= 1 for s in pool[qid]),
        }
        for m in METHODS:
            rs = [s for _, s in sorted(ranked[qid][m])]
            entry[m] = {
                "returned": len(rs),
                "ndcg10": ndcg(rs, pool[qid]),
                "p10": sum(1 for r in rs if r >= 2) / 10,
                "p10_strict": sum(1 for r in rs if r == 3) / 10,
                "mrr": mrr(rs, 2),
                "mrr_strict": mrr(rs, 3),
                "zeros_in_top10": sum(1 for r in rs if r == 0),
            }
        per_query.append(entry)

    def agg(entries: list[dict]) -> dict:
        out = {}
        for m in METHODS:
            vals = [e[m] for e in entries]
            nd = [v["ndcg10"] for v in vals if v["ndcg10"] is not None]
            out[m] = {
                "queries": len(vals),
                "ndcg10": round(sum(nd) / len(nd), 4) if nd else None,
                "ndcg_queries": len(nd),
                "p10": round(sum(v["p10"] for v in vals) / len(vals), 4),
                "p10_strict": round(sum(v["p10_strict"] for v in vals) / len(vals), 4),
                "mrr": round(sum(v["mrr"] for v in vals) / len(vals), 4),
                "mrr_strict": round(sum(v["mrr_strict"] for v in vals) / len(vals), 4),
                "empty": sum(1 for v in vals if v["returned"] == 0),
            }
        return out

    judged = [e for e in per_query if e["pool_any_relevant"]]
    absent = [e for e in per_query if not e["pool_any_relevant"]]
    lex_nonempty = [e for e in judged if e["lexical"]["returned"] > 0]

    def paired(a: str, b: str, entries: list[dict]) -> dict:
        diffs = [
            (e[b]["ndcg10"] or 0) - (e[a]["ndcg10"] or 0)
            for e in entries
            if e[a]["ndcg10"] is not None
        ]
        wins = sum(1 for d in diffs if d > 1e-9)
        losses = sum(1 for d in diffs if d < -1e-9)
        return {
            "compare": f"{b} - {a}",
            "mean_diff_ndcg10": round(sum(diffs) / len(diffs), 4),
            "ci95": boot(diffs),
            "wins": wins,
            "losses": losses,
            "ties": len(diffs) - wins - losses,
        }

    by_group: dict[str, list[dict]] = defaultdict(list)
    for e in judged:
        by_group[e["group"].split("/")[0]].append(e)

    report = {
        "score_column": col,
        "label_status": "AI destekli on degerlendirme; bagimsiz insan dogrulamasi YOK",
        "label_distribution": dict(Counter(s for _, s, _ in labels.values())),
        "confidence_distribution": dict(conf),
        "items": len(labels),
        "queries": len(per_query),
        "all_judged": agg(judged),
        "lexical_nonempty_only": agg(lex_nonempty),
        "absent_in_pool": {
            "queries": [(e["id"], e["query"]) for e in absent],
            "zeros_in_top10": {
                m: [e[m]["zeros_in_top10"] for e in absent] for m in METHODS
            },
        },
        "paired": [
            paired("lexical", "dense", judged),
            paired("lexical", "hybrid", judged),
            paired("dense", "hybrid", judged),
            {
                **paired("lexical", "hybrid", lex_nonempty),
                "subset": "lexical bos olmayan",
            },
            {
                **paired("lexical", "dense", lex_nonempty),
                "subset": "lexical bos olmayan",
            },
        ],
        "by_group": {g: agg(es) for g, es in sorted(by_group.items())},
        "per_query": per_query,
    }
    out_path.write_text(
        json.dumps(report, indent=1, ensure_ascii=False), encoding="utf-8"
    )
    print(
        json.dumps(
            {k: v for k, v in report.items() if k not in {"per_query", "by_group"}},
            indent=1,
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
