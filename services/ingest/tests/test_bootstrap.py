"""Bootstrap katalogu: manifest kurallari ve yerel veritabani korumasi."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from collect.bootstrap import (
    BOOTSTRAP_SOURCE,
    HARD_CAP,
    BootstrapMerchant,
    currency_config,
    is_local_database,
    load_manifest,
)
from collect.mapping import FieldMapping


def _write(tmp_path: Path, merchants: list[dict]) -> Path:
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps({"defaults": {}, "merchants": merchants}), encoding="utf-8")
    return path


def _entry(slug: str, max_products: int) -> dict:
    return {
        "slug": slug,
        "name": slug.title(),
        "domain": f"{slug}.example",
        "category_hint": "moda",
        "max_products": max_products,
    }


def test_manifest_over_hard_cap_is_refused(tmp_path: Path) -> None:
    path = _write(tmp_path, [_entry("a", HARD_CAP), _entry("b", 1)])
    with pytest.raises(ValueError, match="sert tavan"):
        load_manifest(path)


def test_manifest_duplicate_slug_is_refused(tmp_path: Path) -> None:
    path = _write(tmp_path, [_entry("a", 10), _entry("a", 10)])
    with pytest.raises(ValueError, match="tekrarli"):
        load_manifest(path)


def test_feed_config_marks_source_and_carries_limits() -> None:
    merchant = BootstrapMerchant(**_entry("a", 200))
    config = merchant.feed_config(
        {
            "requests_per_second": 0.5,
            "max_retries": 2,
            "color_option_names": ["Renk"],
            "size_option_names": ["Beden"],
        }
    )

    assert config["bootstrap_source"] == BOOTSTRAP_SOURCE
    assert config["category_hint"] == "moda"
    assert config["transport"]["shopify"] == {
        "max_products": 200,
        "color_option_names": ["Renk"],
        "size_option_names": ["Beden"],
    }
    assert config["transport"]["rate_limit"] == {"requests_per_second": 0.5}
    assert config["transport"]["retry"]["max_retries"] == 2
    # Eslemenin gecerli oldugunu mevcut sozlesme dogrular.
    FieldMapping.from_config(config)


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("postgresql://arilla_app:x@localhost:5432/arilla", True),
        ("postgresql://arilla_app:x@127.0.0.1/arilla", True),
        ("postgresql://u:x@aws-1-eu-west-1.pooler.supabase.com:5432/postgres", False),
        ("not a url", False),
    ],
)
def test_only_local_database_is_allowed(url: str, expected: bool) -> None:
    assert is_local_database(url) is expected


def test_currency_is_verified_only_with_accepted_evidence() -> None:
    evidence = [{"source": "meta.json", "fetched_at": "2026-09-24T10:00:00Z"}]
    high = currency_config({"currency": "TRY", "confidence": "high", "evidence": evidence})
    assert high["currency"] == "TRY" and high["currency_verified"] is True
    assert high["currency_evidence"]["sources"] == ["meta.json"]

    for entry in (
        None,
        {"currency": "UNKNOWN", "confidence": "none"},
        {"currency": "TRY", "confidence": "low"},
    ):
        config = currency_config(entry)
        assert config["currency_verified"] is False
        assert config.get("currency") is None


def test_unverified_merchant_config_rejects_records_instead_of_assuming_try() -> None:
    merchant = BootstrapMerchant(**_entry("a", 10))
    mapping = FieldMapping.from_config(merchant.feed_config({}, None))
    assert mapping.default_currency is None
    verified = merchant.feed_config({}, {"currency": "TRY", "confidence": "high", "evidence": []})
    assert FieldMapping.from_config(verified).default_currency == "TRY"


def test_store_name_vendor_is_not_mapped_as_brand() -> None:
    merchant = BootstrapMerchant(**{**_entry("a", 10), "map_brand": False})
    assert "brand" not in merchant.feed_config({})["mapping"]
    assert "brand" in BootstrapMerchant(**_entry("b", 10)).feed_config({})["mapping"]
