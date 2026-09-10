"""Baslik normalizasyonu ve ayirt edici oznitelik cikarimi.

Eslestirmenin dogrulugu buraya dayanir. Iki is yapar:

1. **Normalize eder** — Turkce karakter, pazarlama eki, kelime sirasi
   farklarini silip trigram karsilastirmasini anlamli kilar.
2. **Ayirt edici ozellikleri cikarir** — renk ve hacim/beden. Bunlar skoru
   dusuren degil, esleşmeyi VETO EDEN bilgilerdir.

Renk neden veto: `docs/schema.sql` "product renk duzeyinde kanoniktir: siyah
ve bej ayri urundur" diyor. "Kuzey Deri Bilekli Bot Siyah" ile "... Bej"
trigram'da %90'in ustunde benzer; veto olmazsa otomatik kabul esigini gecer
ve iki ayri urun sessizce birlesir.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

WHITESPACE = re.compile(r"\s+")

#: Urunu tanimlamayan, magazadan magazaya degisen ekler.
NOISE_WORDS = frozenset(
    {
        "indirimli",
        "kampanyali",
        "yeni",
        "sezon",
        "ucretsiz",
        "hizli",
        "kargo",
        "orjinal",
        "orijinal",
        "outlet",
        "firsat",
        "ozel",
        "urun",
        "urunu",
    }
)

#: Yaygin kisaltmalar. Magazalar baslik uzunlugu icin kisaltiyor.
ABBREVIATIONS = {
    "ayk": "ayakkabi",
    "aykb": "ayakkabi",
    "cnt": "canta",
    "gmlk": "gomlek",
    "pnt": "pantolon",
    "tsrt": "tisort",
    "swt": "sweatshirt",
    "elb": "elbise",
}

#: Renk sozlugu. Es anlamlilar tek bir kanonik ada indirgenir; "lacivert" ile
#: "navy" ayni rengi anlatir ve eslesmeyi VETO ETMEMELI.
COLOR_SYNONYMS = {
    "siyah": "siyah",
    "black": "siyah",
    "beyaz": "beyaz",
    "white": "beyaz",
    "ekru": "beyaz",
    "kirik": "beyaz",
    "bej": "bej",
    "beige": "bej",
    "camel": "bej",
    "tas": "bej",
    "lacivert": "lacivert",
    "navy": "lacivert",
    "mavi": "mavi",
    "blue": "mavi",
    "kahverengi": "kahverengi",
    "brown": "kahverengi",
    "kahve": "kahverengi",
    "yesil": "yesil",
    "green": "yesil",
    "haki": "yesil",
    "bordo": "bordo",
    "burgundy": "bordo",
    "kirmizi": "kirmizi",
    "red": "kirmizi",
    "gri": "gri",
    "grey": "gri",
    "gray": "gri",
    "antrasit": "gri",
    "pembe": "pembe",
    "pink": "pembe",
    "pudra": "pembe",
    "mor": "mor",
    "purple": "mor",
    "lila": "mor",
    "sari": "sari",
    "yellow": "sari",
    "hardal": "sari",
    "turuncu": "turuncu",
    "orange": "turuncu",
    "vizon": "vizon",
    "gumus": "gumus",
    "silver": "gumus",
    "altin": "altin",
    "gold": "altin",
}

#: "50 ml", "100ml", "1.5 l", "250 gr" — hacim/agirlik ayirt edicidir.
VOLUME = re.compile(r"\b(\d+(?:[.,]\d+)?)\s*(ml|l|lt|litre|gr|g|kg|cl)\b")

#: "42 numara", "beden 38" — beden de ayirt edicidir.
NUMERIC_SIZE = re.compile(r"\b(\d{2})\s*(?:numara|beden|no)\b")

#: Model kademesi belirten ekler. "Kosu Ayakkabisi Pro" ile "Kosu Ayakkabisi"
#: AYRI urunlerdir; baslik neredeyse aynidir, o yuzden renk gibi VETO edilir.
#: Regresyon seti bunu yakaladi: veto olmadan bu cift 1.000 skor aliyordu.
MODEL_QUALIFIERS = frozenset(
    {"pro", "plus", "max", "mini", "lite", "ultra", "air", "premium", "classic", "sport", "xl"}
)

#: Surum eki: "V2", "Gen 3", "2. Nesil". Kelime listesiyle yakalanamaz cunku
#: sayi degiskendir. Kademe eki gibi VETO edilir — "Kosu Ayakkabisi V2" ile
#: "Kosu Ayakkabisi" ayri urunlerdir.
VERSION = re.compile(r"\b(?:v\s*(\d+)|gen\s*(\d+)|(\d+)\s*\.?\s*nesil)\b")


def strip_accents(value: str) -> str:
    """Turkce karakterleri ASCII karsiligina indirger.

    `casefold` kullanilmaz: Turkcede I/i donusumu bozuk. Once noktali/noktasiz
    i acikca esitlenir, sonra aksan ayristirmasi yapilir.
    """
    text = value.replace("İ", "i").replace("I", "ı").replace("ı", "i")
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(char for char in decomposed if not unicodedata.combining(char))


def _volume_token(match: re.Match[str]) -> str:
    """VOLUME eslesmesini tek bir token'a cevirir: "50 ml" -> " 50ml ".

    Ayri token olarak kalirsa "50" ile "ml" bagimsiz kelimeler gibi
    davranir ve "50 ml" ile "50ml" farkli kumeler uretir.
    """
    amount = match.group(1).replace(",", ".").rstrip("0").rstrip(".")
    unit = {"lt": "l", "litre": "l", "g": "gr"}.get(match.group(2), match.group(2))
    return f" {amount}{unit} "


def title_tokens(value: str, brand: str | None = None) -> frozenset[str]:
    """Baslıgi karsilastirilabilir token kumesine cevirir.

    Neden kume: urun basliklari kisa. Karakter duzeyinde benzerlik
    ("Kosu Ayakkabisi Pro" vs "Kosu Ayakkabisi") bir kelimelik farki kucuk
    gosterir; token duzeyinde ayni fark buyuktur. Regresyon seti bunu
    olcerek ortaya cikardi.

    Marka token'lari CIKARILIR: marka ayri bir alanda karsilastiriliyor ve
    basligin icinde olup olmamasi magazadan magazaya degisiyor.
    """
    text = strip_accents(value).lower()
    # Hacim tek bir token olsun: "50 ml" ve "50ml" ayni seydir.
    text = VOLUME.sub(_volume_token, text)
    text = re.sub(r"[^a-z0-9\s]", " ", text)

    brand_tokens = set()
    if brand:
        brand_text = re.sub(r"[^a-z0-9\s]", " ", strip_accents(brand).lower())
        brand_tokens = {word for word in WHITESPACE.split(brand_text) if word}

    tokens: set[str] = set()
    for word in WHITESPACE.split(text):
        if not word or len(word) < 2 or word in NOISE_WORDS or word in brand_tokens:
            continue
        word = ABBREVIATIONS.get(word, word)
        # Renk es anlamlilari kanonik ada indirgenir: "navy" ile "lacivert"
        # ayni token olur, yoksa eslesme bosuna dusuk cikar.
        tokens.add(COLOR_SYNONYMS.get(word, word))
    return frozenset(tokens)


def normalize_title(value: str, brand: str | None = None) -> str:
    """Token kumesinin kararli metin hali — log ve hata ayiklama icin."""
    return " ".join(sorted(title_tokens(value, brand)))


def extract_color(value: str) -> str | None:
    """Baslikta gecen ilk rengi kanonik adiyla dondurur."""
    text = strip_accents(value).lower()
    for word in WHITESPACE.split(re.sub(r"[^a-z0-9\s]", " ", text)):
        canonical = COLOR_SYNONYMS.get(word)
        if canonical:
            return canonical
    return None


def extract_volume(value: str) -> str | None:
    """'50 ml' -> '50ml'. Birim normalize edilir (lt/litre -> l, g -> gr)."""
    match = VOLUME.search(strip_accents(value).lower())
    if not match:
        return None
    amount = match.group(1).replace(",", ".").rstrip("0").rstrip(".")
    unit = {"lt": "l", "litre": "l", "g": "gr"}.get(match.group(2), match.group(2))
    return f"{amount}{unit}"


def extract_numeric_size(value: str) -> str | None:
    match = NUMERIC_SIZE.search(strip_accents(value).lower())
    return match.group(1) if match else None


def extract_version(value: str) -> str | None:
    """'V2', 'Gen 3', '2. Nesil' -> 'v2' / 'v3'."""
    match = VERSION.search(strip_accents(value).lower())
    if not match:
        return None
    number = next(group for group in match.groups() if group)
    return f"v{number}"


def extract_qualifier(tokens: frozenset[str], title: str = "") -> str | None:
    """Baslikta model kademesi ya da surum eki var mi.

    Iki kaynak birlestirilir: sabit kelime listesi (pro, plus, mini...) ve
    surum orunt (v2, gen 3, 2. nesil). Sayi degisken oldugu icin ikincisi
    kelime listesiyle yakalanamaz.
    """
    word = sorted(tokens & MODEL_QUALIFIERS)
    parts = [part for part in (word[0] if word else None, extract_version(title)) if part]
    return "+".join(parts) if parts else None


@dataclass(frozen=True)
class ProductKey:
    """Bir teklifin ya da urunun eslestirmede kullanilan ozeti."""

    tokens: frozenset[str]
    brand_norm: str | None
    color: str | None
    volume: str | None
    size: str | None
    qualifier: str | None = None
    gtin: str | None = None
    mpn: str | None = None

    @property
    def title_norm(self) -> str:
        return " ".join(sorted(self.tokens))

    @classmethod
    def build(
        cls,
        title: str,
        brand: str | None = None,
        color: str | None = None,
        gtin: str | None = None,
        mpn: str | None = None,
    ) -> ProductKey:
        # Renk acik alanda verilmisse ona guvenilir; yoksa basliktan cikarilir.
        resolved_color = COLOR_SYNONYMS.get(strip_accents(color or "").lower()) or extract_color(
            title
        )
        tokens = title_tokens(title, brand)
        return cls(
            tokens=tokens,
            brand_norm=" ".join(sorted(title_tokens(brand))) if brand else None,
            color=resolved_color,
            volume=extract_volume(title),
            size=extract_numeric_size(title),
            qualifier=extract_qualifier(tokens, title),
            gtin=(gtin or "").strip() or None,
            mpn=(mpn or "").strip() or None,
        )
