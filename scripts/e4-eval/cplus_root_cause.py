"""E4b C+ kok neden ayrimi (yalniz gozlem; AI puanlari on degerlendirmedir).

Etiketli sorgularda A (mevcut hybrid) ile D (C+ v2) arasindaki farki asamalara ayirir:
  - A'nin ilk 10'undaki ilgili (puan >= 2) urun D'nin ADAY HAVUZUNDA var mi (aday bulma)?
  - Havuzdaysa D ilk 10'a aliyor mu (siralama/birlestirme)?
  - D'nin ilk 10'unda puanlanmamis urun sayisi (etiket eksigi).
  - Sorgu icin hic ilgili urun etiketi yoksa: katalogda bulunmuyor olabilir (dogrulanmamis).

  python cplus_root_cause.py <eval.json> <cache.json> <puanlar.csv> <anahtar.csv>
"""

import csv
import json
import sys

ev = json.load(open(sys.argv[1], encoding="utf-8"))
cache = {q["id"]: q for q in json.load(open(sys.argv[2], encoding="utf-8"))["queries"]}
scores = {r["item_id"]: int(r["oneri_puan_0_3"]) for r in csv.DictReader(open(sys.argv[3], encoding="utf-8-sig"))}
labels = {}
for r in csv.DictReader(open(sys.argv[4], encoding="utf-8-sig")):
    if r["item_id"] in scores:
        labels[(r["query_id"], int(r["product_id"]))] = scores[r["item_id"]]

for r in ev:
    if r["group"] != "tr/gorulen" or r["A"]["m"]["ndcg"] is None:
        continue
    q = r["id"]
    orig = cache[f"O:{q}"]
    acc = [lang for lang, v in r["verdicts"].items() if v["accepted"]]
    rw = [cache[f"R:{q}:{lang}"] for lang in acc if f"R:{q}:{lang}" in cache]
    raw_lex = [x["productId"] for x in orig["lexical"]]
    rw_lex = [x["productId"] for s in rw for x in s["lexical"]]
    pool = set(raw_lex) | set(rw_lex) | {c["productId"] for s in [orig, *rw] for c in s["candidates"]}
    A, D = r["A"]["ids"], r["D"]["ids"]
    rel_A = [p for p in A if labels.get((q, p), 0) >= 2]
    lost = [p for p in rel_A if p not in D]
    lost_pool = [p for p in lost if p not in pool]
    lost_rank = [p for p in lost if p in pool]
    lost_raw_lex = [p for p in lost_rank if p in raw_lex]
    any_rel = any(v >= 2 for (qq, _), v in labels.items() if qq == q)
    d_unj = sum(1 for p in D if (q, p) not in labels)
    d_new_rel = [p for p in D if p not in A and labels.get((q, p), 0) >= 2]
    print(
        f"{q} {r['query'][:30]:30s} A {r['A']['m']['ndcg']:.2f} D {r['D']['m']['ndcg']:.2f} | "
        f"A ilgili {len(rel_A)} kayip {len(lost)} (havuz disi {len(lost_pool)}, siralama {len(lost_rank)}, "
        f"ham-lexical {len(lost_raw_lex)}) | D yeni ilgili {len(d_new_rel)} | D puansiz {d_unj} | "
        f"etikette ilgili var {any_rel} | yazim {[(lang, r['verdicts'][lang]['text']) for lang in acc]}"
    )
