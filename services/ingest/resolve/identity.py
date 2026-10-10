"""Kesin kimlik alanlari (gtin / mpn) icin dogrulama.

Besleme verisinde sik gorulen cop degerler ("0000000000000", "-", "yok",
"123456789012") iki ilgisiz urunu `exact_score` ile 1.0'a tasir ve otomatik
birlestirir. Kesin kimlik yalnizca GUVENILIR ise kesindir: dogrulanamayan
deger "yok" sayilir, yani eslesmeye girmez (bilgi eksikligi, celiski degil).
"""

from __future__ import annotations

import re

#: Bu dizilerin parcasi olan kodlar placeholder'dir ("12345678", "0123456789012").
_ASCENDING = "01234567890123456789"
_DESCENDING = "98765432109876543210"

#: MPN yerine yazilan "bos" anlamli degerler (kucuk harf, yalniz alfasayisal).
_MPN_PLACEHOLDERS = frozenset(
    {
        "yok",
        "na",
        "nan",
        "none",
        "null",
        "nil",
        "unknown",
        "bilinmiyor",
        "belirtilmemis",
        "standart",
        "standard",
        "tek",
        "tekurun",
        "default",
        "test",
        "sku",
        "mpn",
        "model",
    }
)

_MPN_MIN_ALNUM = 4


def gtin_checksum_valid(code: str) -> bool:
    """GS1 kontrol basamagi (GTIN-8/12/13/14)."""
    if not code.isdigit() or len(code) not in {8, 12, 13, 14}:
        return False
    digits = [int(ch) for ch in code]
    body, check = digits[:-1], digits[-1]
    total = sum(d * (3 if i % 2 == 0 else 1) for i, d in enumerate(reversed(body)))
    return (10 - total % 10) % 10 == check


def clean_gtin(value: str | None) -> str | None:
    """Gecerli GTIN ya da None. Placeholder ve kontrol basamagi hatali kodlar elenir."""
    code = (value or "").strip()
    if not code or not code.isascii() or not code.isdigit():
        return None
    if not gtin_checksum_valid(code):
        return None
    stripped = code.lstrip("0")
    # Hepsi sifir ya da tek rakam tekrari ("1111111111116" degil; govdesi tekrar).
    if not stripped or len(set(code[:-1])) == 1:
        return None
    if stripped in _ASCENDING or stripped in _DESCENDING:
        return None
    return code


def clean_mpn(value: str | None) -> str | None:
    """Anlamli uretici parca numarasi ya da None (degeri DEGISTIRMEZ, yalniz dogrular)."""
    raw = (value or "").strip()
    if not raw:
        return None
    alnum = re.sub(r"[^a-z0-9]", "", raw.lower())
    if len(alnum) < _MPN_MIN_ALNUM:
        return None
    if alnum in _MPN_PLACEHOLDERS:
        return None
    if len(set(alnum)) == 1:
        return None
    if alnum.isdigit() and not alnum.strip("0"):
        return None
    return raw
