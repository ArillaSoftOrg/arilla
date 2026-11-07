"""Shopify magazalari icin kaynak tanimi uretimi (karar 0164; pilot).

Shopify tek bir platform degil, her magaza ayri bir `merchant`'tir. Bu yuzden kayit
defterine sabit bir "shopify" kaydi eklenmez; magaza basina `SourceDefinition` bu
fonksiyonla uretilir ve modul ice aktarilinca HICBIR sey kaydedilmez
(`registry.catalog_definitions()` degismez, uretim hatti etkilenmez).

Durum her zaman `sample`dir: kimlik kurali (`IdentityRule`) ve veri lisansi
dogrulanmadan kaynak kapi/yayin hattina giremez. Herkese acik `/products.json`
yeniden kullanim izni vermez; bu nedenle `data_license="unknown"` ve fiyat
saklama/gosterme haklari kapali gelir (`onboarding_problems` bunu
`data_license_unknown` olarak raporlar). Hak, magazayla yazili izin ya da affiliate
programiyla belgelenince tanim guncellenir.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import timedelta

from platforms.constraints import SourceConstraints, UpdateLimits, UsageRights
from platforms.registry import MerchantInfo, SourceDefinition

#: Karar 0027/0042: magaza basina <= 0,5 istek/sn, sirali, sayfa 250.
SHOPIFY_UPDATE_LIMITS = UpdateLimits(
    min_refresh_interval=timedelta(hours=24),
    max_price_age=timedelta(days=2),
    requests_per_minute=30,
    max_concurrency=1,
    batch_size=250,
    # Pilot olcumu (7 Kasim): 429 sonrasi kosucunun adapter'i bastan baslatmasi robots ve
    # 1. sayfayi tekrar tekrar istiyordu. Shopify hiz sinirinda kaynak o kosuda DURUR;
    # yeniden deneme yalnizca baglayicinin Retry-After'a uyan kendi denemesidir.
    max_consecutive_errors=1,
)

#: Shopify 429'da `Retry-After: 60` gonderiyor; bekleme bunun altina kirpilmamali
#: (baglayici varsayilani 30 sn idi ve istekler 60 sn dolmadan tekrarlaniyordu).
RETRY_AFTER_CAP_SECONDS = 90.0

#: Pilot tavani: magaza basina en fazla bu kadar kanonik Shopify urunu
#: (`feed_config.transport.shopify.max_products`; renk bolmesinden once sayilir).
PILOT_MAX_PRODUCTS = 500


def shopify_store_definition(
    *, slug: str, name: str, domain: str, notes: str = ""
) -> SourceDefinition:
    """Tek magazanin kaynak tanimi. `domain`: kanitli (meta.json) kanonik host."""
    if "/" in domain or ":" in domain or not domain.strip():
        raise ValueError("domain yalnizca host adi olmali")
    return SourceDefinition(
        slug=slug,
        kind="api",
        status="sample",
        currency="TRY",
        offer_key_scheme="listing",
        merchant=MerchantInfo(name=name, domain=domain, source_type="shopify"),
        constraints=SourceConstraints(
            rights=UsageRights(data_license="unknown"),
            update=SHOPIFY_UPDATE_LIMITS,
        ),
        notes=notes or "Shopify /products.json; izin belgelenmedi (pilot).",
    )


def pilot_feed_config(*, color_option: str | None = None) -> dict[str, object]:
    """Pilot icin `ShopifyConnector` yapilandirmasi (urun tavani 500)."""
    shopify: dict[str, object] = {"max_products": PILOT_MAX_PRODUCTS}
    if color_option:
        shopify["color_option"] = color_option
    return {
        "transport": {
            "shopify": shopify,
            "pagination": {"size": 250},
            "rate_limit": {"requests_per_second": 0.5},
            "retry": {
                "max_retries": 1,
                "backoff_seconds": 5.0,
                "max_backoff_seconds": RETRY_AFTER_CAP_SECONDS,
            },
        }
    }


@dataclass(frozen=True)
class ShopifyStore:
    """Pilot magazasi: kanitli kanonik host ve (varsa) ACIK vendor -> marka eslemesi.

    `vendor_brands` yalnizca kaniti `brand_evidence`'ta yazili ve insan onayli
    eslemeler icindir. Magaza adi kendiliginden marka sayilmaz (`brand_from_vendor`).
    """

    slug: str
    name: str
    domain: str
    vendor_brands: Mapping[str, str] = field(default_factory=dict)
    brand_evidence: str = ""

    def definition(self) -> SourceDefinition:
        return shopify_store_definition(slug=self.slug, name=self.name, domain=self.domain)


#: Yerel pilot magazalari (7 Kasim 2026 yoklamasi: meta.json kimligi, TRY, robots izinli).
PILOT_STORES: tuple[ShopifyStore, ...] = (
    ShopifyStore(
        slug="eubos-turkiye",
        name="Eubos Türkiye",
        domain="eubos-turkiye.myshopify.com",
        vendor_brands={"Eubos Türkiye": "Eubos"},
        brand_evidence=(
            "Tum urunlerde vendor = 'Eubos Turkiye' (41/41); urun serileri (Hyaluron, "
            "Diyabetik Cilt Bakimi) Eubos markasina ait; magaza markanin Turkiye magazasi. "
            "Uretime gecmeden once insan onayi gerekir."
        ),
    ),
    ShopifyStore(
        slug="termos-dunyasi",
        name="Termos Dünyası",
        domain="termos-dunyasi.myshopify.com",
    ),
    ShopifyStore(
        slug="happy-place-home-decor",
        name="Happy Place Home Decor",
        domain="happy-place-home-decor-2.myshopify.com",
    ),
)
