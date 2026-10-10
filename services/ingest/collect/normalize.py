"""`RawRecord` -> `NormalizedOffer`.

Tek kayit normalize edilemezse `RecordRejected` firlatir ve kosu DEVAM EDER.
Bir feed'deki tek bozuk satir yuzunden 10.000 urunu birakmak dogru davranis
degil; reddedilenler sayilir ve kosu `partial` biter.
"""

from __future__ import annotations

import unicodedata

from collect.images import (
    SelectedImage,
    SourceImage,
    clean_url,
    images_from_entries,
    normalize_key,
    select_images,
)
from collect.mapping import MAX_PRICE_KURUS, FieldMapping
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


def _images(record: RawRecord, image_url: str | None) -> tuple[SelectedImage, ...]:
    """Offer gorselleri. Kaynak coklu gorsel verdiyse (`groups["images"]`) onlar
    (kaynak sirasiyla), vermediyse tek `image_url` (eski davranis). Kaynak
    gorsel verdiginde `image_url` (orn. varyant `featured_image`i) siralamayi
    belirlemez; rank 0 `normalize` icinde `offer.image_url` olur."""
    flags = (record.groups.get("image_flags") or ({},))[0]
    split = flags.get("split") == "1"
    selected = select_images(images_from_entries(record.groups.get("images") or ()))
    if split:
        # unknown != safe (karar 0073 ek 4): renk-bolunmus urunde YALNIZ bu renge ozgu
        # kanitli (varyanta bagli ya da bagli gorselle ayni dosya koku) gorseller girer.
        # Bagsiz/ortak gorsel, baska renge bagli gorsel ve eski tek-gorsel yedegi girmez;
        # kanit yoksa galeri bos kalir. `offer.image_url` bu yuzden degismez.
        return tuple(image for image in selected if image.is_variant_specific)
    if selected:
        return tuple(selected)
    cleaned = clean_url(image_url)
    return tuple(select_images([SourceImage(cleaned)])) if cleaned else ()


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
    # Sifir fiyat bir teklif degildir: numune, hediye, muhasebe satiri ya da
    # feed hatasi. Karsilastirmada "en uygun" diye one cikardi.
    if current_price <= 0:
        raise RecordRejected(f"gecersiz fiyat {current_price}: {external_id}")
    # Makul sinirin ustu ondalik/binlik yanlis okumasinin tipik izidir.
    if current_price > MAX_PRICE_KURUS:
        raise RecordRejected(f"supheli fiyat {current_price}: {external_id}")

    shipping_cost = formats.parse_price(mapping.get(fields, "shipping_cost"))
    threshold = formats.parse_price(mapping.get(fields, "free_shipping_threshold"))

    shipping_days_raw = mapping.get(fields, "shipping_days")
    try:
        shipping_days = int(shipping_days_raw) if shipping_days_raw else None
    except ValueError:
        shipping_days = None

    # Para birimi uydurulmaz (docs/decisions/0029): kaynagin kendi alani ya da
    # merchant icin kanitla dogrulanmis sabit. Ikisi de yoksa fiyat
    # karsilastirilamaz; kayit reddedilir.
    currency = (mapping.get(fields, "currency") or mapping.default_currency or "").upper()
    if len(currency) != 3 or not currency.isalpha():
        raise RecordRejected(f"para birimi bilinmiyor: {external_id}")

    variants = _variants(record, mapping)
    # Varyant varsa stok bilgisi bedenlerden gelir: hicbir beden yoksa teklif
    # de stokta degildir. "Senin bedenin var mi" sorusu modada satin alma
    # kararinin kendisi.
    if variants:
        in_stock = any(variant.in_stock for variant in variants)
    else:
        in_stock = formats.parse_in_stock(mapping.get(fields, "availability"))

    images = _images(record, mapping.get(fields, "image_url"))
    # Galeri varsa `image_url` rank 0 ile AYNI olur (primary_image_url == galeri[0]).
    top = next((image for image in images if image.display_rank == 0), None)
    raw_image = mapping.get(fields, "image_url")
    image_url = top.source_url if top else raw_image
    cleaned_raw = clean_url(raw_image)
    if top and cleaned_raw and normalize_key(cleaned_raw) == normalize_key(top.source_url):
        image_url = raw_image  # ayni gorsel: kaynagin yazimini koru, sahte degisim uretme
    return NormalizedOffer(
        external_id=external_id,
        url=url,
        title_raw=title,
        current_price=current_price,
        list_price=list_price,
        in_stock=in_stock,
        brand_raw=mapping.get(fields, "brand"),
        category_raw=mapping.get(fields, "category"),
        image_url=image_url,
        gtin=mapping.get(fields, "gtin"),
        currency=currency,
        shipping_days=shipping_days,
        shipping_cost=shipping_cost,
        free_shipping_threshold=threshold,
        attributes_raw={
            key: value
            for key, value in fields.items()
            if key not in set(mapping.fields.values()) and len(value) <= 200
        },
        variants=variants,
        images=images,
    )
