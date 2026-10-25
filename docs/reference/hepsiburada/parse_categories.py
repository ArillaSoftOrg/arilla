"""Hepsiburada kategori sitemap'ini ayristirir (arastirma araci; veritabanina yazmaz).

    python -I parse_categories.py <raw.xml> <trendyol parsed.json> <out dir>

Uretir: categories.parsed.json, trendyol-name-matches.json. URL'de YALNIZCA slug ve id vardir;
ad slug'tan turetilir (Turkce karakter geri getirilmez), HIYERARSI YOKTUR ve uretilmez.
"""

import collections
import hashlib
import json
import re
import sys
import xml.etree.ElementTree as ET

NS = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
PAT = re.compile(r"^https://www\.hepsiburada\.com/([A-Za-z0-9-]+)-c-(\d+)$")
BROKEN = re.compile(r"^https://www\.hepsiburada\.com/https://www\.hepsiburada\.com/([A-Za-z0-9-]+)-c-(\d+)-c-(\d+)$")
SENTINEL_FROM = 2_147_000_000  # INT_MAX'in hemen alti: yer tutucu / eski ust kategori kimlikleri


def fold(text: str) -> str:
    text = text.replace("İ", "i").replace("I", "ı").lower()
    for src, dst in zip("ıöüşçğ", "iouscg"):
        text = text.replace(src, dst)
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def norm(text: str) -> str:
    return " ".join(w for w in fold(text).split() if w != "ve")


def main(raw_path: str, trendyol_path: str, out_dir: str) -> None:
    raw = open(raw_path, "rb").read()
    root = ET.fromstring(raw.decode("utf-8-sig"))
    urls = [u.find("s:loc", NS).text.strip() for u in root.findall("s:url", NS)]
    rows, bad = [], []
    for url in urls:
        m = PAT.match(url)
        anomaly = None
        if not m:
            m = BROKEN.match(url)
            # Yalniz iki -c-<id> parcasi AYNI ise kurtarilir (URL'de acik; tahmin degil).
            if m and m.group(2) == m.group(3):
                anomaly = "doubled_host_and_id_suffix"
            else:
                m = None
        if not m:
            bad.append(url)
            continue
        slug, cid = m.group(1), int(m.group(2))
        rows.append(
            {
                "id": cid,
                "slug": slug,
                "url": url,
                "name": slug.replace("-", " "),
                "nameBasis": "slug",
                "urlAnomaly": anomaly,
                "slugCaseAnomaly": slug != slug.lower(),
                "placeholderId": cid == 0 or cid >= SENTINEL_FROM,
            }
        )
    if bad:
        raise SystemExit(f"ayristirilamayan URL: {bad[:5]}")
    ids = collections.Counter(r["id"] for r in rows)
    slugs = collections.Counter(r["slug"] for r in rows)
    for r in rows:
        r["sameSlugOtherIds"] = sorted(x["id"] for x in rows if x["slug"] == r["slug"] and x["id"] != r["id"]) if slugs[r["slug"]] > 1 else []
    sha = hashlib.sha256(raw).hexdigest()
    stats = {
        "urlCount": len(urls),
        "uniqueIds": len(ids),
        "duplicateIds": sum(1 for v in ids.values() if v > 1),
        "duplicateUrls": len(urls) - len(set(urls)),
        "uniqueSlugs": len(slugs),
        "slugsSharedByMultipleIds": sum(1 for v in slugs.values() if v > 1),
        "malformedUrls": sum(r["urlAnomaly"] is not None for r in rows),
        "slugCaseAnomalies": sum(r["slugCaseAnomaly"] for r in rows),
        "placeholderIds": sum(r["placeholderId"] for r in rows),
        "hierarchy": "none (URL has only slug and id)",
    }
    head = json.dumps({"source": "hepsiburada", "kind": "category-sitemap", "sourceSha256": sha, "stats": stats}, ensure_ascii=False)
    body = ",\n".join("    " + json.dumps(r, ensure_ascii=False, separators=(",", ":")) for r in rows)
    with open(f"{out_dir}/categories.parsed.json", "w", encoding="utf-8", newline="\n") as f:
        f.write(f"{head[:-1]},\"categories\":[\n{body}\n  ]}}\n")

    ty = json.load(open(trendyol_path, encoding="utf-8"))["categories"]
    tmap = collections.defaultdict(list)
    for n in ty:
        tmap[norm(n["name"])].append(n["id"])
    pairs = [{"hbId": r["id"], "hbSlug": r["slug"], "trendyolIds": tmap[norm(r["slug"])]} for r in rows if norm(r["slug"]) in tmap]
    summary = {
        "method": "ASCII-katlanmis ad esitligi ('ve' atilir); ADAY eslesme, dogrulanmis degil",
        "hbMatched": len(pairs),
        "trendyolMatchedDistinct": len({t for p in pairs for t in p["trendyolIds"]}),
        "trendyolSha256": hashlib.sha256(open(trendyol_path, "rb").read()).hexdigest(),
    }
    lines = ",\n".join("    " + json.dumps(p, ensure_ascii=False, separators=(",", ":")) for p in pairs)
    with open(f"{out_dir}/trendyol-name-matches.json", "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps({"summary": summary}, ensure_ascii=False)[:-1] + f",\"pairs\":[\n{lines}\n  ]}}\n")
    print(json.dumps(stats, ensure_ascii=False, indent=1))
    print(summary)


main(*sys.argv[1:4])
