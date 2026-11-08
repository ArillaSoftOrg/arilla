"""Urun metin embedding'inin kanonik metni ve icerik ozeti (karar 0177).

Offer metni (`enrich/text.py`, jina-clip-v2) ile AYNI kural degildir; bilincli olarak ayrilir:

- **Buyuk/kucuk harf korunur.** jina-embeddings-v3 buyuk/kucuk harfe duyarli ve cok dilli bir
  transformer'dir; kucultmeye gerek yoktur. `enrich/text.py`'deki `I -> ı` donusumu Turkce icin
  dogrudur ama katalogun buyuk cogunlugu Ingilizce baslik oldugundan ("IPhone" -> "ıphone")
  anlami bozar.
- **Kategori yolu metne GIRMEZ.** Siniflandirma kosulari kategorileri toplu degistirir; kategori
  metindeyse her kosu yeniden embedding (ucretli) demektir. Kategori aramada kesin suzgectir.
- **Yer tutucu marka eklenmez** ("NoEnName_Null", "OEM", "Generic" ...): anlam tasimaz, ayni
  urunun vektorunu markasiz kopyasindan uzaklastirir.
- Gurultu: yalniz anlam tasimayan satis ekleri silinir; "new", "2024" gibi urunu
  ayirt edebilecek sozcuklere dokunulmaz.

Kural degisirse `TEXT_VERSION` artirilir: eski surumlu satirlar sonraki kosuda yeniden uretilir.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata

#: Kanonik metin kurali surumu (`product_text_embedding.text_version`).
TEXT_VERSION = 1

#: Uzun basliklari sinirlar (maliyet tavani). Uretimde baslik ortalamasi ~130 karakter.
MAX_TEXT_CHARS = 400

#: Kaynak ozetinde baslik ile markayi ayiran karakter (SQL tarafinda `chr(31)`).
SOURCE_SEPARATOR = "\x1f"

_WHITESPACE = re.compile(r"\s+")
_NOISE = re.compile(
    r"\b(?:free shipping|fast shipping|hot sale|dropshipping|drop shipping|"
    r"ücretsiz kargo|hızlı kargo|kampanyalı ürün|kampanyalı|indirimli)\b",
    re.IGNORECASE,
)
_PLACEHOLDER_BRAND = re.compile(
    r"^(?:no ?brand|noenname_null|non ?brand|oem|odm|generic|unbranded|other|others|none|null|"
    r"n/?a|unknown|markasız|diğer|belirtilmemiş|-+|\.+)$"
)


def _clean(value: str | None) -> str:
    """NFKC, kontrol karakterleri bosluga, gurultu ekleri silinir, tek bosluk."""
    if not value:
        return ""
    text = unicodedata.normalize("NFKC", value)
    text = "".join(" " if unicodedata.category(ch).startswith("C") else ch for ch in text)
    text = _NOISE.sub(" ", text)
    return _WHITESPACE.sub(" ", text).strip(" -|,;/")


def _fold(value: str) -> str:
    """Karsilastirma icin: Turkce `İ` once `i`'ye cevrilir (casefold birlesik nokta birakir)."""
    return value.replace("İ", "i").casefold()


def is_placeholder_brand(brand: str) -> bool:
    return bool(_PLACEHOLDER_BRAND.match(_fold(brand).strip()))


def _truncate(text: str, limit: int = MAX_TEXT_CHARS) -> str:
    if len(text) <= limit:
        return text
    cut = text[:limit]
    space = cut.rfind(" ")
    # Sozcuk ortasindan kesmemek icin son bosluga geri gidilir (cok gerideyse sert kesilir).
    return (cut[:space] if space >= limit * 0.8 else cut).rstrip()


def build_product_text(title: str | None, brand: str | None = None) -> str:
    """Marka (baslikta yoksa ve yer tutucu degilse) + baslik. Bos girdi -> bos metin."""
    cleaned_title = _clean(title)
    cleaned_brand = _clean(brand)
    if (
        cleaned_brand
        and not is_placeholder_brand(cleaned_brand)
        and _fold(cleaned_brand) not in _fold(cleaned_title)
    ):
        text = f"{cleaned_brand} {cleaned_title}" if cleaned_title else ""
    else:
        text = cleaned_title
    return _truncate(text)


def content_hash(model: str, text: str, text_version: int = TEXT_VERSION) -> bytes:
    """sha256(model, metin surumu, metin) ilk 16 bayt: ayni ozet = ayni vektor."""
    payload = f"{model}{SOURCE_SEPARATOR}{text_version}{SOURCE_SEPARATOR}{text}"
    return hashlib.sha256(payload.encode("utf-8")).digest()[:16]


def source_hash(title: str, brand: str | None) -> bytes:
    """SQL `decode(md5(title || chr(31) || coalesce(brand, '')), 'hex')` ile ayni deger.

    Uretimde SQL tarafi hesaplar; bu yardimci testlerin iki tarafin esitligini sinamasi icindir.
    """
    payload = f"{title}{SOURCE_SEPARATOR}{brand or ''}"
    return hashlib.md5(payload.encode("utf-8"), usedforsecurity=False).digest()
