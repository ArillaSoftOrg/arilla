"""Ortak veri sozlesmesi: her kaynak (API, XML, CSV, JSON, besleme) buna donusur.

Kimlik ayrimi (karar 0163):

- **platform**: `merchant.slug` (Trendyol, Hepsiburada, AliExpress). Pazar yeri ya da magaza.
- **seller**: platform ICINDEKI satici (`seller` tablosu). Tek satici platformlarda yok.
- **listing**: platformun urun/ilan kimligi. Ayni listing'i birden cok satici satabilir.
- **offer**: (platform, listing, seller) ucluusu = `offer` satiri. Fiyat ve stok gecmisi
  teklife aittir; urune degil.

`offer.external_id` UNIQUE (merchant_id, external_id) oldugundan, cok saticili pazar
yerlerinde external_id satici bilgisini de tasimalidir (`offer_key`).
"""

from __future__ import annotations

import re
from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal, Protocol, runtime_checkable

SourceKind = Literal["api", "xml", "csv", "json", "feed"]
#: `listing`: external_id ilan kimligidir (tek satici / ilan = teklif).
#: `listing_seller`: external_id = "<ilan>~<satici>" (ayni ilani birden cok satici satar).
OfferKeyScheme = Literal["listing", "listing_seller"]

_SLUG = re.compile(r"^[a-z0-9][a-z0-9_-]{1,39}$")
_ID = re.compile(r"^[^\s~]{1,100}$")
_CURRENCY = re.compile(r"^[A-Z]{3}$")
KEY_SEPARATOR = "~"


def offer_key(scheme: OfferKeyScheme, listing_id: str, seller_id: str | None) -> str:
    """`offer.external_id` degeri. Ayni girdi her zaman ayni anahtari verir."""
    if not _ID.match(listing_id):
        raise ValueError("listing_id bos, bosluklu ya da ayiracli olamaz")
    if scheme == "listing":
        return listing_id
    if seller_id is None or not _ID.match(seller_id):
        raise ValueError("listing_seller semasi gecerli bir seller_id ister")
    return f"{listing_id}{KEY_SEPARATOR}{seller_id}"


def split_offer_key(key: str) -> tuple[str, str | None]:
    listing, sep, seller = key.partition(KEY_SEPARATOR)
    return (listing, seller) if sep else (listing, None)


@dataclass(frozen=True)
class CanonicalListing:
    """Bir kaynak ilanin platformdan bagimsiz, DOGRULANMIS hali.

    Yalnizca kaynakta GORULEN alan doludur; olmayan marka/GTIN/varyant uretilmez
    (karar 0012). Fiyat kurus cinsinden tamsayidir, asla float (kural).
    """

    platform: str
    listing_id: str
    title: str
    url: str
    currency: str
    observed_at: datetime
    price: int | None = None
    list_price: int | None = None
    in_stock: bool | None = None  # None = kaynak stok bildirmiyor ("yok" DEGIL)
    seller_id: str | None = None
    seller_name: str | None = None
    brand: str | None = None
    category_path: tuple[str, ...] = ()
    gtin: str | None = None
    mpn: str | None = None
    #: Varyant eksenleri ("renk" -> "siyah"). Kaynak vermiyorsa bos.
    options: Mapping[str, str] = field(default_factory=dict)
    image_urls: tuple[str, ...] = ()
    #: Hata ayiklama izi (dosya:satir, sayfa). Kisisel veri icermez.
    source_ref: str = ""

    def __post_init__(self) -> None:
        if not _SLUG.match(self.platform):
            raise ValueError(f"platform gecersiz: {self.platform!r}")
        if not _ID.match(self.listing_id):
            raise ValueError("listing_id gecersiz")
        if not self.title.strip():
            raise ValueError("title bos")
        if not _CURRENCY.match(self.currency):
            raise ValueError("currency ISO-4217 bicimli degil")
        if self.observed_at.tzinfo is None:
            raise ValueError("observed_at saat dilimli (UTC) olmali")
        for name in ("price", "list_price"):
            value = getattr(self, name)
            if value is not None and (isinstance(value, bool) or not isinstance(value, int)):
                raise TypeError(f"{name} kurus cinsinden int olmali (float yasak)")
            if value is not None and value < 0:
                raise ValueError(f"{name} negatif olamaz")


@dataclass(frozen=True)
class Rejection:
    """Tek kayit normalize edilemedi. Kosuyu durdurmaz; kod sabit kumeden gelir."""

    code: str
    source_ref: str = ""
    detail: str = ""

    def __post_init__(self) -> None:
        if not re.match(r"^[a-z0-9_]{2,60}$", self.code):
            raise ValueError("rejection code kucuk harf/rakam/alt cizgi olmali")


@dataclass(frozen=True)
class Checkpoint:
    """Kaynagin kaldigi yer. Opak: yalnizca adapter yorumlar, kosu yalnizca saklar."""

    cursor: Mapping[str, Any] = field(default_factory=dict)
    #: Bu noktaya kadar islenen kayit sayisi (izleme; dogruluk kaniti degil).
    processed: int = 0


@runtime_checkable
class SourceAdapter(Protocol):
    """Bir platformdan CanonicalListing ya da Rejection akitir.

    Sozlesme:
    - `platform`, `kind` sabittir.
    - `fetch` tembel iterator dondurur (bellege sigmayan kaynaklar icin).
    - Tek bozuk kayit `Rejection` olur, istisna FIRLATMAZ; kaynagin tamami erisilemezse
      (ag, kimlik, sema) istisna firlatir ve kosu o kaynakta durur.
    - Ayni `Checkpoint` ile yeniden cagri ayni kayitlari uretir (idempotent).
    """

    platform: str
    kind: SourceKind

    def fetch(
        self, checkpoint: Checkpoint | None = None
    ) -> Iterator[CanonicalListing | Rejection]: ...
