"""`merchant.feed_config` guduml alan eslemesi.

Hicbir saglayicinin alan semasi KODA GOMULMEZ. Admitad, Awin veya bir
merchant'in kendi XML'i — hepsinin alan adlari `feed_config.mapping` icinde
yasar. Gercek bir dokum eline gectiginde yapilacak sey bir config satiri
yazmaktir, kod degistirmek degil.

Bu ayni zamanda bir dogruluk meselesi: elimizde gercek bir ag dokumu yokken
"Admitad semasi" diye alan adlari uydurmak, dogrulanmamis bir varsayimi koda
gomerdi.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any

from collect.records import RecordRejected

#: `mapping` icinde bulunmasi zorunlu alanlar. Bunlar olmadan bir teklif
#: kataloga yazilamaz: kimligi, adresi ve adi olmayan urun yoktur.
REQUIRED_FIELDS = ("external_id", "url", "title")

DEFAULT_IN_STOCK_VALUES = (
    "in stock",
    "in_stock",
    "instock",
    "available",
    "1",
    "true",
    "yes",
    "var",
)


@dataclass(frozen=True)
class ValueFormats:
    """Bir merchant'in sayi ve stok yazim bicimi."""

    decimal_separator: str = ","
    thousands_separator: str = "."
    in_stock_values: tuple[str, ...] = DEFAULT_IN_STOCK_VALUES

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> ValueFormats:
        raw = config.get("value_formats") or {}
        values = raw.get("in_stock_values")
        return cls(
            decimal_separator=raw.get("decimal_separator", ","),
            thousands_separator=raw.get("thousands_separator", "."),
            in_stock_values=(
                tuple(str(v).lower() for v in values) if values else DEFAULT_IN_STOCK_VALUES
            ),
        )

    def parse_price(self, raw: str | None) -> int | None:
        """Metin fiyati KURUS cinsinden tamsayiya cevirir.

        Ara adimda `Decimal` kullanilir; `float` hic devreye girmez. Para
        float ile tutulmaz — 0.1 + 0.2 tartismasinin fiyat karsilastirmasinda
        yeri yok.

        "1.234,56 TL" -> 123456
        """
        if raw is None:
            return None
        text = str(raw).strip()
        if not text:
            return None

        # Para birimi eki ve bosluklari at, yalnizca sayi ve ayraclar kalsin.
        keep = f"{self.decimal_separator}{self.thousands_separator}-"
        cleaned = "".join(ch for ch in text if ch.isdigit() or ch in keep)
        if self.thousands_separator:
            cleaned = cleaned.replace(self.thousands_separator, "")
        if self.decimal_separator and self.decimal_separator != ".":
            cleaned = cleaned.replace(self.decimal_separator, ".")
        if not cleaned or cleaned in {"-", "."}:
            return None

        try:
            lira = Decimal(cleaned)
        except InvalidOperation:
            raise RecordRejected(f"fiyat cozumlenemedi: {text!r}") from None
        # Kurusa cevir; yarim kurus yukari yuvarlanir.
        return int((lira * 100).quantize(Decimal("1")))

    def parse_in_stock(self, raw: str | None, *, default: bool = True) -> bool:
        if raw is None:
            return default
        return str(raw).strip().lower() in self.in_stock_values


@dataclass(frozen=True)
class VariantMapping:
    """Bedenlerin kaynaktaki yeri. Yoksa teklif varyantsiz islenir."""

    path: str
    size: str
    availability: str | None = None
    external_id: str | None = None
    #: nadir per-varyant fiyat/SKU (orn. Shopify: her beden/renk kombinasyonunun
    #: kendi fiyati ve SKU'su olabilir). Yoksa NormalizedVariant'ta None kalir.
    price: str | None = None
    sku: str | None = None


@dataclass(frozen=True)
class FieldMapping:
    """Kaynak alan adi -> bizim alan adimiz."""

    fields: dict[str, str]
    formats: ValueFormats = field(default_factory=ValueFormats)
    variants: VariantMapping | None = None
    #: Kaynak para birimi tasimiyorsa (Shopify /products.json) kullanilacak
    #: DOGRULANMIS para birimi: `feed_config.currency` yalnizca
    #: `currency_verified = true` ise gecerlidir (docs/decisions/0029).
    #: Yoksa `normalize` kaydi reddeder — TRY varsayilmaz.
    default_currency: str | None = None

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> FieldMapping:
        mapping = dict(config.get("mapping") or {})
        variant_config = mapping.pop("variants", None)

        missing = [name for name in REQUIRED_FIELDS if not mapping.get(name)]
        if missing:
            raise ValueError(
                f"feed_config.mapping eksik: {', '.join(missing)}. "
                "Alan eslemesi merchant.feed_config icinde tanimlanir."
            )

        variants = None
        if variant_config:
            variants = VariantMapping(
                path=variant_config["path"],
                size=variant_config["size"],
                availability=variant_config.get("availability"),
                external_id=variant_config.get("external_id"),
                price=variant_config.get("price"),
                sku=variant_config.get("sku"),
            )

        currency = str(config.get("currency") or "").strip().upper()
        verified = config.get("currency_verified") is True

        return cls(
            fields={name: str(source) for name, source in mapping.items()},
            formats=ValueFormats.from_config(config),
            variants=variants,
            default_currency=currency if verified and currency else None,
        )

    def get(self, record_fields: dict[str, str], name: str) -> str | None:
        """Bizim alan adimizla kaynaktan deger okur."""
        source_name = self.fields.get(name)
        if not source_name:
            return None
        value = record_fields.get(source_name)
        if value is None:
            return None
        value = value.strip()
        return value or None

    def require(self, record_fields: dict[str, str], name: str) -> str:
        value = self.get(record_fields, name)
        if value is None:
            raise RecordRejected(f"zorunlu alan bos: {name} ({self.fields.get(name)!r})")
        return value
