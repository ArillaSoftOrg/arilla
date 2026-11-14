"""E4b C+ v3 ozeti. AI puanlari on degerlendirmedir; puanlanmamis urun 0 sayilmaz (yogun metrik).

  python summarize_cplus_v3.py <eval-v3.json> <hybrid-tune.json>
"""

import collections
import json
import random
import statistics as st
import sys

R = json.load(open(sys.argv[1], encoding="utf-8"))
split = json.load(open(sys.argv[2], encoding="utf-8"))["split"]
M = ["A", "B", "C", "D", "Dw", "D0", "Dm"]
NAMES = {
    "A": "mevcut hybrid",
    "B": "C+ v2",
    "C": "C+ v2 + yeni dogrulayici",
    "D": "ham korumali kosullu genisletme",
    "Dw": "D, ham benzerlik penceresiz",
    "D0": "yalniz aday genisletme",
    "Dm": "aday genisletme, max benzerlik",
}


def boot(d, n=10000):
    rng = random.Random(7)
    s = sorted(sum(rng.choice(d) for _ in d) / len(d) for _ in range(n))
    return round(s[250], 3), round(s[9750], 3)


def mean(xs):
    xs = [x for x in xs if x is not None]
    return st.mean(xs) if xs else float("nan")


print("== DOGRULAYICI kabul/ret (yazim basina)")
for ver in ("v2", "v3", "v3nocos"):
    c = collections.Counter()
    for r in R:
        for v in r[ver].values():
            c[v["reason"] or "kabul"] += 1
    print(f"  {ver}: {dict(c)}")
print("  v3 sorgu basina en az bir kabul:", sum(1 for r in R if any(v["accepted"] for v in r["v3"].values())), "/", len(R))
print()

lab = [r for r in R if r["A"]["m"]["ndcgC"] is not None]
for name, sub in (
    ("ETIKETLI (21; AI puan)", lab),
    ("  gelistirme kumesi (parametre seciminde kullanildi)", [r for r in lab if r["id"] in split["dev"]]),
    ("  dogrulama kumesi (E4 seciminde kullanilmadi; C+ ayarinda goruldu)", [r for r in lab if r["id"] in split["holdout"]]),
):
    print(f"== {name} n={len(sub)}")
    for m in M:
        ms = [r[m]["m"] for r in sub]
        print(
            f"  {m:2s} {NAMES[m]:32s} nDCG(yogun) {mean(x['ndcgC'] for x in ms):.3f} P10(yogun) {mean(x['p10C'] for x in ms):.3f} "
            f"MRR(yogun) {mean(x['mrrC'] for x in ms):.3f} | nDCG(alt sinir) {mean(x['ndcgLow'] for x in ms):.3f} | "
            f"puanli {sum(x['judged'] for x in ms)}/{sum(x['shown'] for x in ms)} | kayip ilgili {sum(x['lostRelevant'] for x in ms)}"
        )
    for m in M[1:]:
        d = [r[m]["m"]["ndcgC"] - r["A"]["m"]["ndcgC"] for r in sub]
        print(
            f"  {m}-A yogun nDCG {st.mean(d):+.3f} GA{boot(d)} kazan/kayip {sum(x > 1e-9 for x in d)}/{sum(x < -1e-9 for x in d)}"
        )
    print()

print("== ADAY BULMA (etiketli; ilgili etiketli urunlerin havuzda olmasi)")
rel = sum(r["poolRecall"]["relevant"] for r in lab)
print(
    f"  ilgili {rel} | ham havuz {sum(r['poolRecall']['raw'] for r in lab)} | genisletilmis havuz {sum(r['poolRecall']['expanded'] for r in lab)}"
)
print()

print("== BUTUN SORGULAR (etiketsiz gostergeler; ilk 10)")
for lg in ("tr", "de", "en", "mul"):
    G = [r for r in R if r["lang"] == lg]
    print(f"  [{lg}] n={len(G)} A lexical_strong {sum(r['modeA'] == 'lexical_strong' for r in G)} | D ekleme yapti {sum(r['expandedUsed']['D'] for r in G)} (eklenen {sum(r['added']['D'] for r in G)}; penceresiz {sum(r['added']['Dw'] for r in G)})")
    for m in M:
        ms = [r[m]["m"] for r in G]

        def f(k):
            return sum(x[k] for x in ms if x[k] is not None)

        def n(k):
            return sum(x["shown"] for x in ms if x[k] is not None)

        print(
            f"    {m:2s} olumsuzluk {f('negationViolations')} | teknik {f('specMismatch')}/{n('specMismatch')} | tur {f('typeMismatch')}/{n('typeMismatch')} | "
            f"aksesuar {f('accessory')}/{n('accessory')} | A'nin exact lexical'i kayip {f('lostLexExact')} | ilk3 degisen {f('top3Changed')} | "
            f"Jaccard(A) {mean(x['jaccardA'] for x in ms):.2f} | TR baslik {f('trTitleHits')} | bos {sum(1 for x in ms if x['shown'] == 0)}"
        )
print()
HB = ["T01", "T02", "T03", "T04", "T05", "T06", "T07", "D31", "D32", "D33", "D34", "E21", "E22", "E23", "X11"]
print("== TURKCE BASLIKLI URUNE ULASMA (ilk 10'da HB urunu)")
for r in R:
    if r["id"] in HB:
        print(f"  {r['id']} {r['query'][:34]:34s} [{r['lang']}] " + " ".join(f"{m} {r[m]['m']['trTitleHits']}" for m in M))
print()
print("== ETIKETLI SORGU BASINA (yogun nDCG)")
for r in lab:
    print(f"  {r['id']} {r['query'][:30]:30s} mod {r['modeA']:15s} " + " ".join(f"{m} {r[m]['m']['ndcgC']:.2f}({r[m]['m']['judged']})" for m in M))
