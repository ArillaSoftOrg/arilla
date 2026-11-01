"""Yapilandirma tabanli alan esleme: ham kayit -> `CanonicalListing` ya da `Rejection`.

`map_record` HICBIR zaman istisna firlatmaz; bozuk kayit `Rejection` olur. Kaynakta
gorulmeyen alan uretilmez: stok bilinmiyorsa `None` (asla "yok" varsayilmaz), marka/GTIN
yoksa `None`. Para daima `Decimal` ile kurus tamsayisina cevrilir, float hic devreye girmez.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any
from urllib.parse import urljoin, urlsplit

from collect.mapping import MAX_PRICE_KURUS
from platforms.contract import CanonicalListing, Rejection

DEFAULT_IN_STOCK_TRUE = frozenset(
    {"in stock", "in_stock", "instock", "available", "1", "true", "yes", "var", "stokta"}
)
DEFAULT_IN_STOCK_FALSE = frozenset(
    {
        "out of stock",
        "out_of_stock",
        "outofstock",
        "unavailable",
        "0",
        "false",
        "no",
        "yok",
        "tukendi",
    }
)

_ID = re.compile(r"^[^\s~]{1,100}$")
_CURRENCY = re.compile(r"^[A-Z]{3}$")


@dataclass(frozen=True)
class FieldMapping:
    """Kaynak alan yollari. Yol noktali olabilir (`seller.id`); liste indeksi sayidir."""

    listing_id: str
    title: str
    url: str
    price: str | None = None
    list_price: str | None = None
    #: Sabit para birimi (kaynak tanimindan); `currency_field` doluysa alan oncelikli.
    currency: str | None = None
    currency_field: str | None = None
    in_stock: str | None = None
    in_stock_true: frozenset[str] = DEFAULT_IN_STOCK_TRUE
    in_stock_false: frozenset[str] = DEFAULT_IN_STOCK_FALSE
    seller_id: str | None = None
    seller_name: str | None = None
    brand: str | None = None
    #: Dizge (ayiracli) ya da liste olabilir.
    category: str | None = None
    category_separator: str = ">"
    gtin: str | None = None
    mpn: str | None = None
    #: Liste ya da ayiracli dizge.
    images: str | None = None
    image_separator: str = ","
    #: Liste ogeleri sozluk ise gorsel adresi bu anahtardadir.
    image_key: str | None = None
    #: eksen adi -> alan yolu
    options: Mapping[str, str] = field(default_factory=dict)
    decimal_separator: str = ","
    thousands_separator: str = "."
    #: True: fiyat zaten kurus tamsayisi (ondalik yok).
    price_is_minor: bool = False
    #: Goreli adresleri tamamlamak icin (yoksa goreli adres bad_url olur).
    url_base: str | None = None

    def required_paths(self) -> tuple[str, ...]:
        return (self.listing_id, self.title, self.url)


class _Bad(Exception):
    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(code)
        self.code = code
        self.detail = detail


def get_value(raw: Mapping[str, Any], path: str | None) -> Any:
    """Noktali yolla deger al. Duz anahtar (CSV/XML'de noktali ad) once denenir."""
    if not path:
        return None
    if path in raw:
        return raw[path]
    current: Any = raw
    for part in path.split("."):
        if isinstance(current, Mapping):
            if part not in current:
                return None
            current = current[part]
        elif isinstance(current, Sequence) and not isinstance(current, str) and part.isdigit():
            index = int(part)
            if index >= len(current):
                return None
            current = current[index]
        else:
            return None
    return current


def _scalar(value: Any) -> Any:
    if isinstance(value, Sequence) and not isinstance(value, str):
        value = value[0] if value else None
    return value


def _text(value: Any) -> str | None:
    value = _scalar(value)
    if value is None or isinstance(value, (Mapping, bool)):
        return None
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    text = str(value).strip()
    return text or None


def _clean_decimal(text: str, decimal_separator: str, thousands_separator: str) -> Decimal:
    keep = f"{decimal_separator}{thousands_separator}-"
    cleaned = "".join(ch for ch in text if ch.isdigit() or ch in keep)
    body = cleaned.lstrip("-")
    if not any(ch.isdigit() for ch in body) or "-" in body:
        raise ValueError(f"fiyat sayi degil: {text[:40]!r}")
    if decimal_separator and body.count(decimal_separator) > 1:
        raise ValueError(f"fiyat bicimi gecersiz: {text[:40]!r}")
    head, _, tail = body.partition(decimal_separator) if decimal_separator else (body, "", "")
    if thousands_separator and thousands_separator in tail:
        raise ValueError(f"fiyat bicimi gecersiz: {text[:40]!r}")
    if thousands_separator and thousands_separator in head:
        groups = head.split(thousands_separator)
        if not 1 <= len(groups[0]) <= 3 or any(len(g) != 3 for g in groups[1:]):
            raise ValueError(f"fiyat bicimi gecersiz: {text[:40]!r}")
    if thousands_separator:
        cleaned = cleaned.replace(thousands_separator, "")
    if decimal_separator and decimal_separator != ".":
        cleaned = cleaned.replace(decimal_separator, ".")
    try:
        return Decimal(cleaned)
    except InvalidOperation:
        raise ValueError(f"fiyat sayi degil: {text[:40]!r}") from None


def parse_money(
    value: Any,
    *,
    decimal_separator: str = ",",
    thousands_separator: str = ".",
    minor: bool = False,
) -> int | None:
    """Kurus tamsayisi. Bos -> None; cozulemez -> ValueError. Yarim kurus yukari."""
    value = _scalar(value)
    if value is None:
        return None
    if isinstance(value, bool):
        raise ValueError("bool fiyat degil")
    if isinstance(value, int):
        number = Decimal(value)
    elif isinstance(value, float):
        number = Decimal(repr(value))  # ikili kesir degil, yazilan haneler
    elif isinstance(value, Decimal):
        number = value
    elif isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        number = _clean_decimal(text, decimal_separator, thousands_separator)
    else:
        raise ValueError("fiyat tipi desteklenmiyor")
    if not number.is_finite():
        raise ValueError("fiyat sonlu degil")
    kurus = number if minor else number * 100
    return int(kurus.quantize(Decimal(1), rounding=ROUND_HALF_UP))


def _price(
    raw: Mapping[str, Any], path: str | None, mapping: FieldMapping, name: str
) -> int | None:
    # JSON sayilari ('.' ondalikli) metin degil; metin fiyatlar TR bicimiyle okunur.
    try:
        kurus = parse_money(
            get_value(raw, path),
            decimal_separator=mapping.decimal_separator,
            thousands_separator=mapping.thousands_separator,
            minor=mapping.price_is_minor,
        )
    except ValueError as exc:
        raise _Bad("price_not_numeric", f"{name}: {exc}") from None
    if kurus is not None and kurus < 0:
        raise _Bad("price_negative", name)
    if kurus is not None and kurus > MAX_PRICE_KURUS:
        raise _Bad("price_out_of_range", name)
    return kurus


def _in_stock(raw: Mapping[str, Any], mapping: FieldMapping) -> bool | None:
    value = _scalar(get_value(raw, mapping.in_stock))
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in mapping.in_stock_true:
        return True
    if text in mapping.in_stock_false:
        return False
    return None  # taninmayan deger: bilinmiyor, "yok" DEGIL


def gtin_checksum_ok(code: str) -> bool:
    if not code.isdigit() or len(code) not in (8, 12, 13, 14):
        return False
    digits = [int(c) for c in code]
    total = sum(d * (3 if i % 2 == 0 else 1) for i, d in enumerate(reversed(digits[:-1])))
    return (10 - total % 10) % 10 == digits[-1]


def clean_gtin(raw: Any) -> str | None:
    """Gecerli kontrol basamakli GTIN; yer tutucu (0000...) ve bozuk deger None olur."""
    text = _text(raw)
    if text is None:
        return None
    code = re.sub(r"[\s-]", "", text)
    if not code.isdigit() or len(set(code)) == 1:
        return None
    return code if gtin_checksum_ok(code) else None


def _url(raw: Mapping[str, Any], mapping: FieldMapping) -> str:
    text = _text(get_value(raw, mapping.url))
    if text is None:
        raise _Bad("missing_url")
    if mapping.url_base and not urlsplit(text).scheme:
        text = urljoin(mapping.url_base, text)
    parts = urlsplit(text)
    if parts.scheme not in ("http", "https") or not parts.netloc or any(c.isspace() for c in text):
        raise _Bad("bad_url", text[:80])
    return text


def _category(raw: Mapping[str, Any], mapping: FieldMapping) -> tuple[str, ...]:
    value = get_value(raw, mapping.category)
    if value is None:
        return ()
    if isinstance(value, str):
        parts: Sequence[Any] = value.split(mapping.category_separator)
    elif isinstance(value, Sequence):
        parts = value
    else:
        return ()
    cleaned = (str(p).strip() for p in parts if p is not None and not isinstance(p, Mapping))
    return tuple(p for p in cleaned if p)


def _images(raw: Mapping[str, Any], mapping: FieldMapping) -> tuple[str, ...]:
    value = get_value(raw, mapping.images)
    if value is None:
        return ()
    items: Sequence[Any]
    if isinstance(value, str):
        items = value.split(mapping.image_separator)
    elif isinstance(value, Sequence):
        items = value
    else:
        return ()
    urls: list[str] = []
    for item in items:
        if isinstance(item, Mapping):
            item = item.get(mapping.image_key) if mapping.image_key else None
        text = _text(item)
        if text and urlsplit(text).scheme in ("http", "https") and text not in urls:
            urls.append(text)
    return tuple(urls)


def _options(raw: Mapping[str, Any], mapping: FieldMapping) -> dict[str, str]:
    result: dict[str, str] = {}
    for axis, path in mapping.options.items():
        text = _text(get_value(raw, path))
        if text:
            result[axis] = text
    return result


def map_record(
    raw: Mapping[str, Any],
    mapping: FieldMapping,
    platform: str,
    observed_at: datetime,
    source_ref: str = "",
) -> CanonicalListing | Rejection:
    """Tek kaydi esler. Asla istisna firlatmaz; bozuk kayit `Rejection` doner."""
    try:
        return _map(raw, mapping, platform, observed_at, source_ref)
    except _Bad as bad:
        return Rejection(bad.code, source_ref, bad.detail)
    except Exception as exc:  # beklenmeyen sekil: kosuyu durdurma
        return Rejection("unmappable_record", source_ref, type(exc).__name__)


def _map(
    raw: Mapping[str, Any],
    mapping: FieldMapping,
    platform: str,
    observed_at: datetime,
    source_ref: str,
) -> CanonicalListing:
    if not isinstance(raw, Mapping):
        raise _Bad("record_not_object")
    listing_id = _text(get_value(raw, mapping.listing_id))
    if listing_id is None:
        raise _Bad("missing_listing_id")
    if not _ID.match(listing_id):
        raise _Bad("bad_listing_id", listing_id[:40])
    title = _text(get_value(raw, mapping.title))
    if title is None:
        raise _Bad("missing_title")
    url = _url(raw, mapping)

    currency = _text(get_value(raw, mapping.currency_field)) or mapping.currency
    if currency is None:
        raise _Bad("missing_currency")
    currency = currency.upper()
    if not _CURRENCY.match(currency):
        raise _Bad("bad_currency", currency[:10])

    price = _price(raw, mapping.price, mapping, "price")
    list_price = _price(raw, mapping.list_price, mapping, "list_price")

    return CanonicalListing(
        platform=platform,
        listing_id=listing_id,
        title=title,
        url=url,
        currency=currency,
        observed_at=observed_at,
        price=price,
        list_price=list_price,
        in_stock=_in_stock(raw, mapping),
        seller_id=_text(get_value(raw, mapping.seller_id)),
        seller_name=_text(get_value(raw, mapping.seller_name)),
        brand=_text(get_value(raw, mapping.brand)),
        category_path=_category(raw, mapping),
        gtin=clean_gtin(get_value(raw, mapping.gtin)),
        mpn=_text(get_value(raw, mapping.mpn)),
        options=_options(raw, mapping),
        image_urls=_images(raw, mapping),
        source_ref=source_ref,
    )
