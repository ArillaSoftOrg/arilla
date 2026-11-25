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

from catalog_build.gate import PUBLISH_STALE_DAYS
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
    return SourcePlan(
        merchant=merchant,
        registered=True,
        max_stale_days=_days(definition),
        foreign_display=rights.foreign_currency_display,
        may_publish=rights.may_store_prices and rights.may_display_prices,
        run_parents=definition.source_parent_map,
    )


def _days(definition: registry.SourceDefinition) -> int:
    return max(1, math.ceil(definition.constraints.update.max_price_age.total_seconds() / 86_400))


def stale_days_map(requested: int | None) -> dict[str, int]:
    """Kayitli kaynak -> etkin tazelik gunu (karar 0220; `gate`/`publish` SQL'ine jsonb gider).

    `requested` None: kaynagin kendi siniri (`max_price_age`). Verildiyse ikisinin kucugu:
    acik bir deger kaynak sinirini asla GEVSETMEZ. Kayitsiz kaynak haritada yoktur (eski
    davranis: `requested` ya da varsayilan 2 gun).
    """
    out: dict[str, int] = {}
    for slug, definition in registry.all_definitions().items():
        cap = _days(definition)
        out[slug] = cap if requested is None else max(1, min(requested, cap))
    return out


def effective_options(opts: AutoOptions, plan: SourcePlan) -> tuple[AutoOptions, SourcePlan]:
    """Istenen secenekleri kaynak planiyla SIKILASTIRIR; asla gevsetmez."""
    notes: list[str] = []
    stale = opts.stale_days
    if stale is None:
        # Karar 0220: acik deger yoksa kaynagin kendi siniri (kayitsizsa eski varsayilan).
        stale = plan.max_stale_days or PUBLISH_STALE_DAYS
    elif plan.max_stale_days is not None and stale > plan.max_stale_days:
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
