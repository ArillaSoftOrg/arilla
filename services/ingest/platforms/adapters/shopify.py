"""Shopify magazasi -> `CanonicalListing` (karar 0164 sozlesmesi; pilot).

Tasima (robots, sayfalama, yeniden deneme, renk bolmesi) mevcut
`collect.sources.shopify.ShopifyConnector`'dadir ve DEGISMEZ; bu adapter yalnizca onun
urettigi `RawRecord`'u platform bagimsiz sozlesmeye cevirir. Boylece kimlik kurali
eski hatla birebir aynidir: `external_id` = Shopify urun kimligi, renk bolmesinde
`<urun>-<renk-slug>` (karar 0024); `(merchant_id, external_id)` tekilligi korunur.

Kurallar (karar 0012, 0164):

- Kaynakta GORULMEYEN alan uretilmez. Stok bilgisi yoksa `None` ("yok" degil).
- Fiyat Shopify bicimindedir (nokta ondalik): `Decimal` ile kurusa, asla float.
- `compare_at_price` yalnizca fiyattan BUYUKSE liste fiyatidir.
- Marka: `vendor` HAM olarak tasinir; temizlik (magaza adi, "No Brand") siniflandirmada
  (`classify.brands.clean_source_brand`). Burada marka uydurulmaz ya da duzeltilmez.
- GTIN: yalnizca grupta TEK varyant varsa ve barkod gecerliyse (`classify_gtin`).
  Cok varyantli grupta hangi barkodun urunu temsil ettigi belli degildir; yanlis
  birlestirmeyi (karar 0119) onlemek icin yazilmaz.
- SKU magaza ici koddur; MPN DEGILDIR, yazilmaz.
- Aciklama (`body_html`) sozlesmede yok; tasinmaz (bkz. pilot plani).
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable, Iterator, Mapping
from datetime import datetime
from typing import Any

from collect.mapping import MAX_PRICE_KURUS
from collect.records import RawRecord
from platforms.adapters.base import Clock, offset_of, resolve_clock
from platforms.adapters.mapping import parse_money
from platforms.contract import CanonicalListing, Checkpoint, Rejection, SourceKind
from resolve.identity_policy import classify_gtin

#: Shopify urun kimligi, renk bolmesinde `-<renk-slug>` ekiyle (karar 0024).
LISTING_ID = re.compile(r"^[0-9]{1,20}(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$")
#: Kart icin yeterli; Shopify urunlerinde onlarca gorsel olabilir.
MAX_IMAGES = 10
#: Renk ekseninin sozlesmedeki adi (`CanonicalListing.options`).
COLOR_AXIS = "renk"

RecordSource = Callable[[], Iterable[RawRecord]]


def _text(value: Any) -> str | None:
    if value is None:
        return None
    text = " ".join(str(value).split())
    return text or None


def _truthy(value: str) -> bool | None:
    lowered = value.strip().lower()
    if lowered == "true":
        return True
    if lowered == "false":
        return False
    return None


def _in_stock(record: RawRecord) -> bool | None:
    """Gruptaki herhangi bir varyant satilabiliyorsa True; alan hic yoksa None."""
    seen: list[bool] = []
    for variant in record.groups.get("variants", ()):
        if "available" in variant:
            value = _truthy(variant["available"])
            if value is not None:
                seen.append(value)
    if not seen and "available" in record.fields:
        value = _truthy(record.fields["available"])
        if value is not None:
            seen.append(value)
    return any(seen) if seen else None


def _gtin(record: RawRecord) -> str | None:
    variants = record.groups.get("variants", ())
    if len(variants) > 1:
        return None
    raw = (variants[0].get("barcode") if variants else None) or record.fields.get("barcode")
    info = classify_gtin(raw)
    if info.status != "valid" or info.package_level:
        return None
    return info.value


def _images(record: RawRecord) -> tuple[str, ...]:
    urls: list[str] = []
    for entry in record.groups.get("images", ()):
        src = _text(entry.get("src"))
        if src and src.startswith("https://") and src not in urls:
            urls.append(src)
    fallback = _text(record.fields.get("image_url"))
    if not urls and fallback and fallback.startswith("https://"):
        urls.append(fallback)
    return tuple(urls[:MAX_IMAGES])


def _money(value: Any) -> int | None:
    kurus = parse_money(value, decimal_separator=".", thousands_separator=",")
    if kurus is not None and (kurus < 0 or kurus > MAX_PRICE_KURUS):
        raise ValueError("aralik disi")
    return kurus


def to_listing(
    record: RawRecord, *, platform: str, currency: str, observed_at: datetime
) -> CanonicalListing | Rejection:
    """Tek `RawRecord` -> sozlesme. Asla istisna firlatmaz."""
    fields = record.fields
    ref = record.source_ref
    listing_id = _text(fields.get("external_id"))
    title = _text(fields.get("title"))
    url = _text(fields.get("url"))
    if not listing_id or not title or not url:
        return Rejection("missing_required", ref)
    if not LISTING_ID.match(listing_id):
        return Rejection("bad_listing_id", ref)
    if not url.startswith("https://"):
        return Rejection("bad_url", ref)
    try:
        price = _money(fields.get("price"))
        compare_at = _money(fields.get("compare_at_price"))
    except ValueError:
        return Rejection("price_not_numeric", ref)
    if price is None:
        return Rejection("missing_price", ref)
    list_price = compare_at if compare_at is not None and compare_at > price else None
    product_type = _text(fields.get("product_type"))
    category = (
        tuple(part.strip() for part in product_type.split(">") if part.strip())
        if product_type
        else ()
    )
    color = _text(fields.get("color"))
    try:
        return CanonicalListing(
            platform=platform,
            listing_id=listing_id,
            title=title,
            url=url,
            currency=currency,
            observed_at=observed_at,
            price=price,
            list_price=list_price,
            in_stock=_in_stock(record),
            brand=_text(fields.get("vendor")),
            category_path=category,
            gtin=_gtin(record),
            options={COLOR_AXIS: color} if color else {},
            image_urls=_images(record),
            source_ref=ref,
        )
    except (TypeError, ValueError) as exc:
        return Rejection("invalid_listing", ref, type(exc).__name__)


class ShopifyListingAdapter:
    """`SourceAdapter`: `ShopifyConnector.fetch` (ya da kayitli kayitlar) -> sozlesme.

    Imlec: tuketilen kayit sirasi (`{"offset": n}`). Shopify'in eski sayfa sozlesmesi
    sirali oldugundan devam, bastan okuyup ilk `n` kaydi atlamaktir; pilot boyutunda
    (magaza basina <= 500 urun) yeterli.
    """

    kind: SourceKind = "api"

    def __init__(
        self,
        platform: str,
        records: RecordSource,
        *,
        currency: str = "TRY",
        observed_at: datetime | Clock | None = None,
    ) -> None:
        self.platform = platform
        self._records = records
        self.currency = currency
        self._clock = resolve_clock(observed_at)
        self.checkpoint = Checkpoint()

    def fetch(self, checkpoint: Checkpoint | None = None) -> Iterator[CanonicalListing | Rejection]:
        start = offset_of(checkpoint)
        observed_at = self._clock()
        self.checkpoint = Checkpoint({"offset": start}, start)
        for index, record in enumerate(self._records()):
            if index < start:
                continue
            item: CanonicalListing | Rejection
            if isinstance(record, RawRecord):
                item = to_listing(
                    record, platform=self.platform, currency=self.currency, observed_at=observed_at
                )
            else:
                item = Rejection("record_not_object", f"#{index}")
            self.checkpoint = Checkpoint({"offset": index + 1}, index + 1)
            yield item


def listing_fields(listing: CanonicalListing) -> Mapping[str, object]:
    """Pilot raporu icin alan doluluk ozeti (urun icerigi degil)."""
    return {
        "price": listing.price is not None,
        "list_price": listing.list_price is not None,
        "in_stock_known": listing.in_stock is not None,
        "brand": listing.brand is not None,
        "category": bool(listing.category_path),
        "gtin": listing.gtin is not None,
        "images": len(listing.image_urls),
        "color": COLOR_AXIS in listing.options,
    }
