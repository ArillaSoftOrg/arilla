"""Gercek ornekle DOGRULANMIS program profilleri (karar 0112).

Profil yalnizca kaynakta GORULEN alanlari esler. Yeni profil eklemeden once
gercek besleme ornegi incelenir; tahmini alan adi yazilmaz (karar 0012).

admitad:6115 (AliExpress WW), 14 Ekim 2026 ornegi (feed 14267, ilk 137 kayit):
YML; `offer@id` 16 haneli AliExpress urun kimligi; `name`, `price`,
`oldprice`, `currencyId` (yalnizca USD), `categoryId` (+ `<categories>`
agaci), `picture` (en fazla 7), `param`: `shopId` (magaza), `discount`,
`commissionRate`. `url` Admitad izleme baglantisi; gercek urun adresi
`ulp` -> `dl_target_url` (www.aliexpress.com/item/<id>.html).
GTIN, marka, SKU/varyant, stok ve kargo YOK.
"""

from __future__ import annotations

from typing import Any

from platforms import registry

PROFILES: dict[str, dict[str, Any]] = {
    "admitad:6115": {
        "parser": "yml",
        "url_unwrap": ["ulp", "dl_target_url"],
        "url_hosts": ["aliexpress.com"],
        # Beslemedeki takip baglantisinin hostu (14 Ekim 2026 ornegi).
        "affiliate_hosts": ["rzekl.com"],
        "mapping": {"seller": "param.shopId"},
        "keep_params": ["discount", "commissionRate"],
        # Gosterilen 3 gorsel; fazlasi saklanmaz (WAL/disk, karar 0114).
        "max_images": 3,
        "required_fields": ["@id", "name", "url", "price", "currencyId"],
    },
}


def profile_for(network: str, program_external_id: str | None) -> dict[str, Any]:
    if not program_external_id:
        return {}
    return dict(PROFILES.get(f"{network}:{program_external_id}", {}))


#: Profil anahtari (`ag:program`) -> kaynak. Merchant alanlari `platforms.registry` kaydindan
#: TUREtilir (karar 0164): kaynak bilgisi tek yerde. Anahtarlar `feeds __main__ ensure-merchant`
#: komutunun `--profile` degeridir. Takip sablonlari: AliExpress `rzekl.com/g/<kod>/?subid=
#: <tiklama>&ulp=<urun>` (Admitad deeplink API, 14 Ekim 2026; subid click kimligi, kural 8);
#: Hepsiburada (karar 0115) ve Trendyol (karar 0118) yonetici toplamasidir, affiliate yok.
PROFILE_SOURCES: dict[str, str] = {
    "admitad:6115": "aliexpress",
    "hbcollect:hepsiburada": "hepsiburada",
    "tycollect:trendyol": "trendyol",
}


def _merchant_profile(slug: str) -> dict[str, Any]:
    merchant = registry.ALL[slug].merchant
    return {
        "slug": slug,
        "name": merchant.name,
        "domain": merchant.domain,
        "source_type": merchant.source_type,
        "affiliate_network": merchant.affiliate_network,
        "affiliate_status": merchant.affiliate_status,
        "deeplink_template": merchant.deeplink_template,
    }


MERCHANT_PROFILES: dict[str, dict[str, Any]] = {
    key: _merchant_profile(slug) for key, slug in PROFILE_SOURCES.items()
}
