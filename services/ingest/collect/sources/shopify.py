"""Shopify `/products.json` tasimasi.

Shopify tek bir urun JSON'unda hem renk (tipik olarak `option1`) hem beden
(tipik olarak `option2`) barindirir — bu, `docs/decisions/0005`'in varsaydigi
"renk zaten ayri sayfa" modelini kirar (bkz. `docs/decisions/0024`).

Bu connector bir urunu, `feed_config.transport.shopify.color_option` ayarliysa
o alana gore GRUPLAYIP her renk grubu icin AYRI bir `RawRecord` uretir.
Boylece `normalize()` / `pipeline.py` / `writer.py`'nin "1 ham kayit -> 1
offer" sozlesmesi hic degismez — bolme burada, connector seviyesinde biter.
`color_option` ayarlanmamissa (ya da urun tek renkliyse) tek `RawRecord`
uretilir; bu, diger iki transportla (xml_feed, network_dump) ayni davranistir.

Alan adlari `feed_config.mapping` icinden gelir (docs/decisions/0012): bu
dosya yalnizca Shopify JSON'unun kendine ozgu YAPISINI (renk/beden ic ice
gecmesi, urun basina birden fazla varyant) duzler — hangi duz alanin
"price"/"title" oldugunu SECMEZ, cikardigi `fields`/`groups` de diger iki
transport gibi ham/genel kalir.

Sayfalama Shopify'in eski `/products.json?page=N&limit=M` sozlesimini
kullanir. Kimlik dogrulama gerekmez (herkese acik uc nokta).
"""

from __future__ import annotations

import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any

import httpx

from collect.connector import Connector, register
from collect.records import RawRecord

#: docs/routes.md: "Slug'lar Turkce karakter icermez."
_TR_TRANSLIT = str.maketrans("çÇğĞıİöÖşŞüÜ", "cCgGiIoOsSuU")


def _slugify(value: str) -> str:
    text = value.strip().translate(_TR_TRANSLIT)
    text = "".join(ch.lower() if ch.isalnum() else "-" for ch in text)
    while "--" in text:
        text = text.replace("--", "-")
    return text.strip("-") or "varyant"


def _flatten_scalars(entry: dict[str, Any]) -> dict[str, str]:
    """rest_api.py'deki `fields` ayrimiyla ayni kural: duz skaler alanlar."""
    return {
        key: str(value)
        for key, value in entry.items()
        if value is not None and not isinstance(value, list | dict)
    }


def _price_key(variant: dict[str, Any]) -> float:
    try:
        return float(variant.get("price") or "inf")
    except ValueError:
        return float("inf")


@dataclass
class ShopifyConnector(Connector):
    base_url: str
    config: dict[str, Any] = field(default_factory=dict)
    client: httpx.Client | None = None
    #: Guvenlik freni: rest_api.py'deki ayniyla ayni gerekce.
    max_pages: int = 10_000

    @property
    def _transport(self) -> dict[str, Any]:
        return self.config.get("transport") or {}

    @property
    def _store_root(self) -> str:
        return self.base_url.rsplit("/products.json", 1)[0]

    def _client(self) -> httpx.Client:
        return self.client or httpx.Client(timeout=60.0, follow_redirects=True)

    def fetch(self) -> Iterator[RawRecord]:
        transport = self._transport
        color_option = (transport.get("shopify") or {}).get("color_option")
        page_size = int((transport.get("pagination") or {}).get("size", 50))
        min_interval = 0.0
        rate = (transport.get("rate_limit") or {}).get("requests_per_second")
        if rate:
            min_interval = 1.0 / float(rate)

        client = self._client()
        page = 1
        last_request = 0.0

        for _ in range(self.max_pages):
            if min_interval:
                elapsed = time.monotonic() - last_request
                if elapsed < min_interval:
                    time.sleep(min_interval - elapsed)
            last_request = time.monotonic()

            response = client.get(self.base_url, params={"page": page, "limit": page_size})
            response.raise_for_status()
            products = response.json().get("products") or []
            if not products:
                return

            for product in products:
                yield from self._records_for_product(product, color_option)

            if len(products) < page_size:
                return
            page += 1

        raise RuntimeError(
            f"sayfalama {self.max_pages} sayfada bitmedi — yapilandirma hatasi olabilir"
        )

    def _records_for_product(
        self, product: dict[str, Any], color_option: str | None
    ) -> Iterator[RawRecord]:
        variants = product.get("variants") or []
        if not variants:
            return

        groups: dict[Any, list[dict[str, Any]]] = {}
        for variant in variants:
            key = variant.get(color_option) if color_option else None
            groups.setdefault(key, []).append(variant)

        multi = len(groups) > 1
        for color, group_variants in groups.items():
            yield self._record_for_group(
                product=product,
                color=color if multi else None,
                group_variants=group_variants,
            )

    def _record_for_group(
        self,
        *,
        product: dict[str, Any],
        color: Any | None,
        group_variants: list[dict[str, Any]],
    ) -> RawRecord:
        # Temsili varyant: bu renk grubundaki EN DUSUK fiyatli. price/list_price/
        # image_url ayni varyanttan gelir ki tutarli olsun (bkz. docs/decisions/0024).
        representative = min(group_variants, key=_price_key)

        handle = product.get("handle") or ""
        product_id = product.get("id")
        external_id = str(product_id)
        url = f"{self._store_root}/products/{handle}"
        if color is not None:
            external_id = f"{product_id}-{_slugify(str(color))}"
            variant_id = representative.get("id")
            if variant_id is not None:
                url = f"{url}?variant={variant_id}"

        images = product.get("images") or []
        fallback_image = images[0].get("src") if images and isinstance(images[0], dict) else None
        image_url = (representative.get("featured_image") or {}).get("src") or fallback_image

        # Carpisan anahtarlarda (id, title, created_at, updated_at) URUN
        # kazanir — varyantin kendi "title"i (orn. "Defne Yesili / S") urun
        # basligini ezmemeli. Varyanta ozgu alanlar (price, sku, option*,
        # available, compare_at_price...) hic carpismadigi icin oldugu gibi gecer.
        fields = {**_flatten_scalars(representative), **_flatten_scalars(product)}
        fields["external_id"] = external_id
        fields["url"] = url
        if image_url:
            fields["image_url"] = str(image_url)
        if color is not None:
            fields["color"] = str(color)

        variant_entries = tuple(_flatten_scalars(variant) for variant in group_variants)

        return RawRecord(
            fields=fields,
            source_ref=f"shopify urun {product_id} renk {color or '-'}",
            groups={"variants": variant_entries},
        )


register("shopify", lambda url, config: ShopifyConnector(base_url=url or "", config=config))
