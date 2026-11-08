"""Surumlu, deterministik ve kaynak izli embedding metni hazirlama (karar 0180).

Uretimdeki urun metni HALA `enrich/product_text.py` (`TEXT_VERSION=1`: marka + baslik) ile
uretilir; bu modul onu degistirmez. Burasi daha zengin metin (model, kategori, ozellikler, uzun
aciklama) gerektiren modellerin pilotu ve gelecekteki indeksleri icindir.

Ozellikler:

- **Deterministik:** NFKC, kontrol karakteri temizligi, sabit alan sirasi, sirali ozellik
  anahtarlari.
  Ayni girdi her zaman bayt bayt ayni metni ve ayni ozeti verir.
- **Kaynak izi:** cikan metindeki her parca hangi alandan geldigini `Span` ile tasir; bir vektorun
  hangi veriden uretildigi sonradan aciklanabilir.
- **Tokenizer uyumlu:** butce `max_tokens` ile verilir; gercek tokenizer verilirse onunla, yoksa
  kayit defterindeki `chars_per_token` tahminiyle olculur.
- **Parcalama:** uzun aciklama sozcuk sinirinda, ortusmeli parcalara bolunur; her parca kendi
  sirasini ve icerik ozetini tasir.

Kural degisirse `PREP_VERSION` artirilir; ozet surumu icerdiginden eski vektorler ayrisir.
"""

from __future__ import annotations

import hashlib
import math
import re
import unicodedata
from collections.abc import Callable, Mapping
from dataclasses import dataclass

from enrich.product_text import is_placeholder_brand

PREP_VERSION = 2
SEPARATOR = "\x1f"

#: Metne girme sirasi. Aciklama en sondadir: butce dolunca once o kirpilir/parcalanir.
FIELD_ORDER = ("brand", "title", "model", "category", "attributes", "description")

_WHITESPACE = re.compile(r"\s+")

TokenCounter = Callable[[str], int]


@dataclass(frozen=True)
class Span:
    field: str
    start: int
    end: int


@dataclass(frozen=True)
class PreparedText:
    text: str
    version: int
    spans: tuple[Span, ...]
    content_hash: bytes
    tokens: int
    truncated: bool


@dataclass(frozen=True)
class Chunk:
    index: int
    text: str
    content_hash: bytes
    tokens: int


@dataclass(frozen=True)
class ProductFields:
    title: str | None
    brand: str | None = None
    model: str | None = None
    category_path: tuple[str, ...] = ()
    attributes: Mapping[str, object] | None = None
    description: str | None = None


def clean(value: object) -> str:
    """NFKC, kontrol karakterleri bosluga, tek bosluk. Buyuk/kucuk harf korunur."""
    if value is None:
        return ""
    text = unicodedata.normalize("NFKC", str(value))
    text = "".join(" " if unicodedata.category(ch).startswith("C") else ch for ch in text)
    return _WHITESPACE.sub(" ", text).strip()


def estimate_counter(chars_per_token: float) -> TokenCounter:
    def count(text: str) -> int:
        return math.ceil(len(text) / chars_per_token) if text else 0

    return count


def text_hash(model: str, text: str, version: int = PREP_VERSION) -> bytes:
    """sha256(model, surum, metin) ilk 16 bayt — `product_text.content_hash` ile ayni bicim."""
    payload = f"{model}{SEPARATOR}{version}{SEPARATOR}{text}"
    return hashlib.sha256(payload.encode("utf-8")).digest()[:16]


def _attributes_text(attributes: Mapping[str, object] | None) -> str:
    if not attributes:
        return ""
    parts = []
    for key in sorted(attributes, key=lambda k: clean(k).casefold()):
        value = attributes[key]
        if isinstance(value, list | tuple):
            value = ", ".join(clean(v) for v in value if clean(v))
        name, text = clean(key), clean(value)
        if name and text:
            parts.append(f"{name}: {text}")
    return "; ".join(parts)


def _field_texts(fields: ProductFields) -> list[tuple[str, str]]:
    title = clean(fields.title)
    brand = clean(fields.brand)
    if brand and (is_placeholder_brand(brand) or brand.casefold() in title.casefold()):
        brand = ""
    model = clean(fields.model)
    if model and model.casefold() in title.casefold():
        model = ""
    values = {
        "brand": brand,
        "title": title,
        "model": model,
        "category": " > ".join(c for c in (clean(p) for p in fields.category_path) if c),
        "attributes": _attributes_text(fields.attributes),
        "description": clean(fields.description),
    }
    return [(name, values[name]) for name in FIELD_ORDER if values[name]]


def _cut_to_budget(text: str, budget: int, count: TokenCounter) -> str:
    """Sozcuk sinirinda, `count(sonuc) <= budget` olacak en uzun onek (ikili arama)."""
    if count(text) <= budget:
        return text
    words = text.split(" ")
    lo, hi = 0, len(words)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if count(" ".join(words[:mid])) <= budget:
            lo = mid
        else:
            hi = mid - 1
    return " ".join(words[:lo])


def prepare_product_text(
    fields: ProductFields,
    *,
    model: str,
    max_tokens: int,
    count: TokenCounter,
    include: tuple[str, ...] = FIELD_ORDER,
) -> PreparedText:
    """Alanlari sabit sirayla birlestirir; butceyi asan son alan sozcuk sinirinda kirpilir."""
    pieces: list[str] = []
    spans: list[Span] = []
    position = 0
    truncated = False
    for name, value in _field_texts(fields):
        if name not in include:
            continue
        joiner = ". " if pieces else ""
        room = max_tokens - count("".join(pieces) + joiner)
        candidate = _cut_to_budget(value, room, count) if room > 0 else ""
        if candidate != value:
            truncated = True
        if not candidate:
            break
        start = position + len(joiner)
        pieces.append(joiner + candidate)
        spans.append(Span(name, start, start + len(candidate)))
        position = start + len(candidate)
        if truncated:
            break
    text = "".join(pieces)
    return PreparedText(
        text=text,
        version=PREP_VERSION,
        spans=tuple(spans),
        content_hash=text_hash(model, text),
        tokens=count(text),
        truncated=truncated,
    )


def chunk_text(
    text: str,
    *,
    model: str,
    max_tokens: int,
    overlap_tokens: int,
    count: TokenCounter,
) -> list[Chunk]:
    """Sozcuk sinirinda, ortusmeli parcalar. Ayni girdi -> ayni parcalar ve ozetler."""
    if max_tokens < 1 or not 0 <= overlap_tokens < max_tokens:
        raise ValueError("0 <= overlap_tokens < max_tokens olmali")
    words = clean(text).split(" ") if clean(text) else []
    chunks: list[Chunk] = []
    start = 0
    while start < len(words):
        end = start
        while end < len(words) and count(" ".join(words[start : end + 1])) <= max_tokens:
            end += 1
        if end == start:  # tek sozcuk butceden buyuk: tek basina parca olur
            end = start + 1
        piece = " ".join(words[start:end])
        chunks.append(Chunk(len(chunks), piece, text_hash(model, piece), count(piece)))
        if end >= len(words):
            break
        back = end
        while back > start + 1 and count(" ".join(words[back - 1 : end])) <= overlap_tokens:
            back -= 1
        start = back if back < end else end
    return chunks
