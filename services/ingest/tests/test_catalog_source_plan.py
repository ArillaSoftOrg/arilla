"""Kaynak bazli otomatik hat plani (karar 0164): kisitlar yalniz SIKILASTIRIR.

Birim testler veritabanisiz; entegrasyon testleri `test_catalog_auto` duzenini kullanir.
"""

from __future__ import annotations

import json
from dataclasses import replace

import pytest
from test_catalog_auto import (  # noqa: F401  (fixture'lar)
    SLUG,
    _foreign_approved,
    _owner,
    fetch,
    map_file,
    products,
    run,
    seed,
    world,
)

from catalog_build import auto as auto_mod
from catalog_build.source_config import effective_options, plan_for
from platforms import registry
from platforms.constraints import SourceConstraints, UpdateLimits, UsageRights

OPTS = auto_mod.AutoOptions()


def _definition(slug: str, **kw) -> registry.SourceDefinition:
    rights = kw.pop("rights", UsageRights())
    update = kw.pop("update", UpdateLimits())
    return registry.SourceDefinition(
        slug=slug,
        kind="feed",
        merchant=registry.MerchantInfo("T", "t.test", "xml_feed"),
        constraints=SourceConstraints(rights=rights, update=update),
        **kw,
    )


# -- birim ------------------------------------------------------------------------------


def test_aliexpress_plan_matches_current_production_invocation() -> None:
    """Uretim komutu: --merchant aliexpress --allow-foreign (stale varsayilan). Sonuc ayni."""
    plan = plan_for("aliexpress")
    assert plan.registered and plan.may_publish and plan.run_parents and plan.foreign_display
    opts = replace(OPTS, merchant="aliexpress", allow_foreign=True)
    effective, final = effective_options(opts, plan)
    assert effective == opts
    assert final.notes == ()


def test_unregistered_merchant_keeps_legacy_behaviour() -> None:
    plan = plan_for("not-in-registry")
    assert not plan.registered
    opts = replace(OPTS, merchant="not-in-registry", allow_foreign=True, stale_days=9)
    effective, final = effective_options(opts, plan)
    assert effective == opts and final.may_publish and final.run_parents


def test_stale_days_is_only_ever_tightened() -> None:
    plan = plan_for("aliexpress")  # max_price_age = 2 gun
    assert effective_options(replace(OPTS, stale_days=7), plan)[0].stale_days == 2
    assert effective_options(replace(OPTS, stale_days=1), plan)[0].stale_days == 1


def test_foreign_publication_is_only_ever_restricted() -> None:
    hb = plan_for("hepsiburada")  # yurt disi gosterim hakki yok
    assert not hb.foreign_display
    assert effective_options(replace(OPTS, allow_foreign=True), hb)[0].allow_foreign is False
    ali = plan_for("aliexpress")
    assert effective_options(replace(OPTS, allow_foreign=False), ali)[0].allow_foreign is False


def test_parent_map_applies_only_to_sources_it_was_built_for() -> None:
    assert plan_for("aliexpress").run_parents
    assert not plan_for("hepsiburada").run_parents
    assert not plan_for("trendyol").run_parents


def test_default_rights_forbid_publishing() -> None:
    d = _definition("kisitli-kaynak")
    assert not (d.constraints.rights.may_store_prices and d.constraints.rights.may_display_prices)


# -- entegrasyon ---------------------------------------------------------------------------


def _register(monkeypatch: pytest.MonkeyPatch, definition: registry.SourceDefinition) -> None:
    monkeypatch.setitem(registry._REGISTRY, definition.slug, definition)  # noqa: SLF001


@pytest.mark.integration
def test_restricted_source_builds_and_gates_but_never_publishes(
    world, map_file, monkeypatch, _foreign_approved
):
    _register(monkeypatch, _definition(SLUG))  # varsayilan haklar: yayin YOK, harita YOK
    seed(world)
    result = run(world, map_file)
    stages = {s.name: s for s in result.stages}
    assert stages["parents"].status == "not_applicable"
    assert stages["publish"].status == "not_applicable"
    assert stages["build"].status == "success"
    states = {v[0] for v in products(world).values()}
    assert "published" not in states
    assert all(v[2] is None for v in products(world).values())  # kategori yazilmadi


@pytest.mark.integration
def test_source_with_aliexpress_equivalent_rights_publishes_as_before(
    world, map_file, monkeypatch, _foreign_approved
):
    rights = UsageRights(
        data_license="affiliate_terms",
        may_store_prices=True,
        may_display_prices=True,
        foreign_currency_display=True,
    )
    _register(monkeypatch, _definition(SLUG, rights=rights, source_parent_map=True))
    seed(world)
    result = run(world, map_file)
    assert {s.name: s.status for s in result.stages}["publish"] == "success"
    assert any(v[0] == "published" for v in products(world).values())


@pytest.mark.integration
def test_gate_cursor_and_rescan_are_scoped_per_merchant(world):
    def add(detail: dict) -> None:
        with _owner() as owner, owner.cursor() as cur:
            cur.execute(
                """INSERT INTO job_run (job, status, finished_at, detail)
                   VALUES ('catalog_auto', 'success', now(), %s::jsonb)""",
                (json.dumps(detail),),
            )
            owner.commit()

    with _owner() as owner, owner.cursor() as cur:
        cur.execute("SELECT count(*) FROM job_run WHERE job = 'catalog_auto'")
        before = cur.fetchone()[0]
    if before:
        pytest.skip("yerel veritabaninda baska catalog_auto kayitlari var")
    try:
        add({"gate_cursor": 111, "rescan": True})  # eski kayit: merchant yok -> aliexpress
        add({"gate_cursor": 222, "rescan": False, "merchant": "magaza-b"})
        with _owner() as conn:
            assert auto_mod.previous_gate_cursor(conn) == 111
            assert auto_mod.previous_gate_cursor(conn, "aliexpress") == 111
            assert auto_mod.previous_gate_cursor(conn, "magaza-b") == 222
            assert auto_mod.previous_gate_cursor(conn, "magaza-c") == 0
            assert auto_mod.rescan_due(conn, 7, "aliexpress") is False
            assert auto_mod.rescan_due(conn, 7, "magaza-b") is True  # hic tam tarama yok
    finally:
        with _owner() as owner, owner.cursor() as cur:
            cur.execute("DELETE FROM job_run WHERE job = 'catalog_auto'")
            owner.commit()
    assert fetch("SELECT 1")  # baglanti sagligi
