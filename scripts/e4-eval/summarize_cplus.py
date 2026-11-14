"""E4b C+ sonuc ozeti: dogrulayici, etiketli (AI) metrikler, etiketsiz gostergeler, urun dili."""

import collections
import json
import random
import statistics as st
import sys

R = json.load(open(sys.argv[1], encoding="utf-8"))
HB_TARGETED = {
    "T01",
    "T02",
    "T03",
    "T04",
    "T05",
    "T06",
    "T07",
    "D31",
    "D32",
    "D33",
    "D34",
    "E21",
    "E22",
    "E23",
    "X11",
}


def lang(r):
    return r["lang"]


print("== DOGRULAYICI (yazim basina) kaynak dil x hedef dil: kabul/toplam")
acc = collections.defaultdict(lambda: [0, 0])
reasons = collections.Counter()
cos = collections.defaultdict(list)
for r in R:
    for tl, v in r["verdicts"].items():
        k = (lang(r), tl)
        acc[k][1] += 1
        acc[k][0] += v["accepted"]
        if not v["accepted"]:
            reasons[(lang(r), tl, v["reason"])] += 1
        if v["cosine"] is not None:
            cos[k].append(v["cosine"])
for k, (a, t) in sorted(acc.items()):
    print(f"  {k}: {a}/{t}  kosinus ort {st.mean(cos[k]):.3f} min {min(cos[k]):.3f}")
print("  red nedenleri:", dict(reasons))
print("  yazimsiz sorgu:", [r["id"] for r in R if not r["verdicts"]])
print()
print("== ETIKETLI (AI on degerlendirme) gorulen TR sorgulari")
lab = [r for r in R if r["group"] == "tr/gorulen" and r["A"]["m"]["ndcg"] is not None]
for m in "ABCD":
    print(
        f"  {m}: n={len(lab)} nDCG {st.mean(r[m]['m']['ndcg'] for r in lab):.3f} "
        f"P10 {st.mean(r[m]['m']['p10'] for r in lab):.3f} MRR {st.mean(r[m]['m']['mrr'] for r in lab):.3f} "
        f"puanlanmamis {sum(r[m]['m']['unjudged'] for r in lab)}"
    )


def boot(d, n=10000):
    rng = random.Random(7)
    s = sorted(sum(rng.choice(d) for _ in d) / len(d) for _ in range(n))
    return round(s[250], 3), round(s[9750], 3)


for a, b in (("A", "D"), ("A", "B"), ("A", "C")):
    d = [r[b]["m"]["ndcg"] - r[a]["m"]["ndcg"] for r in lab]
    print(
        f"  {b}-{a}: {st.mean(d):+.3f} GA{boot(d)} kazan/kayip {sum(x > 1e-9 for x in d)}/{sum(x < -1e-9 for x in d)}"
    )
print(
    "  A -> D degisen:",
    [
        (
            r["id"],
            round(r["A"]["m"]["ndcg"], 2),
            round(r["D"]["m"]["ndcg"], 2),
            r["D"]["m"]["unjudged"],
        )
        for r in lab
        if abs(r["D"]["m"]["ndcg"] - r["A"]["m"]["ndcg"]) > 0.05
    ],
)
print()
print("== ETIKETSIZ GOSTERGELER (olumsuzluk ihlali | teknik | tur | aksesuar | bos)")
for lg in ("tr", "de", "en", "mul"):
    G = [r for r in R if lang(r) == lg]
    for m in "ABCD":
        ms = [r[m]["m"] for r in G]

        def f(k):
            return sum(x[k] for x in ms if x[k] is not None)

        def n(k):
            return sum(x["shown"] for x in ms if x[k] is not None)

        print(
            f"  {lg} {m}: olumsuzluk {f('negationViolations')} | teknik {f('specMismatch')}/{n('specMismatch')} | "
            f"tur {f('typeMismatch')}/{n('typeMismatch')} | aksesuar {f('accessory')}/{n('accessory')} | "
            f"bos {sum(1 for x in ms if x['shown'] == 0)}"
        )
print()
print("== TURKCE BASLIKLI URUNE ULASMA (ilk 10'da Hepsiburada urunu)")
for r in R:
    if r["id"] in HB_TARGETED:
        print(
            f"  {r['id']} {r['query'][:34]:34s} [{r['lang']}] A {r['A']['m']['trTitleHits']} "
            f"B {r['B']['m']['trTitleHits']} C {r['C']['m']['trTitleHits']} D {r['D']['m']['trTitleHits']}"
        )
print()
print("== SONUC URUN DILI (D, ilk 10; baslik dili ipucu)")
mat = collections.defaultdict(collections.Counter)
for r in R:
    for lg in r["D"]["m"]["resultLanguages"]:
        mat[lang(r)][lg] += 1
for k, v in mat.items():
    print(" ", k, dict(v))
