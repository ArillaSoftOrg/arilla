"""Offer'dan embedding'lenecek kanonik metnin kurulmasi.

Model cok-kipli: metin ve gorsel ayni uzaya duser. Bu yuzden metin
embedding'i yalnizca metin aramasini degil, "bu fotografa benzeyen urun"
sorgusunun metin tarafini da besler.

Metnin kanonik olmasi onemli: ayni urun iki merchant'ta ayni bicimde
kuruluyorsa API bir kez cagrilir.
"""

from __future__ import annotations

import re

WHITESPACE = re.compile(r"\s+")

#: Baslikta siklikla gecen ve anlam tasimayan pazarlama ekleri.
NOISE = re.compile(
    r"\b(indirimli|kampanyali|yeni sezon|ucretsiz kargo|hizli kargo|orjinal|orijinal)\b",
    re.IGNORECASE,
)


def build(
    title: str,
    brand: str | None = None,
    category: str | None = None,
) -> str:
    """Baslik + marka + kategoriden tek bir metin kurar.

    Marka basliga zaten gomulu olabilir; tekrar etmemek icin yalnizca
    basliktan farkliysa eklenir.
    """
    parts: list[str] = []

    cleaned_title = normalize(title)
    if brand:
        normalized_brand = normalize(brand)
        if normalized_brand and normalized_brand not in cleaned_title:
            parts.append(normalized_brand)
    parts.append(cleaned_title)

    if category:
        # Kategori yolu 'moda/ayakkabi' gibi; bosluga cevirip anlamli kil.
        parts.append(normalize(category.replace("/", " ")))

    return " ".join(part for part in parts if part).strip()


def normalize(value: str) -> str:
    """Kucuk harf, gurultu ekleri atilmis, tek bosluklu."""
    text = NOISE.sub(" ", value)
    # Turkce buyuk/kucuk donusumunde I/i sorunu var; casefold yerine lower
    # kullanip 'I' harfini once noktali kucuk 'i'ye ceviriyoruz.
    text = text.replace("I", "ı").replace("İ", "i").lower()
    return WHITESPACE.sub(" ", text).strip()
