"""Platformlar arasi saf urun kumeleme (karar 0164).

Girdi: bircok platform/saticidan `CanonicalListing`. Cikti: urun kumeleri.
Veritabani, ag, saat YOK; ayni girdi (sirasi ne olursa olsun) ayni kumeleri verir.

Politika (karar 0111): belirsizlik => ayri tut ya da `hold`. Baslik/gorsel/model ipucu
benzerligi ASLA birlestirmez; yalnizca `candidate_pairs` ile aday uretir.

Kimlik katmanlari:

1. **Teklif**: (platform, listing_id, seller_id). Ayni (platform, listing_id) farkli
   saticilarla AYNI ilandir; tek "unit" olur, uye olarak tum teklif anahtarlarini tasir.
2. **GTIN**: gecerli ve kisitli olmayan GTIN => varyant kumesi. Marka/kategori kok/varyant
   ekseni celiskisi varsa grup `hold` olur ve uyeler birlestirilmez (her unit ayri kume).
   GTIN-14 paket duzeyi (gosterge 1-8) 14 haneli degeri farkli oldugundan tekli urunle
   birlesmez.
3. **Marka + MPN**: GTIN'i olmayan unit'ler icin model duzeyi kume; farkli secenekler
   kumenin icinde ayri varyanttir (`variant_keys`). Markasiz MPN kimlik degildir.
4. Geri kalan: tekil `unmatched`.

Karmasiklik O(n log n) (siralama) + sozluk gruplama.
"""

from __future__ import annotations

import hashlib
import re
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Literal

from platforms.contract import CanonicalListing
from resolve.identity_policy import classify_gtin, mpn_norm, normalize_options, option_key
from resolve.normalize import strip_accents

OfferKeyTuple = tuple[str, str, str | None]
Basis = Literal["gtin", "brand_mpn", "singleton"]
Status = Literal["merged", "hold", "unmatched", "candidate"]

#: Sabit hold neden kodlari.
REASON_GTIN_BRAND = "gtin_brand_mismatch"
REASON_GTIN_VARIANT = "gtin_variant_mismatch"
REASON_GTIN_CATEGORY = "gtin_category_mismatch"
REASON_LISTING_GTIN = "listing_gtin_conflict"
REASON_MPN_CATEGORY = "mpn_category_mismatch"

_NON_ALNUM = re.compile(r"[^a-z0-9]+")
_TOKEN = re.compile(r"[a-z0-9]+")
_UNIT_LIKE = re.compile(r"^\d+(?:gb|tb|mb|ml|cl|kg|gr|mm|cm|lt|w|v|hz|mah|adet)$")


def brand_norm(raw: str | None) -> str | None:
    """Marka karsilastirma bicimi: aksansiz, kucuk harf, yalniz harf/rakam."""
    if not raw:
        return None
    return _NON_ALNUM.sub("", strip_accents(raw).lower()) or None


def _root_norm(path: tuple[str, ...]) -> str | None:
    return brand_norm(path[0]) if path else None


@dataclass(frozen=True)
class Cluster:
    cluster_id: str
    basis: Basis
    status: Status
    #: Sabit kod ('gtin_brand_mismatch' ...) ya da bos.
    reason: str
    #: Kumenin kararli anahtari (kimlik); `cluster_id` bunun ozetidir.
    key: str
    #: Siralanmis teklif anahtarlari (platform, listing_id, seller_id).
    members: tuple[OfferKeyTuple, ...]
    platforms: frozenset[str]
    #: Model duzeyi kumede varyant (secenek) anahtarlari; '' = secenek yok.
    variant_keys: tuple[str, ...] = ()
    #: Hold ise ayni GTIN/model grubunu birbirine baglayan anahtar.
    group_key: str = ""

    @property
    def cross_platform(self) -> bool:
        return len(self.platforms) > 1


@dataclass(frozen=True)
class MatchStats:
    offers: int
    listings: int
    clusters: int
    by_status: Mapping[str, int]
    by_basis: Mapping[str, int]
    cross_platform_clusters: int


@dataclass(frozen=True)
class MatchResult:
    clusters: tuple[Cluster, ...]
    stats: MatchStats


@dataclass(frozen=True)
class CandidatePair:
    left: str
    right: str
    hint: str
    status: Status = "candidate"


@dataclass
class _Unit:
    """Bir (platform, listing_id): tum saticilarin birlesik gorunumu."""

    platform: str
    listing_id: str
    members: list[OfferKeyTuple]
    brand: str | None = None
    gtins: set[str] | None = None
    mpn: str | None = None
    root: str | None = None
    options: dict[str, str] | None = None


def _cluster_id(key: str) -> str:
    return "mc_" + hashlib.sha256(key.encode("utf-8")).hexdigest()[:20]


def _sort_key(item: CanonicalListing) -> tuple[str, ...]:
    return (
        item.platform,
        item.listing_id,
        item.seller_id or "",
        item.gtin or "",
        item.mpn or "",
        item.brand or "",
        item.title,
    )


def _build_units(listings: Iterable[CanonicalListing]) -> tuple[list[_Unit], int]:
    ordered = sorted(listings, key=_sort_key)
    units: dict[tuple[str, str], _Unit] = {}
    seen: set[OfferKeyTuple] = set()
    for item in ordered:
        ukey = (item.platform, item.listing_id)
        unit = units.get(ukey)
        if unit is None:
            unit = units[ukey] = _Unit(item.platform, item.listing_id, [])
        okey: OfferKeyTuple = (item.platform, item.listing_id, item.seller_id)
        if okey not in seen:
            seen.add(okey)
            unit.members.append(okey)
        if unit.brand is None:
            unit.brand = brand_norm(item.brand)
        if unit.mpn is None:
            unit.mpn = mpn_norm(item.mpn)
        if unit.root is None:
            unit.root = _root_norm(item.category_path)
        if unit.options is None and item.options:
            norm = normalize_options(item.options)
            unit.options = norm or None
        info = classify_gtin(item.gtin)
        if info.status == "valid" and info.value:
            if unit.gtins is None:
                unit.gtins = set()
            unit.gtins.add(info.value)
    return list(units.values()), len(seen)


def _member_sort(m: OfferKeyTuple) -> tuple[str, str, str]:
    return (m[0], m[1], m[2] or "")


def _make(
    key: str,
    basis: Basis,
    status: Status,
    reason: str,
    units: list[_Unit],
    group_key: str = "",
    variants: bool = False,
) -> Cluster:
    members = tuple(sorted((m for u in units for m in u.members), key=_member_sort))
    variant_keys: tuple[str, ...] = ()
    if variants:
        variant_keys = tuple(sorted({option_key(u.options or {}) for u in units}))
    return Cluster(
        cluster_id=_cluster_id(key),
        basis=basis,
        status=status,
        reason=reason,
        key=key,
        members=members,
        platforms=frozenset(u.platform for u in units),
        variant_keys=variant_keys,
        group_key=group_key,
    )


def _gtin_conflict(units: list[_Unit]) -> str | None:
    brands = {u.brand for u in units if u.brand}
    if len(brands) > 1:
        return REASON_GTIN_BRAND
    roots = {u.root for u in units if u.root}
    if len(roots) > 1:
        return REASON_GTIN_CATEGORY
    axes: dict[str, set[str]] = defaultdict(set)
    for u in units:
        for axis, value in (u.options or {}).items():
            axes[axis].add(value)
    if any(len(values) > 1 for values in axes.values()):
        return REASON_GTIN_VARIANT
    return None


def match_listings(listings: Iterable[CanonicalListing]) -> MatchResult:
    """Ilanlari kumeler. Saf, deterministik, girdi sirasindan bagimsiz."""
    units, offer_count = _build_units(listings)
    clusters: list[Cluster] = []

    by_gtin: dict[str, list[_Unit]] = defaultdict(list)
    rest: list[_Unit] = []
    for unit in units:
        if unit.gtins and len(unit.gtins) > 1:
            # Ayni ilanin saticilari farkli GTIN bildiriyor: guvenilmez.
            clusters.append(
                _make(
                    f"hold|listing|{unit.platform}|{unit.listing_id}",
                    "gtin",
                    "hold",
                    REASON_LISTING_GTIN,
                    [unit],
                    group_key="|".join(sorted(unit.gtins)),
                )
            )
        elif unit.gtins:
            by_gtin[next(iter(unit.gtins))].append(unit)
        else:
            rest.append(unit)

    for gtin, group in by_gtin.items():
        reason = _gtin_conflict(group) if len(group) > 1 else None
        if reason:
            for unit in group:
                key = f"hold|gtin|{gtin}|{unit.platform}|{unit.listing_id}"
                clusters.append(_make(key, "gtin", "hold", reason, [unit], group_key=gtin))
            continue
        status: Status = "merged" if len(group) > 1 else "unmatched"
        clusters.append(_make(f"gtin|{gtin}", "gtin", status, "", group))

    by_model: dict[tuple[str, str], list[_Unit]] = defaultdict(list)
    for unit in rest:
        if unit.brand and unit.mpn:
            by_model[(unit.brand, unit.mpn)].append(unit)
        else:
            key = f"single|{unit.platform}|{unit.listing_id}"
            clusters.append(_make(key, "singleton", "unmatched", "", [unit]))

    for (brand, mpn), group in by_model.items():
        group_key = f"mpn|{brand}|{mpn}"
        roots = {u.root for u in group if u.root}
        if len(roots) > 1:
            for unit in group:
                key = f"hold|{group_key}|{unit.platform}|{unit.listing_id}"
                clusters.append(
                    _make(
                        key, "brand_mpn", "hold", REASON_MPN_CATEGORY, [unit], group_key=group_key
                    )
                )
            continue
        status = "merged" if len(group) > 1 else "unmatched"
        clusters.append(_make(group_key, "brand_mpn", status, "", group, variants=True))

    clusters.sort(key=lambda c: c.cluster_id)
    return MatchResult(tuple(clusters), _stats(clusters, offer_count, len(units)))


def _stats(clusters: list[Cluster], offers: int, listings: int) -> MatchStats:
    return MatchStats(
        offers=offers,
        listings=listings,
        clusters=len(clusters),
        by_status=dict(sorted(Counter(c.status for c in clusters).items())),
        by_basis=dict(sorted(Counter(c.basis for c in clusters).items())),
        cross_platform_clusters=sum(1 for c in clusters if c.cross_platform),
    )


def model_hint(title: str, brand: str | None) -> str | None:
    """Marka + baslikteki harf/rakam karisik model tokeni; yalnizca aday ipucu."""
    brand_key = brand_norm(brand)
    if not brand_key:
        return None
    tokens = [
        t
        for t in _TOKEN.findall(strip_accents(title).lower())
        if len(t) >= 3
        and any(c.isdigit() for c in t)
        and any(c.isalpha() for c in t)
        and not _UNIT_LIKE.match(t)
    ]
    if not tokens:
        return None
    return f"{brand_key}:{max(tokens, key=lambda t: (len(t), t))}"


def candidate_pairs(
    listings: Iterable[CanonicalListing],
    result: MatchResult | None = None,
    max_group: int = 50,
) -> list[CandidatePair]:
    """Ayni model ipucunu paylasan FARKLI kume ciftleri. Hicbir zaman birlestirmez.

    `max_group` ustundeki ipucu gruplari (genel tokenlar) atlanir: ikinci dereceden
    patlamayi onler.
    """
    items = list(listings)
    result = result or match_listings(items)
    owner: dict[tuple[str, str], str] = {}
    for cluster in result.clusters:
        for platform, listing_id, _seller in cluster.members:
            owner[(platform, listing_id)] = cluster.cluster_id
    groups: dict[str, set[str]] = defaultdict(set)
    for item in items:
        hint = model_hint(item.title, item.brand)
        cid = owner.get((item.platform, item.listing_id))
        if hint and cid:
            groups[hint].add(cid)
    pairs: list[CandidatePair] = []
    for hint in sorted(groups):
        ids = sorted(groups[hint])
        if len(ids) < 2 or len(ids) > max_group:
            continue
        for i, left in enumerate(ids):
            for right in ids[i + 1 :]:
                pairs.append(CandidatePair(left, right, hint))
    return pairs
