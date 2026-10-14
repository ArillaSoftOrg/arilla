"""Besleme kaydi -> `FeedOffer`. Alan adlari YAPILANDIRMADAN gelir (karar 0012).

`feed_source.config.mapping` anahtarlari (deger: kaynak alan yolu):

    id, title, url, price, old_price, currency, category, images, seller,
    available, brand, gtin, mpn

Yol bicimi: `name` (alt oge / kolon), `@id` (oznitelik), `param.shopId`
(YML <param name="shopId">). Varsayilanlar YML standardidir.

`url_unwrap`: izleme baglantisinin icindeki gercek urun adresine iner, or.
`["ulp", "dl_target_url"]` (Admitad -> AliExpress). Inilen adresin hostu
`url_hosts` listesinde degilse kayit REDDEDILIR: izleme baglantisi urun
adresi olarak saklanmaz (cikis her zaman click + deeplink_template ile, kural 8).

Kaynakta olmayan bilgi uydurulmaz: stok bilgisi yoksa YML varsayilani
(`available` yoksa satista) kullanilir; marka/GTIN yoksa bos kalir.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass, field
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any
from urllib.parse import parse_qsl, urlsplit

from collect.images import SelectedImage, SourceImage, select_images
from collect.mapping import MAX_PRICE_KURUS
from feeds.parsers import FeedRecord
from resolve.identity_policy import classify_gtin, mpn_norm

YML_DEFAULTS: Mapping[str, str] = {
    "id": "@id",
    "title": "name",
    "url": "url",
    "price": "price",
    "old_price": "oldprice",
    "currency": "currencyId",
    "category": "categoryId",
    "images": "picture",
    "available": "@available",
    "brand": "vendor",
    "gtin": "barcode",
    "mpn": "vendorCode",
}

MAX_TITLE = 500
MAX_EXTERNAL_ID = 200


class Rejected(Exception):
    """Kayit normalize edilemedi; `code` ingest_error.error_code olur."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(code)
        self.code = code
        self.detail = detail[:300]


@dataclass(frozen=True)
class FeedOffer:
    external_id: str
    title: str
    url: str
    #: Para biriminin en kucuk birimi (kurus, cent). Asla float.
    price_minor: int
    old_price_minor: int | None
    currency: str
    in_stock: bool
    category_path: str | None
    seller_external_id: str | None
    brand: str | None
    gtin: str | None
    mpn: str | None
    images: tuple[SelectedImage, ...] = ()
    attributes: dict[str, str] = field(default_factory=dict)
    #: Kaynagin takip baglantisi (yalnizca `affiliate_hosts` izinliyse); kanonik
    #: `url`'den AYRIDIR ve parmak izine girmez (takip parametresi degisse de
    #: urun degismis sayilmaz).
    affiliate_url: str | None = None

    @property
    def image_url(self) -> str | None:
        return self.images[0].source_url if self.images else None

    def fingerprint(self) -> str:
        """Normalize alanlarin ozeti. Ayniysa kayit degismemistir."""
        payload = asdict(self)
        payload["images"] = [image.source_url for image in self.images]
        payload.pop("affiliate_url", None)
        raw = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def get_path(fields: Mapping[str, Any], path: str | None) -> Any:
    if not path:
        return None
    if path.startswith("param."):
        params = fields.get("param")
        return params.get(path[6:]) if isinstance(params, Mapping) else None
    return fields.get(path)


def _text(value: Any) -> str | None:
    if isinstance(value, list):
        value = value[0] if value else None
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def parse_price(raw: Any, *, decimal_separator: str = ".") -> int | None:
    """'22.11' -> 2211. Float kullanilmaz; yuvarlama yarim yukari."""
    text = _text(raw)
    if text is None:
        return None
    text = text.replace(" ", "")
    if decimal_separator == ",":
        text = text.replace(".", "").replace(",", ".")
    else:
        text = text.replace(",", "")
    try:
        value = Decimal(text)
    except InvalidOperation:
        raise Rejected("price_invalid", text[:40]) from None
    if not value.is_finite() or value <= 0:
        raise Rejected("price_invalid", text[:40])
    minor = int((value * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    if minor > MAX_PRICE_KURUS:
        raise Rejected("price_out_of_range", text[:40])
    return minor


def unwrap_url(url: str, steps: Sequence[str]) -> str | None:
    """Sorgu parametrelerinden ic ice gercek adrese iner."""
    current = url.replace("&amp;", "&")
    for name in steps:
        query = dict(parse_qsl(urlsplit(current).query, keep_blank_values=False))
        if name not in query:
            return None
        current = query[name]
    return current


def _canonical_url(raw: str, config: Mapping[str, Any]) -> str:
    steps = config.get("url_unwrap") or []
    url = unwrap_url(raw, steps) if steps else raw
    if not url:
        raise Rejected("url_unresolved")
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise Rejected("url_invalid")
    hosts = config.get("url_hosts") or []
    host = parts.hostname or ""
    if hosts and not any(host == h or host.endswith("." + h) for h in hosts):
        raise Rejected("url_host_not_allowed", host)
    # Izleme/oturum parametreleri kimlige karismaz: yalnizca sema+host+yol.
    clean = f"https://{host}{parts.path}" if config.get("url_strip_query", True) else url
    if len(clean) > 2048:
        raise Rejected("url_too_long")
    return clean


def affiliate_url(raw: str, config: Mapping[str, Any]) -> str | None:
    """Takip baglantisi: yalnizca https ve `affiliate_hosts` icindeyse saklanir."""
    hosts = config.get("affiliate_hosts") or []
    if not hosts:
        return None
    parts = urlsplit(raw.replace("&amp;", "&"))
    host = parts.hostname or ""
    if not any(host == h or host.endswith("." + h) for h in hosts):
        return None
    url = parts._replace(scheme="https").geturl()
    return url if len(url) <= 2048 else None


def category_path(cid: str | None, categories: Mapping[str, tuple[str, str | None]]) -> str | None:
    """YML kategori kimligi -> 'Ust > Alt' yolu (dongu korumali)."""
    if not cid:
        return None
    if cid not in categories:
        return cid
    names: list[str] = []
    seen: set[str] = set()
    current: str | None = cid
    while current and current in categories and current not in seen and len(names) < 10:
        seen.add(current)
        name, parent = categories[current]
        names.append(name or current)
        current = parent
    return " > ".join(reversed(names))[:500]


def normalize(
    record: FeedRecord,
    config: Mapping[str, Any],
    *,
    expected_currency: str | None,
    categories: Mapping[str, tuple[str, str | None]] | None = None,
) -> FeedOffer:
    mapping = {**YML_DEFAULTS, **(config.get("mapping") or {})}
    fields = record.fields

    external_id = _text(get_path(fields, mapping["id"]))
    if not external_id:
        raise Rejected("missing_id")
    if len(external_id) > MAX_EXTERNAL_ID:
        raise Rejected("id_too_long")

    title = _text(get_path(fields, mapping["title"]))
    if not title:
        raise Rejected("missing_title", external_id)

    raw_url = _text(get_path(fields, mapping["url"]))
    if not raw_url:
        raise Rejected("missing_url", external_id)
    url = _canonical_url(raw_url, config)

    separator = (config.get("value_formats") or {}).get("decimal_separator", ".")
    price = parse_price(get_path(fields, mapping["price"]), decimal_separator=separator)
    if price is None:
        raise Rejected("missing_price", external_id)
    old_price = None
    raw_old = get_path(fields, mapping["old_price"])
    if _text(raw_old):
        try:
            old_price = parse_price(raw_old, decimal_separator=separator)
        except Rejected:
            old_price = None
        if old_price is not None and old_price <= price:
            old_price = None

    currency = (
        _text(get_path(fields, mapping["currency"])) or config.get("currency") or ""
    ).upper()
    if currency == "RUR":
        currency = "RUB"
    if len(currency) != 3 or not currency.isalpha():
        raise Rejected("currency_invalid", currency[:10])
    if expected_currency and currency != expected_currency:
        raise Rejected("currency_mismatch", f"{currency}!={expected_currency}")

    available = _text(get_path(fields, mapping["available"]))
    in_stock = available is None or available.lower() not in ("false", "0", "no", "out_of_stock")

    images_raw = get_path(fields, mapping["images"]) or []
    if isinstance(images_raw, str):
        images_raw = [images_raw]
    images = tuple(select_images(SourceImage(url=u, position=i) for i, u in enumerate(images_raw)))

    gtin_info = classify_gtin(_text(get_path(fields, mapping["gtin"])))
    attributes: dict[str, str] = {}
    params = fields.get("param")
    if isinstance(params, Mapping):
        for key in config.get("keep_params") or ():
            value = params.get(key)
            if value:
                attributes[key] = str(value)[:100]

    return FeedOffer(
        external_id=external_id,
        title=title[:MAX_TITLE],
        url=url,
        price_minor=price,
        old_price_minor=old_price,
        currency=currency,
        in_stock=in_stock,
        category_path=category_path(_text(get_path(fields, mapping["category"])), categories or {}),
        seller_external_id=_text(get_path(fields, mapping.get("seller"))),
        brand=_text(get_path(fields, mapping["brand"])),
        gtin=gtin_info.value,
        mpn=mpn_norm(_text(get_path(fields, mapping["mpn"]))),
        images=images,
        attributes=attributes,
        affiliate_url=affiliate_url(raw_url, config),
    )


def schema_fields(record: FeedRecord) -> set[str]:
    """Sema parmak izi icin kaydin alan yollari (degerler degil)."""
    keys: set[str] = set()
    for key, value in record.fields.items():
        if key == "param" and isinstance(value, Mapping):
            keys.update(f"param.{name}" for name in value)
        else:
            keys.add(key)
    return keys


def schema_fingerprint(keys: set[str]) -> str:
    return hashlib.sha256("\n".join(sorted(keys)).encode("utf-8")).hexdigest()
