"""Siniflandirma dogrulugunun OLCUMU (karar 0139). SAF; veritabani yok, model yok.

Dogruluk yalnizca ETIKETLENMIS urunlerde olculur. Etiketlenmemis satirlar hicbir orana girmez
(precision/yanlis orani iddia edilmez); sadece kapsama (otomatik yazilan pay) etiketsiz de
hesaplanabilir ve bu ayri raporlanir.

Girdi: `classify sample` ciktisi TSV (ya da ayni sutunlu dosya). Etiketleyen kisi sunlari doldurur:
- `expected_category`: dogru yaprak yol; `-` = agacta uygun kategori yok (urun incelemede kalmali);
  bos = etiketlenmemis.
- `expected_brand`: dogru urun markasi; `-` = markasiz (ya da yalniz uyumlu marka); bos = etiketsiz.
- `label_source`: `human` (insan dogrulamali) ya da `model` (model atadi, insan dogrulamasi YOK).
  Iki kaynak ASLA birlestirilmez: `score_by_label_source` her biri icin ayri metrik uretir; bos
  deger `unspecified` sayilir ve insan etiketi gibi okunmaz.
Her oran Wilson %95 guven araligiyla birlikte verilir (`ci`); kucuk orneklemde aralik genistir.

Karar ayni girdiyle (baslik + kaynak kategori yolu, kaynak onerisi `guess_source`) KOSAN KODLA
yeniden hesaplanir; boylece ayni etiketli veride iki surum (v2/v3) karsilastirilir: her surumun
kod agaciyla `python -m classify evaluate` calistirilir ve JSON ciktilari `compare` ile kiyaslanir.

Dogruluk siniflari (kategori, yalnizca otomatik yazilan kararlar):
- exact: yazilan yol = beklenen yol
- coarse: yazilan yol beklenenin ATASI (yanlis degil, daha genel)
- wrong: baska hicbir sey
Inceleme (review) kararlari: beklenen gercek bir kategoriyse `missed` (kapsama kaybi),
beklenen `-` ise `correct_review`.
"""

from __future__ import annotations

import csv
import json
import zlib
from collections import Counter, defaultdict
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from pathlib import Path

from classify.categories import guess_source, is_within, source_gender
from classify.decide import Decision, ProductFacts, SourceVerdict, decide
from classify.taxonomy import ACCESSORY_PREFIXES, all_paths

NONE_LABEL = "-"
#: Aksesuar/yedek parca dallari (ana urun/aksesuar karisikligi olcusu).
ACCESSORY_PATHS = (
    *ACCESSORY_PREFIXES,
    "ev-yasam/yapi-market/alet-yedek-parca",
    "anne-bebek/bebek-arabasi/aksesuar",
)

TSV_FIELDS = (
    "product_id",
    "title",
    "source_category",
    "expected_category",
    "expected_brand",
    "label_source",
)
LABEL_SOURCES = ("human", "model", "unspecified")


@dataclass(frozen=True)
class LabeledRow:
    product_id: str
    title: str
    source_category: str
    expected_category: str | None  # None = etiketsiz
    expected_brand: str | None  # None = etiketsiz; NONE_LABEL = markasiz
    label_source: str = "unspecified"  # 'human' | 'model' | 'unspecified'


@dataclass
class Metrics:
    n_rows: int = 0
    n_category_labeled: int = 0
    n_brand_labeled: int = 0
    #: etiketsiz dahil tum satirlarda otomatik yazilan pay
    coverage_all: float = 0.0
    applied_labeled: int = 0
    exact: int = 0
    coarse: int = 0
    wrong: int = 0
    review_labeled: int = 0
    missed: int = 0
    correct_review: int = 0
    precision_strict: float | None = None
    precision_lenient: float | None = None
    wrong_rate: float | None = None
    review_rate: float | None = None
    #: yazilabilecek kategorisi olan etiketli urunlerin ne kadari dogru yazildi
    recall_strict: float | None = None
    accessory_confusion: int = 0
    brand_predicted: int = 0
    brand_correct: int = 0
    brand_wrong: int = 0
    brand_expected: int = 0
    brand_precision: float | None = None
    brand_recall: float | None = None
    brand_empty_reasons: dict[str, int] = field(default_factory=dict)
    failures_by_source: dict[str, dict[str, int]] = field(default_factory=dict)
    #: Wilson %95 guven araligi: {metrik: [alt, ust]}; payda 0 ise yok.
    ci: dict[str, list[float]] = field(default_factory=dict)


def wilson(successes: int, n: int, z: float = 1.96) -> tuple[float, float] | None:
    """Binom orani icin Wilson %95 araligi; n = 0 ise None."""
    if n <= 0:
        return None
    p = successes / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * ((p * (1 - p) / n + z * z / (4 * n * n)) ** 0.5) / denom
    return (round(max(0.0, centre - half), 4), round(min(1.0, centre + half), 4))


def read_labels(path: Path) -> list[LabeledRow]:
    rows: list[LabeledRow] = []
    with path.open(encoding="utf-8", newline="") as handle:
        for rec in csv.DictReader(handle, delimiter="\t", quoting=csv.QUOTE_NONE):
            cat = (rec.get("expected_category") or "").strip()
            brand = (rec.get("expected_brand") or "").strip()
            rows.append(
                LabeledRow(
                    product_id=str(rec.get("product_id", "")),
                    title=str(rec.get("title", "")),
                    source_category=str(rec.get("source_category", "")),
                    expected_category=cat or None,
                    expected_brand=brand or None,
                    label_source=(rec.get("label_source") or "unspecified").strip().lower(),
                )
            )
    return rows


def verdict_for(source_category: str) -> SourceVerdict | None:
    """Kaynak onerisi, `Catalog.source_verdict` ile ayni (yonetici onayi bu olcumde yoktur)."""
    if not source_category:
        return None
    guess = guess_source(source_category)
    path = guess.path
    return SourceVerdict(
        path,
        guess.confidence if path else 0,
        "suggested" if path else "unmapped",
        source_gender(source_category),
    )


def decide_row(row: LabeledRow, cache: dict[str, SourceVerdict | None] | None = None) -> Decision:
    cache = cache if cache is not None else {}
    if row.source_category not in cache:
        cache[row.source_category] = verdict_for(row.source_category)
    return decide(
        ProductFacts(
            title=row.title,
            kept_brand=False,
            kept_category_path=None,
            brand_raw=None,
            merchant_name=None,
            source=cache[row.source_category],
        )
    )


def _is_accessory(path: str | None) -> bool:
    return path is not None and any(is_within(path, p) for p in ACCESSORY_PATHS)


def _same_family(a: str, b: str) -> bool:
    return a.split("/")[:2] == b.split("/")[:2]


def _ratio(num: int, den: int) -> float | None:
    return None if den == 0 else round(num / den, 4)


def score(
    rows: Sequence[LabeledRow],
    decider: Callable[[LabeledRow], Decision] | None = None,
) -> Metrics:
    cache: dict[str, SourceVerdict | None] = {}
    decide_fn = decider or (lambda r: decide_row(r, cache))
    known = all_paths()
    m = Metrics(n_rows=len(rows))
    applied_all = 0
    reasons: Counter[str] = Counter()
    fails: dict[str, Counter[str]] = defaultdict(Counter)
    for row in rows:
        d = decide_fn(row)
        applied = d.state == "applied" and d.category_path is not None
        applied_all += applied
        # --- kategori
        if row.expected_category is not None:
            m.n_category_labeled += 1
            exp = row.expected_category
            if exp != NONE_LABEL and exp not in known:
                raise ValueError(f"beklenen yol agacta yok: {exp!r} (urun {row.product_id})")
            if applied:
                m.applied_labeled += 1
                got = d.category_path
                assert got is not None
                if exp == NONE_LABEL:
                    m.wrong += 1
                    fails[row.source_category]["wrong"] += 1
                elif got == exp:
                    m.exact += 1
                elif is_within(exp, got):
                    m.coarse += 1
                else:
                    m.wrong += 1
                    fails[row.source_category]["wrong"] += 1
                    if _same_family(got, exp) and _is_accessory(got) != _is_accessory(exp):
                        m.accessory_confusion += 1
            else:
                m.review_labeled += 1
                if exp == NONE_LABEL:
                    m.correct_review += 1
                else:
                    m.missed += 1
                    fails[row.source_category]["missed"] += 1
        # --- marka
        if row.expected_brand is not None:
            m.n_brand_labeled += 1
            want = None if row.expected_brand == NONE_LABEL else row.expected_brand.lower()
            got_brand = (d.brand_name or "").lower() or None
            if want is not None:
                m.brand_expected += 1
            if got_brand is not None:
                m.brand_predicted += 1
                if got_brand == want:
                    m.brand_correct += 1
                else:
                    m.brand_wrong += 1
        if d.brand_name is None and d.brand_basis != "existing":
            reasons[d.brand_reason or "unknown"] += 1
    m.coverage_all = round(applied_all / len(rows), 4) if rows else 0.0
    m.precision_strict = _ratio(m.exact, m.applied_labeled)
    m.precision_lenient = _ratio(m.exact + m.coarse, m.applied_labeled)
    m.wrong_rate = _ratio(m.wrong, m.applied_labeled)
    m.review_rate = _ratio(m.review_labeled, m.n_category_labeled)
    assignable = m.exact + m.coarse + m.wrong + m.missed
    m.recall_strict = _ratio(m.exact, assignable)
    m.brand_precision = _ratio(m.brand_correct, m.brand_predicted)
    m.brand_recall = _ratio(m.brand_correct, m.brand_expected)
    m.brand_empty_reasons = dict(reasons.most_common())
    m.failures_by_source = {k: dict(v) for k, v in sorted(fails.items())}
    for name, (k, n) in {
        "precision_strict": (m.exact, m.applied_labeled),
        "precision_lenient": (m.exact + m.coarse, m.applied_labeled),
        "wrong_rate": (m.wrong, m.applied_labeled),
        "review_rate": (m.review_labeled, m.n_category_labeled),
        "recall_strict": (m.exact, assignable),
        "brand_precision": (m.brand_correct, m.brand_predicted),
        "brand_recall": (m.brand_correct, m.brand_expected),
    }.items():
        interval = wilson(k, n)
        if interval is not None:
            m.ci[name] = list(interval)
    return m


def score_by_label_source(
    rows: Sequence[LabeledRow],
    decider: Callable[[LabeledRow], Decision] | None = None,
) -> dict[str, Metrics]:
    """Etiket kaynagina gore AYRI metrik (human / model / unspecified); asla birlestirilmez."""
    groups: dict[str, list[LabeledRow]] = defaultdict(list)
    for row in rows:
        groups[row.label_source if row.label_source in LABEL_SOURCES else "unspecified"].append(row)
    return {name: score(group, decider) for name, group in sorted(groups.items())}


def split_of(product_id: str, dev_percent: int = 50) -> str:
    """Kararli dev/eval ayrimi (kimligin crc32'si): kural gelistirirken yalniz 'dev' okunur."""
    return "dev" if zlib.crc32(product_id.encode("utf-8")) % 100 < dev_percent else "eval"


def stratified_sample[T](
    records: Iterable[T],
    key: Callable[[T], str],
    per_stratum: int,
    seed: int,
) -> list[T]:
    """Her kaynak kategori kovasindan en fazla `per_stratum` kayit; ayni tohum ayni sonuc."""
    import random

    buckets: dict[str, list[T]] = defaultdict(list)
    for rec in records:
        buckets[key(rec)].append(rec)
    rng = random.Random(seed)
    out: list[T] = []
    for name in sorted(buckets):
        items = buckets[name]
        out.extend(rng.sample(items, min(per_stratum, len(items))))
    return out


def compare(old: dict, new: dict) -> dict[str, tuple[object, object]]:
    """Iki `Metrics` sozlugunun sayisal alanlari: {alan: (eski, yeni)}."""
    return {
        k: (old.get(k), new.get(k))
        for k in new
        if isinstance(new[k], (int, float)) and not isinstance(new[k], bool)
    }


def dump(metrics: Metrics) -> str:
    return json.dumps(metrics.__dict__, ensure_ascii=False, indent=2, sort_keys=True)
