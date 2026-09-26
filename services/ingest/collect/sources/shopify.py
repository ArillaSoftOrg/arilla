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

#: Gecici sayilan yanitlar. 4xx'in geri kalani (403 bot korumasi dahil)
#: tekrar denenmez: engellendiysek israr etmeyiz.
_RETRYABLE_STATUS = frozenset({429, 500, 502, 503, 504})

#: `transport.shopify.max_products` yoksa magaza basina kanonik urun tavani
#: (0023: merchant basina 20-30 urun). Bootstrap bunu acikca yukseltir (0027).
DEFAULT_MAX_PRODUCTS = 30

#: Kabul edilen en buyuk tavan: 0027'nin TOPLAM sert tavani
#: (`collect/bootstrap.HARD_CAP`). Tek magaza bunu asamaz.
MAX_PRODUCTS_LIMIT = 3500


def parse_max_products(raw: Any) -> int:
    """`transport.shopify.max_products` -> pozitif tamsayi.

    Yoksa `DEFAULT_MAX_PRODUCTS`. Yalnizca JSON tamsayisi kabul edilir:
    `"30"`, `30.5`, `true`, `0` ya da negatif deger yapilandirma hatasidir —
    tavan sessizce kalkmaz, kosu magazaya istek atmadan `failed` biter.
    """
    if raw is None:
        return DEFAULT_MAX_PRODUCTS
    if isinstance(raw, bool) or not isinstance(raw, int) or not 1 <= raw <= MAX_PRODUCTS_LIMIT:
        raise ValueError(
            f"transport.shopify.max_products gecersiz: {raw!r} "
            f"(1..{MAX_PRODUCTS_LIMIT} arasi tamsayi olmali)"
        )
    return raw


def _slugify(value: str) -> str:
    text = value.strip().translate(_TR_TRANSLIT)
    text = "".join(ch.lower() if ch.isalnum() else "-" for ch in text)
    while "--" in text:
        text = text.replace("--", "-")
    return text.strip("-") or "varyant"


def _option_key(name: str) -> str:
    """'Kumaş' -> 'kumas', 'Beden ' -> 'beden': secenek adlari karsilastirmasi."""
    return name.strip().translate(_TR_TRANSLIT).lower()


def _option_by_name(product: dict[str, Any], names: list[str] | None) -> str | None:
    """Urunun `options` listesinde adi `names` icinde olan ilk secenegin
    varyant alani (`option1`..`option3`). Shopify secenek SIRASI magazaya
    gore degisir (Casadora'da option1 beden, Derimod'da renk); ad degismez.
    """
    if not names:
        return None
    wanted = {_option_key(name) for name in names}
    for index, option in enumerate(product.get("options") or [], start=1):
        if isinstance(option, dict) and _option_key(str(option.get("name") or "")) in wanted:
            return f"option{index}"
    return None


def _flatten_scalars(entry: dict[str, Any]) -> dict[str, str]:
    """rest_api.py'deki `fields` ayrimiyla ayni kural: duz skaler alanlar."""
    return {
        key: str(value)
        for key, value in entry.items()
        if value is not None and not isinstance(value, list | dict)
    }


def _with_size(
    entry: dict[str, str], variant: dict[str, Any], size_option: str | None
) -> dict[str, str]:
    """Beden secenegi ADIYLA bulunduysa degeri `size` alanina da yazilir ki
    esleme (`variants.size = "size"`) magazanin secenek sirasindan bagimsiz
    olsun. Bulunamadiysa alan eklenmez: beden olmayan bir secenek (ayak tipi,
    kapasite) beden diye yazilmaz."""
    if size_option and variant.get(size_option) is not None:
        return {**entry, "size": str(variant[size_option])}
    return entry


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
    #: Kanonik urun tavani; `config`'ten `__post_init__` icinde okunur.
    max_products: int = field(init=False, default=DEFAULT_MAX_PRODUCTS)

    def __post_init__(self) -> None:
        # Kurulumda dogrulanir: gecersiz tavan ilk istekten ONCE patlar.
        shopify = self._transport.get("shopify") or {}
        self.max_products = parse_max_products(shopify.get("max_products"))

    @property
    def _transport(self) -> dict[str, Any]:
        return self.config.get("transport") or {}

    @property
    def _store_root(self) -> str:
        return self.base_url.rsplit("/products.json", 1)[0]

    def _client(self) -> httpx.Client:
        return self.client or httpx.Client(timeout=60.0, follow_redirects=True)

    def _get(self, client: httpx.Client, params: dict[str, Any]) -> httpx.Response:
        """Tek sayfa istegi; yalnizca gecici hatalarda sinirli, ussel geri cekilme.

        `transport.retry.max_retries` varsayilani 0: ayar yoksa davranis
        eskisiyle ayni (tek deneme, docs/decisions/0023). 429'da magazanin
        `Retry-After` degeri dinlenir ama `max_backoff_seconds` ile sinirlanir.
        """
        retry = self._transport.get("retry") or {}
        max_retries = int(retry.get("max_retries", 0))
        backoff = float(retry.get("backoff_seconds", 2.0))
        max_backoff = float(retry.get("max_backoff_seconds", 30.0))

        for attempt in range(max_retries + 1):
            delay = backoff * (2**attempt)
            try:
                response = client.get(self.base_url, params=params)
            except httpx.TransportError:
                if attempt >= max_retries:
                    raise
            else:
                if response.status_code not in _RETRYABLE_STATUS or attempt >= max_retries:
                    response.raise_for_status()
                    return response
                retry_after = response.headers.get("Retry-After", "")
                if response.status_code == 429 and retry_after.isdigit():
                    delay = max(delay, float(retry_after))
            time.sleep(min(delay, max_backoff))
        raise AssertionError("unreachable")

    def fetch(self) -> Iterator[RawRecord]:
        transport = self._transport
        shopify = transport.get("shopify") or {}
        color_option = shopify.get("color_option")
        # Ada gore secim, konuma gore secimden onceliklidir (bkz. _option_by_name).
        color_names = shopify.get("color_option_names")
        size_names = shopify.get("size_option_names")
        # Kanonik Shopify urunu sayisi (renk bolmesinden ONCE). Her zaman
        # vardir: ayar yoksa 30 (0023), bootstrap acikca yukseltir (0027).
        max_products = self.max_products
        # Tavandan buyuk sayfa istemenin anlami yok. Sayfa boyu kosu boyunca
        # SABIT kalmali (`page=N` ofseti ona gore hesaplanir), bu yuzden
        # yalnizca en basta kisilir.
        page_size = min(int((transport.get("pagination") or {}).get("size", 50)), max_products)
        min_interval = 0.0
        rate = (transport.get("rate_limit") or {}).get("requests_per_second")
        if rate:
            min_interval = 1.0 / float(rate)

        client = self._client()
        page = 1
        last_request = 0.0
        products_seen = 0

        for _ in range(self.max_pages):
            if min_interval:
                elapsed = time.monotonic() - last_request
                if elapsed < min_interval:
                    time.sleep(min_interval - elapsed)
            last_request = time.monotonic()

            response = self._get(client, {"page": page, "limit": page_size})
            products = response.json().get("products") or []
            if not products:
                return

            for product in products:
                if products_seen >= max_products:
                    return
                products_seen += 1
                yield from self._records_for_product(
                    product,
                    _option_by_name(product, color_names) if color_names else color_option,
                    _option_by_name(product, size_names),
                )

            if len(products) < page_size:
                return
            if products_seen >= max_products:
                return
            page += 1

        raise RuntimeError(
            f"sayfalama {self.max_pages} sayfada bitmedi — yapilandirma hatasi olabilir"
        )

    def _records_for_product(
        self,
        product: dict[str, Any],
        color_option: str | None,
        size_option: str | None = None,
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
                size_option=size_option,
            )

    def _record_for_group(
        self,
        *,
        product: dict[str, Any],
        color: Any | None,
        group_variants: list[dict[str, Any]],
        size_option: str | None = None,
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

        variant_entries = tuple(
            _with_size(_flatten_scalars(variant), variant, size_option)
            for variant in group_variants
        )

        return RawRecord(
            fields=fields,
            source_ref=f"shopify urun {product_id} renk {color or '-'}",
            groups={"variants": variant_entries},
        )


register("shopify", lambda url, config: ShopifyConnector(base_url=url or "", config=config))
