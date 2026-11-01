from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta

import pytest

from catalog_build.policy import POLICIES, SOURCE_LISTING_MERCHANTS
from feeds.profiles import MERCHANT_PROFILES
from platforms import registry
from platforms.constraints import (
    RetentionPolicy,
    SourceConstraints,
    UpdateLimits,
    UsageRights,
    next_refresh_at,
    price_displayable,
    price_history_cutoff,
    refresh_due,
)
from platforms.contract import CanonicalListing, Rejection, offer_key, split_offer_key

NOW = datetime(2026, 10, 31, 12, 0, tzinfo=UTC)


def _listing(**over: object) -> CanonicalListing:
    base: dict[str, object] = {
        "platform": "trendyol",
        "listing_id": "123456",
        "title": "Ornek urun",
        "url": "https://example.test/p",
        "currency": "TRY",
        "observed_at": NOW,
    }
    base.update(over)
    return CanonicalListing(**base)  # type: ignore[arg-type]


# -- contract ---------------------------------------------------------------


def test_offer_key_schemes_separate_sellers() -> None:
    assert offer_key("listing", "L1", None) == "L1"
    a = offer_key("listing_seller", "L1", "S1")
    b = offer_key("listing_seller", "L1", "S2")
    assert a != b
    assert split_offer_key(a) == ("L1", "S1")
    assert split_offer_key("L1") == ("L1", None)


@pytest.mark.parametrize("listing,seller", [("a~b", "s"), ("", "s"), ("a b", "s"), ("a", None)])
def test_offer_key_rejects_ambiguous_ids(listing: str, seller: str | None) -> None:
    with pytest.raises(ValueError):
        offer_key("listing_seller", listing, seller)


def test_listing_price_must_be_int_kurus() -> None:
    assert _listing(price=12_990).price == 12_990
    with pytest.raises(TypeError):
        _listing(price=129.90)
    with pytest.raises(TypeError):
        _listing(price=True)
    with pytest.raises(ValueError):
        _listing(price=-1)


def test_listing_requires_utc_aware_timestamp_and_valid_currency() -> None:
    with pytest.raises(ValueError):
        _listing(observed_at=datetime(2026, 10, 31))
    with pytest.raises(ValueError):
        _listing(currency="try")


def test_unknown_stock_is_not_out_of_stock() -> None:
    assert _listing().in_stock is None


def test_rejection_code_is_a_stable_slug() -> None:
    assert Rejection("price_not_numeric").code == "price_not_numeric"
    with pytest.raises(ValueError):
        Rejection("Bad Code!")


# -- constraints ------------------------------------------------------------


def _constraints(**update: object) -> SourceConstraints:
    return SourceConstraints(
        rights=UsageRights(
            data_license="partner_api",
            may_store_prices=True,
            may_display_prices=True,
            foreign_currency_display=True,
        ),
        update=UpdateLimits(**update),  # type: ignore[arg-type]
    )


def test_refresh_interval_is_enforced() -> None:
    c = _constraints(min_refresh_interval=timedelta(hours=6))
    assert refresh_due(c, None, NOW)
    assert not refresh_due(c, NOW - timedelta(hours=5), NOW)
    assert refresh_due(c, NOW - timedelta(hours=6), NOW)
    assert next_refresh_at(c, NOW - timedelta(hours=5), NOW) == NOW + timedelta(hours=1)


def test_price_displayable_reasons() -> None:
    c = _constraints(max_price_age=timedelta(days=2))
    ok = price_displayable(c, currency="TRY", observed_at=NOW - timedelta(hours=3), now=NOW)
    assert ok == (True, None)
    stale = price_displayable(c, currency="TRY", observed_at=NOW - timedelta(days=3), now=NOW)
    assert stale == (False, "price_stale")
    fx = price_displayable(c, currency="USD", observed_at=NOW, now=NOW)
    assert fx == (False, "foreign_currency_not_approved")
    fx_ok = price_displayable(
        c, currency="USD", observed_at=NOW, now=NOW, foreign_display_approved=True
    )
    assert fx_ok == (True, None)
    default = SourceConstraints()
    assert price_displayable(default, currency="TRY", observed_at=NOW, now=NOW) == (
        False,
        "license_forbids_price",
    )


def test_inconsistent_rights_are_rejected() -> None:
    with pytest.raises(ValueError):
        SourceConstraints(rights=UsageRights(may_display_prices=True))
    with pytest.raises(ValueError):
        SourceConstraints(rights=UsageRights(may_mirror_images=True))
    with pytest.raises(ValueError):
        UpdateLimits(batch_size=0)


def test_price_history_cutoff_unbounded_by_default() -> None:
    assert price_history_cutoff(SourceConstraints(), NOW) is None
    bounded = SourceConstraints(retention=RetentionPolicy(price_history_days=365))
    assert price_history_cutoff(bounded, NOW) == NOW - timedelta(days=365)


# -- registry ---------------------------------------------------------------


def test_catalog_policies_are_derived_from_registry() -> None:
    assert set(POLICIES) == {"aliexpress", "hepsiburada"}
    assert frozenset({"aliexpress", "hepsiburada"}) == SOURCE_LISTING_MERCHANTS
    ali = POLICIES["aliexpress"]
    assert ali.id_pattern.match("1005001234567890")
    assert ali.discovery_source is None
    assert POLICIES["hepsiburada"].discovery_source == "hepsiburada"


def test_sample_platform_never_enters_catalog_pipeline() -> None:
    assert registry.get("trendyol") is not None
    assert "trendyol" not in registry.catalog_definitions()
    assert "trendyol" not in POLICIES


def test_registry_matches_existing_merchant_profiles() -> None:
    """Kaynak bilgisi iki yerde yasiyor (registry + feeds.profiles): sapma testte yakalanir."""
    for profile in MERCHANT_PROFILES.values():
        definition = registry.get(profile["slug"])
        assert definition is not None, profile["slug"]
        merchant = definition.merchant
        assert merchant.name == profile["name"]
        assert merchant.domain == profile["domain"]
        assert merchant.source_type == profile["source_type"]
        assert merchant.affiliate_network == profile["affiliate_network"]
        assert merchant.affiliate_status == profile["affiliate_status"]
        assert merchant.deeplink_template == profile["deeplink_template"]


def test_marketplace_requires_seller_scoped_offer_key() -> None:
    with pytest.raises(ValueError):
        registry.SourceDefinition(
            slug="x-market",
            kind="api",
            merchant=registry.MerchantInfo("X", "x.test", "api"),
            constraints=SourceConstraints(),
            is_marketplace=True,
        )


def test_duplicate_registration_is_refused() -> None:
    with pytest.raises(ValueError):
        registry.register(registry.ALIEXPRESS)


def test_onboarding_checklist_flags_missing_pieces() -> None:
    bare = registry.SourceDefinition(
        slug="yeni-kaynak",
        kind="csv",
        merchant=registry.MerchantInfo("Yeni", "yeni.test", "xml_feed"),
        constraints=SourceConstraints(),
    )
    assert registry.onboarding_problems(bare) == ["data_license_unknown"]
    assert registry.onboarding_problems(registry.ALIEXPRESS) == []
    assert registry.onboarding_problems(registry.HEPSIBURADA) == []


def test_verified_source_needs_identity_rule() -> None:
    with pytest.raises(ValueError):
        registry.SourceDefinition(
            slug="bos-kimlik",
            kind="csv",
            status="verified",
            merchant=registry.MerchantInfo("B", "b.test", "xml_feed"),
            constraints=SourceConstraints(),
        )


def test_identity_url_patterns_carry_the_source_id_in_group_one() -> None:
    for definition in registry.catalog_definitions().values():
        assert definition.identity is not None
        assert isinstance(definition.identity.url_pattern, re.Pattern)
        assert definition.identity.url_pattern.groups >= 1
