"""Marka normalizasyonu ve basliktan marka/uyumluluk ayrimi (SAF; veritabani yok).

Iki kaynak:
1. Yapilandirilmis marka (`offer.brand_raw`; Hepsiburada/Trendyol verir, AliExpress vermez):
   bos/anlamsiz degerler ("No Brand", "Markasız", "OEM") elenir, kalan ad anahtarla
   (`brand_key`: aksansiz, kucuk harf, yalniz harf/rakam) mevcut markaya baglanir. "XIAOMI",
   "Xiaomi", "xiaomi" ve "Xiao-mi" ayni anahtardir; ikinci marka satiri acilmaz.
2. Baslik: YALNIZCA bu dosyadaki secilmis marka listesi ve yalnizca `title_ok` markalar.
   - "for iPhone", "compatible with Samsung", "iPhone 16 için", "Samsung ile uyumlu":
     uyumluluk bilgisidir, urunun markasi DEGILDIR (`compatible`).
   - Cihaz ureticisi (Apple, Samsung, Xiaomi...) aksesuar kategorilerinde basliktan marka
     olmaz: "Samsung Galaxy S24 Kılıf" cogunlukla ucuncu taraf kilifidir.
   - Iki farkli marka gecerse ve hangisinin urun oldugu belli degilse marka YAZILMAZ.
   - Taklidi yaygin Bati markalari (Apple, Samsung, Sony, JBL, Nike...) `title_ok=False`:
     AliExpress basligindan marka olarak yazilmaz; yalnizca yapilandirilmis kaynak verir.
   Marka kesin degilse uydurulmaz: sonuc `None`.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from classify.text import PhraseIndex, words
from resolve.normalize import strip_accents

_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def brand_key(name: str) -> str:
    """Esitlik anahtari: 'L’Oréal Paris' -> 'lorealparis', 'XIAOMI' -> 'xiaomi'."""
    return _NON_ALNUM.sub("", strip_accents(name).lower())


def name_norm(name: str) -> str:
    """`brand.name_norm` (mevcut sozlesme; arama `b.name_norm` ile karsilastirir)."""
    return strip_accents(name.strip()).lower().replace(" ", "")


#: Anlamsiz marka degerleri (anahtar bicimi).
JUNK_BRAND_KEYS = frozenset(
    {
        "nobrand",
        "noname",
        "nonbrand",
        "unbranded",
        "brandless",
        "generic",
        "oem",
        "odm",
        "none",
        "null",
        "na",
        "nan",
        "yok",
        "markasiz",
        "markayok",
        "marka",
        "brand",
        "diger",
        "digerleri",
        "other",
        "others",
        "various",
        "mixed",
        "standard",
        "standart",
        "universal",
        "genel",
        "belirtilmemis",
        "bilinmiyor",
        "unknown",
        "ozel",
        "ozeluretim",
        "replacement",
        "compatible",
        "uyumlu",
        "hediye",
        "gift",
        "test",
        "sample",
    }
)

MAX_BRAND_CHARS = 60


@dataclass(frozen=True)
class KnownBrand:
    name: str
    aliases: tuple[str, ...]
    #: AliExpress tarzi basliktan marka olarak cikarilabilir mi (resmi magazasi olan,
    #: taklidi seyrek ureticiler).
    title_ok: bool = False
    #: Cihaz ureticisi: aksesuar kategorisinde basliktaki adi uyumluluktur.
    device: bool = False
    #: Markayi ima eden model/alt marka adlari ("redmi" -> Xiaomi, "iphone" -> Apple).
    models: tuple[str, ...] = ()


def B(
    name: str,
    *aliases: str,
    title_ok: bool = False,
    device: bool = False,
    models: tuple[str, ...] = (),
) -> KnownBrand:
    return KnownBrand(name, (name, *aliases), title_ok, device, models)


KNOWN_BRANDS: tuple[KnownBrand, ...] = (
    # Cihaz ureticileri (taklidi yaygin olanlar title_ok=False)
    B(
        "Apple",
        device=True,
        models=(
            "iphone",
            "ipad",
            "airpods",
            "airpod",
            "macbook",
            "imac",
            "apple watch",
            "magsafe",
            "apple pencil",
        ),
    ),
    B("Samsung", device=True, models=("galaxy",)),
    B(
        "Xiaomi",
        "mi home",
        title_ok=True,
        device=True,
        models=("redmi", "poco", "mijia", "mi band", "xiaomi mi"),
    ),
    B("Huawei", title_ok=True, device=True, models=("matebook", "matepad", "freebuds")),
    B("Honor", title_ok=True, device=True),
    B("Oppo", title_ok=True, device=True),
    B("Vivo", title_ok=True, device=True),
    B("Realme", title_ok=True, device=True),
    B("OnePlus", "one plus", title_ok=True, device=True),
    B("Lenovo", title_ok=True, device=True, models=("thinkpad", "thinkplus", "thinkbook")),
    B("Google", device=True, models=("pixel",)),
    B("Motorola", device=True),
    B("Nokia", device=True),
    B("Sony", device=True, models=("playstation", "ps4", "ps5")),
    B("Microsoft", device=True, models=("xbox",)),
    B("Nintendo", device=True, models=("nintendo switch",)),
    B("LG", device=True),
    B("Asus", device=True, models=("rog phone", "zenbook", "vivobook")),
    B("Dell", device=True),
    B("HP", "hewlett packard", device=True),
    B("Acer", device=True),
    B("Garmin", device=True),
    B("Amazfit", title_ok=True, device=True),
    B("Tecno", title_ok=True, device=True),
    B("Infinix", title_ok=True, device=True),
    B("Blackview", title_ok=True, device=True),
    B("Doogee", title_ok=True, device=True),
    B("Ulefone", title_ok=True, device=True),
    B("Oukitel", title_ok=True, device=True),
    B("Cubot", title_ok=True, device=True),
    B("DJI", title_ok=True, device=True),
    B("Insta360", title_ok=True, device=True),
    B("GoPro", device=True),
    # AliExpress'te resmi magazasi olan aksesuar/elektronik ureticileri
    B("Baseus", title_ok=True),
    B("Ugreen", title_ok=True),
    B("Anker", title_ok=True),
    B("Haylou", title_ok=True),
    B("QCY", title_ok=True),
    B("Soundpeats", title_ok=True),
    B("Edifier", title_ok=True),
    B("Redragon", title_ok=True),
    B("Orico", title_ok=True),
    B("Essager", title_ok=True),
    B("Vention", title_ok=True),
    B("Hoco", title_ok=True),
    B("Remax", title_ok=True),
    B("Joyroom", title_ok=True),
    B("Zeblaze", title_ok=True),
    B("Kospet", title_ok=True),
    B("Dreame", title_ok=True),
    B("Roborock", title_ok=True),
    B("Moondrop", title_ok=True),
    B("FiiO", title_ok=True),
    B("Tronsmart", title_ok=True),
    B("Bluedio", title_ok=True),
    B("Awei", title_ok=True),
    B("70mai", title_ok=True),
    B("Fifine", title_ok=True),
    B("Maono", title_ok=True),
    B("Keychron", title_ok=True),
    B("Ajazz", title_ok=True),
    B("Royal Kludge", title_ok=True),
    B("Epomaker", title_ok=True),
    B("Machenike", title_ok=True),
    B("GameSir", title_ok=True),
    B("8BitDo", title_ok=True),
    B("Flydigi", title_ok=True),
    B("Deerma", title_ok=True),
    B("Usams", title_ok=True),
    B("Mcdodo", title_ok=True),
    B("Nillkin", title_ok=True),
    # Taklidi yaygin: yalnizca yapilandirilmis kaynaktan
    B("JBL"),
    B("Bose"),
    B("Beats"),
    B("Logitech"),
    B("Razer"),
    B("HyperX"),
    B("Philips"),
    B("Dyson"),
    B("Bosch"),
    B("Makita"),
    B("DeWalt"),
    B("Milwaukee"),
    B("Casio"),
    B("Rolex"),
    B("Nike"),
    B("Adidas"),
    B("Puma"),
    B("Gucci"),
    B("Louis Vuitton"),
    B("Chanel"),
    B("Lego"),
)

#: Ingilizce onek isaretleri: bunlardan SONRA gecen marka uyumluluktur.
PREFIX_MARKERS = (
    "for",
    "fit",
    "fits",
    "fitting",
    "compatible",
    "compatibility",
    "suitable",
    "replacement",
    "replace",
    "designed for",
    "works with",
    "pour",
    "para",
)
#: Turkce sonek isaretleri: marka (+ model kelimeleri) bunlardan HEMEN ONCE geliyorsa uyumluluk.
POSTFIX_MARKERS = ("icin", "uyumlu", "uyumludur", "uyumlu olan", "uyar")
_POSTFIX_FILLERS = frozenset({"ile", "ve", "serisi", "series", "model", "modeli", "modelleri"})
_MODEL_WORDS = frozenset(
    {
        "pro",
        "max",
        "plus",
        "ultra",
        "mini",
        "lite",
        "se",
        "note",
        "edition",
        "gen",
        "generation",
        "air",
        "fold",
        "flip",
        "fe",
        "neo",
        "prime",
        "turbo",
        "x",
        "s",
        "a",
        "m",
        "c",
        "k",
        "t",
        "z",
        "5g",
        "4g",
        "watch",
        "band",
        "buds",
        "galaxy",
        "iphone",
        "ipad",
        "redmi",
        "poco",
        "mi",
        "tab",
        "pad",
        "book",
        "phone",
        "mate",
        "nova",
        "p",
        "y",
    }
)
#: Bu konumdan sonra gecen marka adi urunun markasi sayilmaz (anahtar kelime yigini).
MAX_BRAND_POSITION = 8


@dataclass(frozen=True)
class BrandFinding:
    brand: str | None
    basis: str  # 'title' | 'none' | 'ambiguous'
    compatible: tuple[str, ...]


@dataclass(frozen=True)
class _Mention:
    brand: KnownBrand
    via_model: bool


def _build_index() -> PhraseIndex[_Mention]:
    entries: list[tuple[str, _Mention]] = []
    for brand in KNOWN_BRANDS:
        entries.extend((alias, _Mention(brand, False)) for alias in brand.aliases)
        entries.extend((model, _Mention(brand, True)) for model in brand.models)
    return PhraseIndex(entries)


_INDEX = _build_index()
_PREFIX = PhraseIndex((m, True) for m in PREFIX_MARKERS)
_POSTFIX = PhraseIndex((m, True) for m in POSTFIX_MARKERS)
BY_KEY: dict[str, KnownBrand] = {
    brand_key(alias): brand for brand in KNOWN_BRANDS for alias in brand.aliases
}


def _is_model_word(word: str) -> bool:
    return word in _MODEL_WORDS or any(ch.isdigit() for ch in word)


def find_title_brand(title: str, *, accessory: bool, category_known: bool = True) -> BrandFinding:
    """`category_known=False`: cihaz ureticisi marka olarak yazilmaz (aksesuar olabilir)."""
    text = words(title)
    hits = _INDEX.find(text)
    if not hits:
        return BrandFinding(None, "none", ())
    first_prefix = min((start for start, _, _ in _PREFIX.find(text)), default=None)
    postfix_at = {start for start, _, _ in _POSTFIX.find(text)}

    # Ayni yerde hem "xiaomi" hem "xiaomi mi" eslesebilir: en uzun eslesme kazanir.
    hits.sort(key=lambda h: (h[0], -h[1]))
    taken: set[int] = set()
    compatible: list[str] = []
    candidates: dict[str, KnownBrand] = {}
    restricted: set[str] = set()
    for start, length, mention in hits:
        span = set(range(start, start + length))
        if span & taken:
            continue
        taken |= span
        brand = mention.brand
        compat = first_prefix is not None and first_prefix < start
        if not compat:
            cursor = start + length
            while cursor < len(text) and (
                _is_model_word(text[cursor]) or text[cursor] in _POSTFIX_FILLERS
            ):
                cursor += 1
            compat = cursor in postfix_at
        if not compat and accessory and brand.device:
            compat = True
        if compat:
            if brand.name not in compatible:
                compatible.append(brand.name)
            continue
        if start >= MAX_BRAND_POSITION:
            continue
        if brand.title_ok and (category_known or not brand.device):
            candidates[brand.name] = brand
        else:
            restricted.add(brand.name)

    compat_out = tuple(compatible[:8])
    names = set(candidates) | restricted
    if len(names) > 1:
        return BrandFinding(None, "ambiguous", compat_out)
    if len(candidates) == 1:
        return BrandFinding(next(iter(candidates)), "title", compat_out)
    return BrandFinding(None, "none", compat_out)


def clean_source_brand(raw: str | None, *, merchant_name: str | None = None) -> str | None:
    """Yapilandirilmis marka alanindan gorunen ad; anlamsizsa None."""
    if not raw:
        return None
    name = " ".join(raw.split())
    key = brand_key(name)
    if (
        len(key) < 2
        or len(name) > MAX_BRAND_CHARS
        or key.isdigit()
        or key in JUNK_BRAND_KEYS
        or (merchant_name is not None and key == brand_key(merchant_name))
    ):
        return None
    known = BY_KEY.get(key)
    if known is not None:
        return known.name
    letters = [c for c in name if c.isalpha()]
    if len(letters) > 4 and all(c.isupper() for c in letters):
        # "XIAOMI" -> "Xiaomi"; kisa kisaltmalar ("JBL", "LG") korunur.
        return " ".join(part.capitalize() for part in name.split())
    return name
