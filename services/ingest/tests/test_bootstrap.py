"""Bootstrap katalogu: manifest kurallari, yerel veritabani korumasi ve
aktivasyon yasagi (docs/decisions/0042). `integration` isaretliler yerel
veritabani ister; hicbir test aga cikmaz."""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import psycopg
import pytest

from collect import bootstrap
from collect.bootstrap import (
    BOOTSTRAP_SOURCE,
    HARD_CAP,
    INSERT_MERCHANT,
    UPDATE_MERCHANT,
    BootstrapMerchant,
    ExistingMerchant,
    Registration,
    currency_config,
    is_local_database,
    load_manifest,
    plan_registration,
)
from collect.mapping import FieldMapping
from db.connection import database_url


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


# --- aktivasyon yok (docs/decisions/0042) ------------------------------------------------

PROVENANCE_TRY = {"currency": "TRY", "confidence": "high", "evidence": []}


def _existing(
    config: dict[str, Any],
    *,
    is_active: bool = False,
    source_type: str = "shopify",
    feed_url: str | None = "https://a.example/products.json",
) -> ExistingMerchant:
    return ExistingMerchant("a-0018", source_type, is_active, feed_url, config)


def test_sql_never_activates() -> None:
    assert "FALSE" in INSERT_MERCHANT and "TRUE" not in INSERT_MERCHANT
    assert "is_active" not in UPDATE_MERCHANT
    assert "DO UPDATE" not in INSERT_MERCHANT


def test_new_merchant_is_planned_as_insert() -> None:
    plan = plan_registration(None, BootstrapMerchant(**_entry("a", 10)), {}, PROVENANCE_TRY)

    assert plan.action == "insert"
    assert plan.feed_config is not None
    assert plan.feed_config["bootstrap_source"] == BOOTSTRAP_SOURCE


def test_verified_merchant_with_different_config_is_refused_not_overwritten() -> None:
    """0018 + 0021: konumsal esleme, dogrulanmis TRY. Manifest ad tabanli."""
    stored = {
        "category_hint": "ev-yasam",
        "currency": "TRY",
        "currency_verified": True,
        "transport": {"shopify": {"color_option": "option1"}},
        "mapping": {"price": "price"},
    }
    merchant = BootstrapMerchant(**_entry("a", 10))

    plan = plan_registration(_existing(stored), merchant, {}, PROVENANCE_TRY)

    assert plan.action == "refuse"
    assert plan.feed_config is None
    assert plan.reason is not None and plan.reason.startswith("verified_config_conflict")
    assert "transport" in plan.reason and "mapping" in plan.reason


def test_verified_merchant_is_refused_when_manifest_currency_disagrees() -> None:
    merchant = BootstrapMerchant(**_entry("a", 10))
    stored = merchant.feed_config({}, PROVENANCE_TRY)

    for provenance in (None, {"currency": "UNKNOWN", "confidence": "none"}):
        plan = plan_registration(_existing(stored), merchant, {}, provenance)
        assert plan.action == "refuse"
        assert "currency" in (plan.reason or "")


def test_verified_merchant_with_identical_config_is_unchanged() -> None:
    merchant = BootstrapMerchant(**_entry("a", 10))
    stored = merchant.feed_config({}, PROVENANCE_TRY)

    plan = plan_registration(_existing(stored), merchant, {}, PROVENANCE_TRY)

    assert plan.action == "unchanged"
    assert plan.feed_config == stored


def test_unverified_merchant_is_merged_and_stored_currency_is_preserved() -> None:
    stored = {
        "currency_verified": False,
        "full_dump": False,
        "operator_note": "migration'a ait",
        "transport": {"shopify": {"color_option": "option1"}},
    }
    merchant = BootstrapMerchant(**_entry("a", 10))

    plan = plan_registration(_existing(stored), merchant, {}, PROVENANCE_TRY)

    assert plan.action == "update"
    config = plan.feed_config or {}
    # Manifestin kanit dosyasi kayitli dogrulamayi YUKSELTEMEZ.
    assert config["currency_verified"] is False
    # Manifestte olmayan anahtarlar kalir; manifestinkiler yazilir.
    assert config["operator_note"] == "migration'a ait"
    assert config["full_dump"] is False
    assert config["bootstrap_source"] == BOOTSTRAP_SOURCE
    assert "max_products" in config["transport"]["shopify"]


def test_currency_is_filled_only_when_absent() -> None:
    merchant = BootstrapMerchant(**_entry("a", 10))

    plan = plan_registration(_existing({"category_hint": "x"}), merchant, {}, PROVENANCE_TRY)

    assert plan.action == "update"
    assert (plan.feed_config or {})["currency"] == "TRY"


def test_non_shopify_or_invalid_existing_row_is_refused() -> None:
    merchant = BootstrapMerchant(**_entry("a", 10))

    assert (
        plan_registration(_existing({}, source_type="user_discovered"), merchant, {}, None).action
        == "refuse"
    )
    assert plan_registration(_existing("{}"), merchant, {}, None).action == "refuse"  # type: ignore[arg-type]


@pytest.fixture
def fake_run(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """`run()`'in kontrol akisi: kayit sonucu verilir, toplama cagrisi sayilir."""
    state: dict[str, Any] = {"registration": None, "ingested": []}

    def register(conn, merchant, defaults, provenance=None):  # noqa: ANN001, ANN202
        return state["registration"]

    def ingest(conn, slug):  # noqa: ANN001, ANN202
        state["ingested"].append(slug)
        raise AssertionError("pasif/reddedilmis merchant icin toplama cagrilmamali")

    monkeypatch.setattr(bootstrap, "register_merchant", register)
    monkeypatch.setattr(bootstrap, "run_ingest", ingest)
    return state


def _run(register_only: bool = False) -> list[bootstrap.SourceReport]:
    return bootstrap.run(
        None,  # type: ignore[arg-type]
        {},
        [BootstrapMerchant(**_entry("a", 10))],
        register_only=register_only,
        enrich_identifiers=False,
    )


def test_inactive_merchant_is_not_ingested(fake_run: dict[str, Any]) -> None:
    fake_run["registration"] = Registration("a", False, "insert")

    (report,) = _run()

    assert report.status == "inactive"
    assert report.is_active is False
    assert fake_run["ingested"] == []


def test_register_only_never_ingests_and_reports_real_state(fake_run: dict[str, Any]) -> None:
    fake_run["registration"] = Registration("a", False, "update")

    (report,) = _run(register_only=True)

    assert report.status == "registered"
    assert (report.registration, report.is_active) == ("update", False)
    assert fake_run["ingested"] == []


def test_refused_registration_is_reported_and_not_ingested(fake_run: dict[str, Any]) -> None:
    fake_run["registration"] = Registration("a", True, "refuse", "verified_config_conflict: x")

    (report,) = _run()

    assert report.status == "refused"
    assert "verified_config_conflict" in report.errors[0]
    assert fake_run["ingested"] == []


# --- yerel veritabani ----------------------------------------------------------------

DB_SLUG = "test-bootstrap-safety"
DB_DOMAIN = "test-bootstrap-safety.example"


def _owner() -> psycopg.Connection:
    try:
        return psycopg.connect(database_url("DATABASE_URL_OWNER"))
    except psycopg.OperationalError as error:  # pragma: no cover
        pytest.skip(f"yerel veritabani yok: {error}")


def _db_cleanup() -> None:
    with _owner() as owner, owner.cursor() as cur:
        cur.execute(
            """DELETE FROM ingest_run
                WHERE merchant_id IN (SELECT id FROM merchant WHERE domain = %s)""",
            (DB_DOMAIN,),
        )
        cur.execute("DELETE FROM merchant WHERE domain = %s", (DB_DOMAIN,))


def _db_row() -> tuple[Any, ...]:
    with _owner() as owner, owner.cursor() as cur:
        cur.execute(
            "SELECT slug, is_active, feed_config, updated_at FROM merchant WHERE domain = %s",
            (DB_DOMAIN,),
        )
        row = cur.fetchone()
        assert row is not None
        return row


def _db_runs() -> int:
    with _owner() as owner, owner.cursor() as cur:
        cur.execute(
            """SELECT count(*) FROM ingest_run r JOIN merchant m ON m.id = r.merchant_id
                WHERE m.domain = %s""",
            (DB_DOMAIN,),
        )
        row = cur.fetchone()
        assert row is not None
        return int(row[0])


def _db_merchant() -> BootstrapMerchant:
    return BootstrapMerchant(
        slug=DB_SLUG, name="Test", domain=DB_DOMAIN, category_hint="moda", max_products=5
    )


@pytest.fixture
def clean_db() -> Iterator[None]:
    _db_cleanup()
    yield
    _db_cleanup()


def _seed(config: dict[str, Any], is_active: bool) -> None:
    with _owner() as owner, owner.cursor() as cur:
        cur.execute(
            """INSERT INTO merchant (slug, name, domain, source_type, feed_url, feed_config,
                                     is_active)
               VALUES (%s, 'Test', %s, 'shopify', %s, %s, %s)""",
            (DB_SLUG, DB_DOMAIN, _db_merchant().feed_url, json.dumps(config), is_active),
        )


def _app_run(register_only: bool) -> list[bootstrap.SourceReport]:
    with psycopg.connect(database_url("DATABASE_URL")) as conn:
        return bootstrap.run(
            conn,
            {},
            [_db_merchant()],
            {DB_SLUG: PROVENANCE_TRY},
            register_only=register_only,
            enrich_identifiers=False,
        )


@pytest.mark.integration
@pytest.mark.parametrize("register_only", [True, False])
def test_db_bootstrap_inserts_inactive_and_does_not_ingest(
    clean_db: None, register_only: bool
) -> None:
    (report,) = _app_run(register_only)

    _, is_active, _, _ = _db_row()
    assert is_active is False
    assert report.status == ("registered" if register_only else "inactive")
    assert _db_runs() == 0


@pytest.mark.integration
@pytest.mark.parametrize("is_active", [True, False])
def test_db_existing_is_active_is_preserved(clean_db: None, is_active: bool) -> None:
    _seed({"currency_verified": False, "operator_note": "kalir"}, is_active)

    _app_run(register_only=True)

    _, stored_active, config, _ = _db_row()
    assert stored_active is is_active
    assert config["operator_note"] == "kalir"
    assert config["currency_verified"] is False


@pytest.mark.integration
def test_db_verified_merchant_conflict_leaves_row_untouched(clean_db: None) -> None:
    stored = {
        "currency": "TRY",
        "currency_verified": True,
        "transport": {"shopify": {"color_option": "option1"}},
    }
    _seed(stored, is_active=False)
    before = _db_row()

    (report,) = _app_run(register_only=False)

    assert report.status == "refused"
    assert _db_row() == before
    assert _db_runs() == 0
