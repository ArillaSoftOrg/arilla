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

PROFILES: dict[str, dict[str, Any]] = {
    "admitad:6115": {
        "parser": "yml",
        "url_unwrap": ["ulp", "dl_target_url"],
        "url_hosts": ["aliexpress.com"],
        # Beslemedeki takip baglantisinin hostu (14 Ekim 2026 ornegi).
        "affiliate_hosts": ["rzekl.com"],
        "mapping": {"seller": "param.shopId"},
        "keep_params": ["discount", "commissionRate"],
        "required_fields": ["@id", "name", "url", "price", "currencyId"],
    },
}


def profile_for(network: str, program_external_id: str | None) -> dict[str, Any]:
    if not program_external_id:
        return {}
    return dict(PROFILES.get(f"{network}:{program_external_id}", {}))
