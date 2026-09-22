"""`RawRecord` -> `NormalizedOffer`.

Tek kayit normalize edilemezse `RecordRejected` firlatir ve kosu DEVAM EDER.
Bir feed'deki tek bozuk satir yuzunden 10.000 urunu birakmak dogru davranis
degil; reddedilenler sayilir ve kosu `partial` biter.
"""

from __future__ import annotations

import unicodedata

from collect.mapping import FieldMapping
from collect.records import NormalizedOffer, NormalizedVariant, RawRecord, RecordRejected


def normalize_size(label: str | None) -> str | None:
    """Karsilastirilabilir beden anahtari.

    '38 ' -> '38', 'M' -> 'm', 'Tek Ebat' -> 'tek-ebat'. Turkce buyuk/kucuk
    harf donusumu i/I nedeniyle bozuldugu icin once aksan ayristirmasi yapilir.
    """
    if label is None:
        return None
    text = label.strip()
    if not text:
        return None
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.replace("ı", "i").replace("İ", "i").lower()
    return "-".join(text.split()) or None


def _variants(record: RawRecord, mapping: FieldMapping) -> tuple[NormalizedVariant, ...]:
    spec = mapping.variants
    if spec is None:
        return ()

    entries = record.groups.get(spec.path) or record.groups.get(f"g:{spec.path}") or ()
    variants: list[NormalizedVariant] = []
    seen: set[str] = set()

    for entry in entries:
        label = (entry.get(spec.size) or "").strip() or None
        if label is None:
            continue
        external_id = (entry.get(spec.external_id) if spec.external_id else None) or label
        if external_id in seen:
            continue
        seen.add(external_id)
        in_stock = mapping.formats.parse_in_stock(
            entry.get(spec.availability) if spec.availability else None
        )
        price_override = (
            mapping.formats.parse_price(entry.get(spec.price)) if spec.price else None
        )
        sku = (entry.get(spec.sku) or None) if spec.sku else None
        variants.append(
            NormalizedVariant(
                external_id=str(external_id),
                size_label=label,
                size_norm=normalize_size(label),
                in_stock=in_stock,
                price_override=price_override,
                sku=sku,
            )
        )
    return tuple(variants)


def normalize(record: RawRecord, mapping: FieldMapping) -> NormalizedOffer:
    fields = dict(record.fields)
    formats = mapping.formats

    external_id = mapping.require(fields, "external_id")
    url = mapping.require(fields, "url")
    title = mapping.require(fields, "title")

    current_price = formats.parse_price(mapping.get(fields, "price"))
    list_price = formats.parse_price(mapping.get(fields, "list_price"))
    # Liste fiyati guncel fiyattan dusukse anlamsizdir; sessizce dusurulur.
    if list_price is not None and current_price is not None and list_price < current_price:
        list_price = None

    if current_price is None:
        raise RecordRejected(f"fiyat yok: {external_id}")

    shipping_cost = formats.parse_price(mapping.get(fields, "shipping_cost"))
    threshold = formats.parse_price(mapping.get(fields, "free_shipping_threshold"))

    shipping_days_raw = mapping.get(fields, "shipping_days")
    try:
        shipping_days = int(shipping_days_raw) if shipping_days_raw else None
    except ValueError:
        shipping_days = None

    variants = _variants(record, mapping)
    # Varyant varsa stok bilgisi bedenlerden gelir: hicbir beden yoksa teklif
    # de stokta degildir. "Senin bedenin var mi" sorusu modada satin alma
    # kararinin kendisi.
    if variants:
        in_stock = any(variant.in_stock for variant in variants)
    else:
        in_stock = formats.parse_in_stock(mapping.get(fields, "availability"))

    return NormalizedOffer(
        external_id=external_id,
        url=url,
        title_raw=title,
        current_price=current_price,
        list_price=list_price,
        in_stock=in_stock,
        brand_raw=mapping.get(fields, "brand"),
        category_raw=mapping.get(fields, "category"),
        image_url=mapping.get(fields, "image_url"),
        gtin=mapping.get(fields, "gtin"),
        currency=mapping.get(fields, "currency") or "TRY",
        shipping_days=shipping_days,
        shipping_cost=shipping_cost,
        free_shipping_threshold=threshold,
        attributes_raw={
            key: value
            for key, value in fields.items()
            if key not in set(mapping.fields.values()) and len(value) <= 200
        },
        variants=variants,
    )
