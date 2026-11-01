"""Kaynak bazli otomatik hat plani (karar 0164): kayit defterindeki kisitlar NEREDE uygulanir.

Yalnizca bugun gercekten UYGULANAN kisitlar baglanir; digerleri (istek sinirlari, yenileme
araligi, saklama) bu hatta uygulanmaz ve burada varsayilmaz:

* `update.max_price_age`  -> `stale_days` UST SINIRI (yayin tazeligi). Yalniz SIKILASTIRIR:
  istenen deger kayittan buyukse kayit degeri kullanilir, kucukse istenen kalir.
* `rights.foreign_currency_display` -> `allow_foreign`. Yalniz KISAR: kayit izin vermiyorsa
  `--allow-foreign` verilse de yurt disi urun yayinlanmaz. (Ayrica
  `CATALOG_PUBLISH_FOREIGN_APPROVED` gerekliligi aynen surer.)
* `rights.may_store_prices` ve `may_display_prices` -> `publish` adimi. Kapaliysa urun
  taslak/hazir kalir, YAYINLANMAZ.
* `source_parent_map` -> `parents` adimi. Harita bu kaynagin yollariyla uretilmediyse atlanir.

Kayitsiz kaynak (registry'de yok) eski davranisi korur: kisit uygulanmaz, `registered=False`.
Kimlik kurali yoksa zaten `source_policy_missing` ile hicbir urun acilmaz.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING

from platforms import registry

if TYPE_CHECKING:
    from catalog_build.auto import AutoOptions


@dataclass(frozen=True)
class SourcePlan:
    merchant: str
    registered: bool
    #: Yayin tazeligi ust siniri (gun); None = kayit siniri yok.
    max_stale_days: int | None
    foreign_display: bool
    may_publish: bool
    run_parents: bool
    #: Uygulanan sikilastirmalarin kisa kodlari (log/`job_run` icin).
    notes: tuple[str, ...] = ()


def plan_for(merchant: str) -> SourcePlan:
    definition = registry.get(merchant)
    if definition is None:
        # Eski davranis: kayitsiz kaynakta kisit yok (hat kimlik kurali olmadan urun acmaz).
        return SourcePlan(merchant, False, None, True, True, True)
    rights = definition.constraints.rights
    max_age = definition.constraints.update.max_price_age
    return SourcePlan(
        merchant=merchant,
        registered=True,
        max_stale_days=max(1, math.ceil(max_age.total_seconds() / 86_400)),
        foreign_display=rights.foreign_currency_display,
        may_publish=rights.may_store_prices and rights.may_display_prices,
        run_parents=definition.source_parent_map,
    )


def effective_options(opts: AutoOptions, plan: SourcePlan) -> tuple[AutoOptions, SourcePlan]:
    """Istenen secenekleri kaynak planiyla SIKILASTIRIR; asla gevsetmez."""
    notes: list[str] = []
    stale = opts.stale_days
    if plan.max_stale_days is not None and stale > plan.max_stale_days:
        stale = plan.max_stale_days
        notes.append(f"stale_days_capped_{stale}")
    allow_foreign = opts.allow_foreign
    if allow_foreign and not plan.foreign_display:
        allow_foreign = False
        notes.append("foreign_not_permitted")
    if not plan.may_publish:
        notes.append("publish_not_permitted")
    if not plan.run_parents:
        notes.append("no_parent_map")
    return (
        replace(opts, stale_days=stale, allow_foreign=allow_foreign),
        replace(plan, notes=tuple(notes)),
    )
