"""Aday puanlama ve cesitlilikli secim (saf fonksiyonlar, karar 0077).

Ayni girdi her zaman ayni siralamayi verir (rastgelelik yok). Komisyon orani
HICBIR yerde sinyal degildir (CLAUDE.md: komisyon siralamayi belirlemez).
"""

from __future__ import annotations

import math
from collections import Counter
from dataclasses import dataclass, field

from curate.text import count_matches, fold, jaccard, matches, signature

#: Bir trendde gosterilecek en cok urun / altinda "az" sayilan sinir.
TARGET_PRODUCTS = 24
LOW_MATCH_THRESHOLD = 12
#: `packages/core` `MIN_PUBLIC_TREND_PRODUCTS` ile AYNI (testle sabitlenir).
MIN_PUBLIC_PRODUCTS = 4

MAX_PER_BRAND = 3
#: Feed'lerde "marka yok" yerine yazilan degerler: marka sayilmaz.
PLACEHOLDER_BRANDS = frozenset({"diger", "other", "-", "markasiz", "unbranded"})
#: Tek magazanin / tek alt kategorinin hedefteki payi.
MAX_MERCHANT_SHARE = 0.5
MAX_CATEGORY_SHARE = 0.5
#: Bu benzerlikten sonrasi ayni urunun varyanti sayilir ve elenir.
NEAR_DUPLICATE_JACCARD = 0.75

CORE_WEIGHT = 3.0
CORE_CAP = 2
BOOST_WEIGHT = 1.0
BOOST_CAP = 3
MULTI_OFFER_BONUS = 0.5


@dataclass(frozen=True)
class Profile:
    """Bir trendin anlamsal secim profili.

    `core`: en az biri ZORUNLU (yoksa urun aday degildir).
    `boost`: ek sinyal. `exclude`: biri varsa urun elenir.
    `categories`: izinli `category.path` onekleri (bos = hepsi).
    `price_max`: kurus; urun `min_price`i bunu asamaz.
    `min_boost`: en az bu kadar boost terimi eslesmeli.
    `min_score`: puan tabani. `note`: bos profillerin gerekcesi.
    """

    slug: str
    core: tuple[str, ...] = ()
    boost: tuple[str, ...] = ()
    exclude: tuple[str, ...] = ()
    categories: tuple[str, ...] = ()
    price_max: int | None = None
    min_boost: int = 0
    min_score: float = 0.0
    target: int = TARGET_PRODUCTS
    note: str = ""


@dataclass(frozen=True)
class Candidate:
    product_id: int
    title: str
    brand: str | None
    category_path: str | None
    merchant: str
    min_price: int
    offer_count: int


@dataclass
class Scored:
    candidate: Candidate
    score: float
    sig: frozenset[str] = field(default_factory=frozenset)


def category_allowed(profile: Profile, path: str | None) -> bool:
    if not profile.categories:
        return True
    if not path:
        return False
    return any(path == c or path.startswith(c + "/") for c in profile.categories)


def score_candidate(profile: Profile, candidate: Candidate) -> Scored | None:
    """Aday degilse `None`; degilse puanli sonuc."""
    if not profile.core:
        return None
    if not category_allowed(profile, candidate.category_path):
        return None
    if profile.price_max is not None and candidate.min_price > profile.price_max:
        return None

    text = fold(candidate.title + " " + (candidate.brand or ""))
    if profile.exclude and any(matches(term, text) for term in profile.exclude):
        return None

    core_hits = count_matches(profile.core, text)
    if core_hits == 0:
        return None
    boost_hits = count_matches(profile.boost, text)
    if boost_hits < profile.min_boost:
        return None

    score = (
        CORE_WEIGHT * min(core_hits, CORE_CAP)
        + BOOST_WEIGHT * min(boost_hits, BOOST_CAP)
        + (MULTI_OFFER_BONUS if candidate.offer_count > 1 else 0.0)
    )
    if score < profile.min_score:
        return None
    return Scored(candidate, score, signature(candidate.title))


def select_diverse(profile: Profile, scored: list[Scored]) -> list[Scored]:
    """Puana gore sirali, cesitlilik kisitli secim.

    Kisitlar: marka basina en cok `MAX_PER_BRAND`, magaza ve alt kategori basina
    hedefin `MAX_*_SHARE` payi, yakin-kopya (varyant) elenir. Kisitlar
    doldurmak icin GEVSETILMEZ: yeterli cesitli urun yoksa az urun doner.
    """
    target = profile.target
    merchant_cap = max(4, math.ceil(target * MAX_MERCHANT_SHARE))
    category_cap = max(4, math.ceil(target * MAX_CATEGORY_SHARE))

    ordered = sorted(
        scored,
        key=lambda s: (-s.score, -s.candidate.offer_count, s.candidate.product_id),
    )
    brands: Counter[str] = Counter()
    merchants: Counter[str] = Counter()
    categories: Counter[str] = Counter()
    picked: list[Scored] = []

    for item in ordered:
        if len(picked) >= target:
            break
        c = item.candidate
        brand_key = fold(c.brand) if c.brand and fold(c.brand) not in PLACEHOLDER_BRANDS else None
        if brand_key and brands[brand_key] >= MAX_PER_BRAND:
            continue
        if merchants[c.merchant] >= merchant_cap:
            continue
        # Yalniz ALT kategori ("moda/ayakkabi") cesitlilik sayilir; tek parca kok
        # kategori ("ev-yasam") tum urunleri kapsar, sinir koymak anlamsiz olur.
        cat_key = c.category_path if c.category_path and "/" in c.category_path else None
        if cat_key and categories[cat_key] >= category_cap:
            continue
        if any(jaccard(item.sig, other.sig) >= NEAR_DUPLICATE_JACCARD for other in picked):
            continue
        picked.append(item)
        if brand_key:
            brands[brand_key] += 1
        merchants[c.merchant] += 1
        if cat_key:
            categories[cat_key] += 1
    return picked
