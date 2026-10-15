"""`PriceVerificationProvider` arayuzu ve izinli saglayicilar (karar 0113).

Bir saglayici, bir teklifin fiyatini besleme DISINDAKI izinli bir kaynaktan
okur. Izin sarti: kaynagin herkese acik ve robots.txt'nin izin verdigi bir
ucu ya da sozlesmeli API'si. Erisim engelini asmak, robots/ToS ihlali ve
izinsiz kazima YOKTUR: 401/403/429 ya da robots yasagi -> durulur.

Saglayicilar:

- `shopify_product_js`: magazanin kendi vitrin JSON'u (`/products/<handle>.js`);
  repoda kimlik zenginlestirmesi icin zaten kullaniliyor (karar 0034/0036).
  Para birimi yalnizca merchant icin DOGRULANMIS ise (`feed_config.currency_verified`)
  sonuc yazilir; yoksa saglayici desteklemez.

AliExpress icin izinli canli kaynak yok (Admitad yayinci API'si urun fiyati
dondurmuyor; AliExpress affiliate API'si ayri anahtar ve sozlesme ister):
istek `unsupported` olur, sahte sonuc uretilmez.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol
from urllib.parse import urlsplit

import httpx

from collect.link.robots import USER_AGENT, RobotsCache, RobotsDisallowed

MIN_INTERVAL_SECONDS = 2.0


@dataclass(frozen=True)
class OfferContext:
    offer_id: int
    merchant_id: int
    merchant_slug: str
    source_type: str
    url: str
    currency: str
    feed_price_minor: int | None
    feed_list_price_minor: int | None
    currency_verified: bool
    seller_id: int | None = None
    #: Offer'in kendi varyantlarinin kaynak kimlikleri (Shopify: varyant id).
    #: Shopify offer'i renk grubudur; karsilastirma yalnizca bu varyantlarla yapilir.
    variant_external_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class Outcome:
    result: Literal["match", "mismatch", "unavailable", "error"]
    currency: str | None = None
    observed_price_minor: int | None = None
    list_price_minor: int | None = None
    in_stock: bool | None = None
    shipping_minor: int | None = None
    tax_included: bool | None = None
    discount_conditions: dict[str, Any] | None = None
    coupon_conditions: dict[str, Any] | None = None
    error_code: str | None = None


class ProviderStop(Exception):
    """Kaynak erisimi reddetti (401/403/429, robots): bu kosuda o hosta istek yok."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class PriceVerificationProvider(Protocol):
    name: str
    source_kind: Literal["merchant_storefront", "merchant_api", "affiliate_api"]
    reliability: int

    def supports(self, offer: OfferContext) -> bool: ...

    def verify(self, offer: OfferContext) -> Outcome: ...


def _compare(feed: int | None, observed: int) -> Literal["match", "mismatch"]:
    return "match" if feed is not None and feed == observed else "mismatch"


@dataclass
class ShopifyProductJs:
    """Magazanin kendi vitrin JSON'u. Fiyatlar kurus (tamsayi)."""

    client: httpx.Client | None = None
    robots: RobotsCache = field(default_factory=RobotsCache)
    sleep: Callable[[float], None] = time.sleep
    name: str = "shopify_product_js"
    source_kind: Literal["merchant_storefront"] = "merchant_storefront"
    reliability: int = 90
    _last: dict[str, float] = field(default_factory=dict)
    _stopped: set[str] = field(default_factory=set)

    def _http(self) -> httpx.Client:
        if self.client is None:
            self.client = httpx.Client(
                timeout=20.0, follow_redirects=True, headers={"User-Agent": USER_AGENT}
            )
        return self.client

    def supports(self, offer: OfferContext) -> bool:
        parts = urlsplit(offer.url)
        return (
            offer.source_type == "shopify"
            and offer.currency_verified
            and parts.scheme == "https"
            and "/products/" in parts.path
        )

    def verify(self, offer: OfferContext) -> Outcome:
        parts = urlsplit(offer.url)
        origin = f"{parts.scheme}://{parts.netloc}"
        if origin in self._stopped:
            raise ProviderStop("host_stopped")
        handle_path = parts.path.rstrip("/")
        js_url = f"{origin}{handle_path}.js"
        try:
            self.robots.check(origin, js_url)
        except RobotsDisallowed:
            self._stopped.add(origin)
            raise ProviderStop("robots_disallowed") from None
        interval = max(MIN_INTERVAL_SECONDS, self.robots.crawl_delay(origin) or 0.0)
        wait = interval - (time.monotonic() - self._last.get(origin, 0.0))
        if wait > 0:
            self.sleep(wait)
        self._last[origin] = time.monotonic()
        try:
            response = self._http().get(js_url)
        except httpx.HTTPError:
            return Outcome("error", error_code="network")
        if response.status_code in (401, 403, 429):
            self._stopped.add(origin)
            raise ProviderStop(f"http_{response.status_code}")
        if response.status_code == 404:
            return Outcome("unavailable", error_code="not_found")
        if response.status_code != 200:
            return Outcome("error", error_code=f"http_{response.status_code}")
        try:
            product = response.json()
        except ValueError:
            return Outcome("error", error_code="invalid_json")
        variants = [
            v
            for v in product.get("variants") or []
            if isinstance(v, dict) and isinstance(v.get("price"), int)
        ]
        if offer.variant_external_ids:
            wanted = set(offer.variant_external_ids)
            variants = [v for v in variants if str(v.get("id")) in wanted]
        if not variants:
            return Outcome("unavailable", currency=offer.currency, error_code="variant_missing")
        # Yazici ile ayni kural: temsili fiyat gruptaki EN DUSUK varyant fiyati.
        cheapest = min(variants, key=lambda v: int(v["price"]))
        observed = int(cheapest["price"])
        compare_at = cheapest.get("compare_at_price")
        list_price = (
            int(compare_at) if isinstance(compare_at, int) and compare_at > observed else None
        )
        in_stock = any(bool(v.get("available")) for v in variants)
        return Outcome(
            _compare(offer.feed_price_minor, observed),
            currency=offer.currency,
            observed_price_minor=observed,
            list_price_minor=list_price,
            in_stock=in_stock,
        )


def default_providers() -> list[PriceVerificationProvider]:
    return [ShopifyProductJs()]
