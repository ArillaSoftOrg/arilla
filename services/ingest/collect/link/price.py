"""Sayfadaki yapilandirilmis (JSON-LD / OpenGraph) fiyatin ayristirilmasi.

schema.org fiyati nokta ondaliklidir ("1899.90") ama gercek sayfalarda
"1.299,00", "1299,90", "1,299.00" de gorulur. Tek bir sabit bicim varsaymak
"1.299,00"u 1,30 TL, "1299,90"i 129.990 TL yapar. Burada bicim, metnin
KENDISINDEN cikarilir ve **belirsizse reddedilir**: "1,299" ve "1.299"
binlik de ondalik da olabilir; tahmin etmek yerine fiyat verilmez. Yanlis fiyat
gostermek, fiyat gostermemekten kotudur.
"""

from __future__ import annotations

import re
from decimal import ROUND_HALF_UP, Decimal

from collect.mapping import MAX_PRICE_KURUS
from collect.records import RecordRejected

__all__ = ["MAX_PRICE_KURUS", "parse_structured_price"]

#: Para birimi isaretleri ve bosluklar atilir; geri kalan yalniz sayi olmali.
_CURRENCY_NOISE = re.compile(r"(?i)₺|\btl\b|\btry\b|\busd\b|\beur\b|\bgbp\b|[$€£]|\s")
_NUMERIC = re.compile(r"^[0-9][0-9.,]*$")

#: Ondalik basamak siniri: "12.3456" (schema.org 4 haneye kadar izin verir).
_MAX_FRACTION_DIGITS = 4


def _grouped(text: str, separator: str) -> bool:
    """"1.299.000": ilk grup 1-3 hane, sonrakiler tam 3 hane."""
    groups = text.split(separator)
    return 1 <= len(groups[0]) <= 3 and all(len(group) == 3 for group in groups[1:])


def _reject(raw: str | None, reason: str) -> RecordRejected:
    return RecordRejected(f"fiyat {reason}: {raw!r}")


def parse_structured_price(raw: str | None) -> int:
    """Metin fiyati KURUS cinsinden tamsayiya cevirir; belirsiz/supheli ise reddeder."""
    cleaned = _CURRENCY_NOISE.sub("", raw or "")
    if not _NUMERIC.match(cleaned):
        raise _reject(raw, "cozumlenemedi")

    dots, commas = cleaned.count("."), cleaned.count(",")
    if dots and commas:
        # Ikisi de var: SONDA gelen ondalik, oteki binliktir.
        decimal = "." if cleaned.rfind(".") > cleaned.rfind(",") else ","
        thousands = "," if decimal == "." else "."
        if cleaned.count(decimal) != 1:
            raise _reject(raw, "belirsiz")
        integer, _, fraction = cleaned.partition(decimal)
        if not _grouped(integer, thousands) or not 1 <= len(fraction) <= _MAX_FRACTION_DIGITS:
            raise _reject(raw, "belirsiz")
        digits = integer.replace(thousands, "")
    elif dots or commas:
        separator = "." if dots else ","
        if cleaned.count(separator) > 1:
            # Ayni ayrac birden fazla: binliktir, ondalik olamaz.
            if not _grouped(cleaned, separator):
                raise _reject(raw, "belirsiz")
            integer, fraction = cleaned.replace(separator, ""), ""
            digits = integer
        else:
            integer, _, fraction = cleaned.partition(separator)
            # Tek ayrac ve 3 hane: "1.299" binlik mi ondalik mi? Tahmin edilmez.
            if len(fraction) == 3 or not 1 <= len(fraction) <= _MAX_FRACTION_DIGITS:
                raise _reject(raw, "belirsiz")
            if separator == "," and len(fraction) > 2:
                raise _reject(raw, "belirsiz")
            digits = integer
    else:
        integer, fraction, digits = cleaned, "", cleaned

    amount = Decimal(f"{digits}.{fraction}" if fraction else digits)
    kurus = int((amount * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    if kurus <= 0:
        raise _reject(raw, "gecersiz (sifir ya da negatif)")
    if kurus > MAX_PRICE_KURUS:
        raise _reject(raw, "makul sinirin ustunde")
    return kurus
