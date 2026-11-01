"""Kaynak (platform) kayit defteri: bir platformu tanimlayan TEK yer (karar 0163).

Daha once kaynak bilgisi uc yere dagiliydi: kimlik kurali (`catalog_build/policy.py`),
besleme profili (`feeds/profiles.py`) ve para birimi/yenileme ayarlari. Burada tek kayitta
toplanir; `catalog_build.policy.POLICIES` buradan TUREtilir, kod degismez.

Yeni platform ekleme: `SourceDefinition` yaz, `register` et, adapter yaz (bkz.
`docs/platform-onboarding.md`). Ortak motora dokunulmaz.

`status`:
- `verified`: gercek ornekle dogrulanmis kimlik kurali; urun hattina girebilir.
- `sample`: yalnizca ornek veriyle yazilmis; gercek erisim/kimlik kurali DOGRULANMADI.
  Kapi/yayin hattina GIRMEZ (`catalog_policies` bunlari dondurmez).
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import timedelta
from typing import Literal

from platforms.constraints import (
    RetentionPolicy,
    SourceConstraints,
    UpdateLimits,
    UsageRights,
)
from platforms.contract import OfferKeyScheme, SourceKind

SourceStatus = Literal["verified", "sample"]
MerchantSourceType = Literal["xml_feed", "api", "affiliate_network", "user_discovered", "shopify"]

_SLUG = re.compile(r"^[a-z0-9][a-z0-9_-]{1,39}$")

#: Hepsiburada urun adresi: `/<slug>-p-<KOD>` (varyant) ya da `/<slug>-pm-<KOD>` (model).
#: Iki tur AYRI kimliktir; aralarindaki iliski dogrulanmadi (karar 0130).
HEPSIBURADA_URL = re.compile(
    r"^https://www\.hepsiburada\.com/[^/?#\s]+-(?:p|pm)-([A-Za-z0-9]{3,60})$"
)
_HEPSIBURADA_KIND = re.compile(r"-(p|pm)-[A-Za-z0-9]{3,60}$")


def hepsiburada_code_kind(url: str) -> str | None:
    """`p` (varyant adresi) / `pm` (model adresi); urun adresi degilse None."""
    match = _HEPSIBURADA_KIND.search(url)
    return match.group(1) if match else None


@dataclass(frozen=True)
class IdentityRule:
    """Kaynak ilan kimligi kurali (`offer.external_id` ve kanonik `offer.url`)."""

    id_pattern: re.Pattern[str]
    #: ILK grup kaynak kimligidir ve `external_id` ile AYNI olmali.
    url_pattern: re.Pattern[str]
    #: Fiyatsiz kesif defteri kaynagi (`catalog_discovery.source`, karar 0130).
    discovery_source: str | None = None
    #: Adresten kimlik TURU (or. Hepsiburada `p`/`pm`).
    url_kind: Callable[[str], str | None] | None = None


@dataclass(frozen=True)
class MerchantInfo:
    """`merchant` satirinin kaynaktan gelen alanlari."""

    name: str
    domain: str
    source_type: MerchantSourceType
    affiliate_network: str | None = None
    affiliate_status: Literal["none", "pending", "active", "suspended"] = "none"
    deeplink_template: str | None = None


@dataclass(frozen=True)
class SourceDefinition:
    slug: str
    kind: SourceKind
    merchant: MerchantInfo
    constraints: SourceConstraints
    status: SourceStatus = "sample"
    offer_key_scheme: OfferKeyScheme = "listing"
    identity: IdentityRule | None = None
    #: Kaynagin ONAYLI para birimi; yoksa kosu para birimi uydurmaz (karar 0029).
    currency: str | None = None
    #: True: urun YALNIZCA kaynak ilani hattindan acilir (taslak -> kapi -> yayin) ve
    #: puanli cozumleyici bu magazanin tekliflerinden urun acmaz (karar 0130).
    listing_only: bool = False
    #: Kategori sistemi: `external_category_reference.source` degeri (varsa).
    category_system: str | None = None
    #: Pazar yeri mi (birden cok satici) — `seller` kaydi beklenir.
    is_marketplace: bool = False
    notes: str = ""

    def __post_init__(self) -> None:
        if not _SLUG.match(self.slug):
            raise ValueError(f"slug gecersiz: {self.slug!r}")
        if self.listing_only and self.identity is None:
            raise ValueError("listing_only kaynak icin identity kurali gerekir")
        if self.status == "verified" and self.identity is None:
            raise ValueError("verified kaynak identity kuralsiz olamaz")
        if self.currency is not None and not re.match(r"^[A-Z]{3}$", self.currency):
            raise ValueError("currency ISO-4217 olmali")
        if self.is_marketplace and self.offer_key_scheme == "listing":
            # Pazar yerinde ayni ilani birden cok satici satar: anahtar saticiyi tasimali.
            raise ValueError("pazar yeri kaynagi listing_seller anahtar semasi ister")


_REGISTRY: dict[str, SourceDefinition] = {}


def register(definition: SourceDefinition) -> SourceDefinition:
    if definition.slug in _REGISTRY:
        raise ValueError(f"kaynak zaten kayitli: {definition.slug}")
    _REGISTRY[definition.slug] = definition
    return definition


def get(slug: str) -> SourceDefinition | None:
    return _REGISTRY.get(slug)


def all_definitions() -> dict[str, SourceDefinition]:
    return dict(_REGISTRY)


def catalog_definitions() -> dict[str, SourceDefinition]:
    """Kapi/yayin hattina girebilen (dogrulanmis kimlik kurali olan) kaynaklar."""
    return {
        slug: d
        for slug, d in _REGISTRY.items()
        if d.status == "verified" and d.identity is not None
    }


def listing_only_slugs() -> frozenset[str]:
    return frozenset(s for s, d in catalog_definitions().items() if d.listing_only)


def onboarding_problems(definition: SourceDefinition) -> list[str]:
    """Yeni kaynak kaydi icin otomatik kontrol listesi. Bos liste = hazir."""
    problems: list[str] = []
    rights = definition.constraints.rights
    if rights.data_license == "unknown":
        problems.append("data_license_unknown")
    if definition.status == "verified":
        if definition.identity is None:
            problems.append("identity_missing")
        if definition.currency is None:
            problems.append("currency_unverified")
    if definition.is_marketplace and definition.offer_key_scheme != "listing_seller":
        problems.append("marketplace_needs_listing_seller_key")
    if rights.may_display_prices and not rights.may_store_prices:
        problems.append("display_without_store")
    return problems


# --------------------------------------------------------------------------
# Kayitlar. AliExpress ve Hepsiburada degerleri mevcut koddan TASINDI (davranis ayni).
# --------------------------------------------------------------------------

# Admitad:6115 profili (karar 0112): offer@id = 16 haneli urun kimligi; besleme gunde iki
# kez kosar, fiyat 2 gunden eskiyse yayina alinmaz (karar 0160). Fiyat USD.
ALIEXPRESS = register(
    SourceDefinition(
        slug="aliexpress",
        kind="feed",
        status="verified",
        listing_only=True,
        currency="USD",
        merchant=MerchantInfo(
            name="AliExpress",
            domain="aliexpress.com",
            source_type="affiliate_network",
            affiliate_network="admitad",
            affiliate_status="active",
            deeplink_template="{affiliate_url}&subid={click_id}",
        ),
        identity=IdentityRule(
            id_pattern=re.compile(r"^[0-9]{10,20}$"),
            url_pattern=re.compile(
                r"^https://(?:www\.|[a-z]{2}\.)?aliexpress\.com/item/([0-9]{10,20})\.html$"
            ),
        ),
        constraints=SourceConstraints(
            rights=UsageRights(
                data_license="affiliate_terms",
                may_store_prices=True,
                may_display_prices=True,
                may_hotlink_images=True,
                may_mirror_images=False,
                may_track_clicks=True,
                foreign_currency_display=True,
            ),
            retention=RetentionPolicy(price_history_days=None),
            update=UpdateLimits(
                min_refresh_interval=timedelta(hours=11),
                max_price_age=timedelta(days=2),
                requests_per_minute=10,
                max_concurrency=2,
                batch_size=5_000,
            ),
        ),
        notes="Admitad:6115 YML; GTIN/marka/varyant yok, ilan = urun (karar 0112).",
    )
)

# Yonetici toplamasi (karar 0115/0117/0130). Kota: gunde 20k / ayda 60k istek (karar 0126).
HEPSIBURADA = register(
    SourceDefinition(
        slug="hepsiburada",
        kind="json",
        status="verified",
        listing_only=True,
        currency="TRY",
        category_system="hepsiburada",
        is_marketplace=False,
        merchant=MerchantInfo(
            name="Hepsiburada",
            domain="hepsiburada.com",
            source_type="user_discovered",
        ),
        identity=IdentityRule(
            id_pattern=re.compile(r"^[A-Za-z0-9]{3,60}$"),
            url_pattern=HEPSIBURADA_URL,
            discovery_source="hepsiburada",
            url_kind=hepsiburada_code_kind,
        ),
        constraints=SourceConstraints(
            rights=UsageRights(
                data_license="operator_collected",
                may_store_prices=True,
                may_display_prices=True,
                may_hotlink_images=True,
                may_track_clicks=True,
            ),
            update=UpdateLimits(
                min_refresh_interval=timedelta(hours=24),
                max_price_age=timedelta(days=2),
                requests_per_minute=20,
                daily_request_budget=20_000,
                max_concurrency=1,
                batch_size=500,
            ),
        ),
        notes="Yonetici tarayicisi toplamasi; resmi API/besleme yok (karar 0115).",
    )
)

# ORNEK: gercek erisim yok (karar 0118: yonetici toplamasi). Kimlik kurali DOGRULANMADI,
# bu yuzden `status="sample"`: adapter uyumluluk testlerinde kullanilir, kapi/yayin
# hattina girmez. Pazar yeridir: ayni urunu birden cok satici satar.
TRENDYOL = register(
    SourceDefinition(
        slug="trendyol",
        kind="api",
        status="sample",
        currency="TRY",
        category_system="trendyol",
        is_marketplace=True,
        offer_key_scheme="listing_seller",
        merchant=MerchantInfo(
            name="Trendyol",
            domain="trendyol.com",
            source_type="user_discovered",
        ),
        constraints=SourceConstraints(
            rights=UsageRights(
                data_license="operator_collected",
                may_store_prices=True,
                may_display_prices=True,
                may_hotlink_images=True,
            ),
            update=UpdateLimits(
                min_refresh_interval=timedelta(hours=24),
                requests_per_minute=20,
                max_concurrency=1,
                batch_size=500,
            ),
        ),
        notes="Ornek tanim; gercek API/kimlik kurali yok (karar 0118).",
    )
)

__all__ = [
    "ALIEXPRESS",
    "HEPSIBURADA",
    "TRENDYOL",
    "HEPSIBURADA_URL",
    "IdentityRule",
    "MerchantInfo",
    "SourceDefinition",
    "all_definitions",
    "catalog_definitions",
    "get",
    "hepsiburada_code_kind",
    "listing_only_slugs",
    "onboarding_problems",
    "register",
]
