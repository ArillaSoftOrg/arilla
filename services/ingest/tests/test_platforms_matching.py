"""Platformlar arasi saf eslestirici testleri. Veritabani yok; tum veri uydurmadir."""

from __future__ import annotations

import random
import time
from datetime import UTC, datetime

from platforms.contract import CanonicalListing
from platforms.matching import candidate_pairs, match_listings

NOW = datetime(2026, 1, 1, tzinfo=UTC)


def make_gtin(body12: str, indicator: str = "") -> str:
    """Kontrol basamagi dogru GTIN-13 (ya da indicator verilirse GTIN-14) uretir."""
    body = (indicator + body12) if indicator else body12
    total = sum(int(d) * (3 if i % 2 == 0 else 1) for i, d in enumerate(reversed(body)))
    return body + str((10 - total % 10) % 10)


def synth_gtin(n: int) -> str:
    return make_gtin(f"8690{n:08d}")


def listing(platform: str, listing_id: str, **kw) -> CanonicalListing:
    kw.setdefault("title", f"Fiktif Urun {listing_id}")
    return CanonicalListing(
        platform=platform,
        listing_id=listing_id,
        url=f"https://example.invalid/{platform}/{listing_id}",
        currency="TRY",
        observed_at=NOW,
        **kw,
    )


def by_key(result):
    return {c.key: c for c in result.clusters}


GT = synth_gtin(1234)


def test_same_gtin_merges_across_three_platforms() -> None:
    items = [
        listing("hepsiburada", "hb1", gtin=GT, brand="Zorbex"),
        listing("trendyol", "ty1", gtin=GT, brand="ZORBEX", seller_id="s1"),
        listing("aliexpress", "ae1", gtin=GT),
    ]
    result = match_listings(items)
    assert len(result.clusters) == 1
    cluster = result.clusters[0]
    assert (cluster.status, cluster.basis) == ("merged", "gtin")
    assert cluster.platforms == {"hepsiburada", "trendyol", "aliexpress"}
    assert len(cluster.members) == 3
    assert result.stats.cross_platform_clusters == 1
    assert result.stats.by_status == {"merged": 1}


def test_gtin_brand_conflict_is_hold_and_not_merged() -> None:
    items = [
        listing("hepsiburada", "hb1", gtin=GT, brand="Zorbex"),
        listing("trendyol", "ty1", gtin=GT, brand="Quillon"),
    ]
    result = match_listings(items)
    assert len(result.clusters) == 2
    assert {c.status for c in result.clusters} == {"hold"}
    assert {c.reason for c in result.clusters} == {"gtin_brand_mismatch"}
    assert all(len(c.members) == 1 for c in result.clusters)
    assert {c.group_key for c in result.clusters} == {GT.zfill(14)}


def test_gtin_variant_and_category_conflicts_hold() -> None:
    variant = match_listings(
        [
            listing("hepsiburada", "a", gtin=GT, options={"Renk": "Siyah"}),
            listing("trendyol", "b", gtin=GT, options={"color": "Beyaz"}),
        ]
    )
    assert {c.reason for c in variant.clusters} == {"gtin_variant_mismatch"}
    category = match_listings(
        [
            listing("hepsiburada", "a", gtin=GT, category_path=("Moda", "Ayakkabi")),
            listing("trendyol", "b", gtin=GT, category_path=("Elektronik", "Telefon")),
        ]
    )
    assert {c.reason for c in category.clusters} == {"gtin_category_mismatch"}
    assert all(c.status == "hold" for c in category.clusters)


def test_package_gtin14_never_merges_with_single_item() -> None:
    single = make_gtin("869000000123")
    package = make_gtin("869000000123", indicator="1")
    assert single != package
    result = match_listings(
        [
            listing("hepsiburada", "hb1", gtin=single, brand="Zorbex"),
            listing("trendyol", "ty1", gtin=package, brand="Zorbex"),
        ]
    )
    assert len(result.clusters) == 2
    assert result.stats.cross_platform_clusters == 0
    assert "merged" not in result.stats.by_status


def test_restricted_gtin_prefix_is_not_an_identity() -> None:
    store_internal = make_gtin("200000000123")
    result = match_listings(
        [
            listing("hepsiburada", "hb1", gtin=store_internal),
            listing("trendyol", "ty1", gtin=store_internal),
        ]
    )
    assert len(result.clusters) == 2
    assert {c.basis for c in result.clusters} == {"singleton"}


def test_mpn_without_brand_is_not_an_identity() -> None:
    result = match_listings(
        [
            listing("hepsiburada", "hb1", mpn="ZX-9000-A"),
            listing("trendyol", "ty1", mpn="ZX9000A"),
            listing("aliexpress", "ae1", mpn="ZX9000A", brand="Zorbex"),
        ]
    )
    assert len(result.clusters) == 3
    assert result.stats.by_status == {"unmatched": 3}


def test_brand_mpn_merges_and_color_variants_stay_distinct() -> None:
    items = [
        listing("hepsiburada", "hb1", brand="Zorbex", mpn="ZX-9000-A", options={"Renk": "Siyah"}),
        listing("trendyol", "ty1", brand="zorbex", mpn="ZX9000A", options={"color": "Beyaz"}),
        listing("aliexpress", "ae1", brand="Zorbex", mpn="zx 9000 a", options={"Renk": "Siyah"}),
    ]
    result = match_listings(items)
    assert len(result.clusters) == 1
    cluster = result.clusters[0]
    assert (cluster.status, cluster.basis) == ("merged", "brand_mpn")
    assert cluster.variant_keys == ("renk=beyaz", "renk=siyah")
    assert cluster.platforms == {"hepsiburada", "trendyol", "aliexpress"}


def test_different_brand_same_mpn_does_not_merge() -> None:
    result = match_listings(
        [
            listing("hepsiburada", "hb1", brand="Zorbex", mpn="ZX9000A"),
            listing("trendyol", "ty1", brand="Quillon", mpn="ZX9000A"),
        ]
    )
    assert len(result.clusters) == 2


def test_same_title_different_identity_never_merges_but_is_candidate() -> None:
    title = "Zorbex ZX9000A Fiktif Kulaklik"
    items = [
        listing("hepsiburada", "hb1", title=title, brand="Zorbex", gtin=synth_gtin(1)),
        listing("trendyol", "ty1", title=title, brand="Zorbex", gtin=synth_gtin(2)),
        listing("aliexpress", "ae1", title=title),
    ]
    result = match_listings(items)
    assert len(result.clusters) == 3
    assert "merged" not in result.stats.by_status
    pairs = candidate_pairs(items, result)
    assert len(pairs) == 1
    assert pairs[0].status == "candidate"
    assert pairs[0].hint == "zorbex:zx9000a"
    assert pairs[0].left != pairs[0].right


def test_multi_seller_same_listing_is_one_cluster() -> None:
    items = [
        listing("trendyol", "ty1", seller_id="s1", brand="Zorbex", mpn="ZX9000A"),
        listing("trendyol", "ty1", seller_id="s2", brand="Zorbex", mpn="ZX9000A"),
        listing("trendyol", "ty1", seller_id="s3"),
    ]
    result = match_listings(items)
    assert len(result.clusters) == 1
    assert result.clusters[0].members == (
        ("trendyol", "ty1", "s1"),
        ("trendyol", "ty1", "s2"),
        ("trendyol", "ty1", "s3"),
    )
    assert result.stats.offers == 3
    assert result.stats.listings == 1


def test_duplicate_input_rows_collapse() -> None:
    row = listing("trendyol", "ty1", seller_id="s1", gtin=GT)
    result = match_listings([row, row])
    assert result.stats.offers == 1
    assert len(result.clusters[0].members) == 1


def _mixed_fixture() -> list[CanonicalListing]:
    items: list[CanonicalListing] = []
    for n in range(40):
        gtin = synth_gtin(n)
        items.append(listing("hepsiburada", f"hb{n}", gtin=gtin, brand="Zorbex"))
        items.append(listing("trendyol", f"ty{n}", gtin=gtin, seller_id=f"s{n % 3}"))
        if n % 4 == 0:
            items.append(listing("aliexpress", f"ae{n}", gtin=gtin, brand="Quillon"))
        items.append(listing("trendyol", f"m{n}", brand="Zorbex", mpn=f"MD{n:04d}X"))
        items.append(listing("hepsiburada", f"m{n}", brand="Zorbex", mpn=f"md-{n:04d}-x"))
        items.append(listing("aliexpress", f"lone{n}"))
    return items


def test_order_independence_with_shuffle() -> None:
    items = _mixed_fixture()
    baseline = match_listings(items)
    for seed in (1, 2, 3):
        shuffled = list(items)
        random.Random(seed).shuffle(shuffled)
        assert match_listings(shuffled) == baseline
    assert baseline.stats.by_status["hold"] > 0
    assert baseline.stats.by_status["merged"] > 0


def test_idempotent_and_stable_ids() -> None:
    items = _mixed_fixture()
    first = match_listings(items)
    second = match_listings(items)
    assert first == second
    ids = [c.cluster_id for c in first.clusters]
    assert ids == sorted(ids)
    assert len(set(ids)) == len(ids)
    # Kume kimligi uye eklenince degismez (anahtar kimliktir, sira degil).
    extra = items + [listing("aliexpress", "late", gtin=synth_gtin(1), brand="Zorbex")]
    grown = by_key(match_listings(extra))
    assert (
        grown[f"gtin|{synth_gtin(1).zfill(14)}"].cluster_id
        == by_key(first)[f"gtin|{synth_gtin(1).zfill(14)}"].cluster_id
    )


def test_perf_smoke_200k_listings() -> None:
    items: list[CanonicalListing] = []
    for n in range(200_000):
        platform = ("hepsiburada", "trendyol", "aliexpress", "amazon-tr")[n % 4]
        if n % 2 == 0:
            items.append(listing(platform, f"p{n}", gtin=synth_gtin(n // 4), title="Fiktif"))
        elif n % 3 == 0:
            items.append(
                listing(platform, f"p{n}", brand="Zorbex", mpn=f"MP{n // 8:07d}", title="Fiktif")
            )
        else:
            items.append(listing(platform, f"p{n}", title="Fiktif"))
    start = time.perf_counter()
    result = match_listings(items)
    elapsed = time.perf_counter() - start
    assert result.stats.offers == 200_000
    assert result.stats.cross_platform_clusters > 0
    assert elapsed < 30
