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
    #: Yalniz basligin ilk iki kelimesinde marka sayilir (karar 0139): sanayi markalari satici
    #: basligin basinda yazar ("KEYENCE LV-N11N"), ortada gecerse uyumluluk ya da aciklamadir.
    lead_only: bool = False


def B(
    name: str,
    *aliases: str,
    title_ok: bool = False,
    device: bool = False,
    models: tuple[str, ...] = (),
    lead_only: bool = False,
) -> KnownBrand:
    return KnownBrand(name, (name, *aliases), title_ok, device, models, lead_only)


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
    B("Honor", title_ok=True, device=True, lead_only=True),  # "Honor Courage Valor" (karar 0139)
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
    # Olcu aleti, teshis, akilli ev, oto parca ureticileri (gercek AliExpress ornekleminde sik
    # ve resmi magazali; karar 0138). Saticinin magaza oneki ("LTT", "DSA", "AZGIANT") DEGIL.
    B("UNI-T", title_ok=True),
    B("Aneng", title_ok=True),
    B("Fnirsi", title_ok=True),
    B("HoldPeak", title_ok=True),
    B("Inkbird", title_ok=True),
    B("Xtool", title_ok=True),
    B("MaXpeedingrods", title_ok=True),
    B("Zonesun", title_ok=True),
    B("Sonoff", title_ok=True),
    B("Aqara", title_ok=True),
    B("Yeelight", title_ok=True),
    B("Moes", title_ok=True),
    B("Zemismart", title_ok=True),
    # Ekosistem/platform ve arac ureticileri: basliktaki adi uyumluluktur, urunun markasi degil.
    B("Tuya", device=True, models=("smart life",)),
    B("BMW", device=True),
    B("Mercedes-Benz", "mercedes", "benz", device=True),
    B("Audi", device=True),
    B("Volkswagen", "vw", device=True, models=("passat", "tiguan")),
    B("Toyota", device=True, models=("corolla", "camry", "hilux", "prado", "rav4")),
    B("Honda", device=True, models=("civic", "accord")),
    B("Ford", device=True, models=("mustang",)),
    B("Hyundai", device=True),
    B("Kia", device=True),
    B("Nissan", device=True),
    B("Mazda", device=True),
    B("Renault", device=True),
    B("Peugeot", device=True),
    B("Fiat", device=True),
    B("Opel", device=True),
    B("Skoda", device=True),
    B("Chevrolet", device=True),
    B("Jeep", device=True),
    B("Land Rover", device=True, models=("range rover",)),
    B("Volvo", device=True),
    B("Tesla", device=True),
    B("BYD", device=True),
    B("Subaru", device=True),
    B("Mitsubishi", device=True),
    B("Suzuki", device=True),
    B("Lexus", device=True),
    B("Porsche", device=True),
    B("Citroen", device=True),
    B("Dacia", device=True),
    B("Stihl", device=True),
    B("Delonghi", "de longhi", device=True),
    B("Nespresso", device=True),
    # Sanayi otomasyonu/olcum markalari (karar 0139): yalniz basligin basinda.
    B("Keyence", title_ok=True, lead_only=True),
    B("ABB", title_ok=True, lead_only=True),
    B("IFM", title_ok=True, lead_only=True),
    B("SMC", title_ok=True, lead_only=True),
    B("Omron", title_ok=True, lead_only=True),
    B("Siemens", title_ok=True, lead_only=True),
    B("Schneider", "schneider electric", title_ok=True, lead_only=True),
    B("Festo", title_ok=True, lead_only=True),
    B("Yaskawa", title_ok=True, lead_only=True),
    B("Autonics", title_ok=True, lead_only=True),
    B("Mean Well", "meanwell", title_ok=True, lead_only=True),
    B("Hikvision", title_ok=True, lead_only=True),
    B("Dahua", title_ok=True, lead_only=True),
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
    # AliExpress parca basliklari (karar 0138): "Applicable To Delonghi", "Apply To Nespresso",
    # "Used For Makita", "Car Key Matching Toyota", "Adapter Bosch to Makita".
    "applicable",
    "apply to",
    "use for",
    "used for",
    "use with",
    "used with",
    "suit for",
    "suits",
    "matching",
    "adapter",
    "adaptor",
    "converter",
    "to",
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


#: Marka bos kalma nedenleri (olculebilir rapor; `BrandFinding.reason`). Veritabanina yazilmaz.
NO_KNOWN_BRAND = "no_known_brand"  # basliktaki hicbir ad secilmis listede degil
COMPATIBLE_ONLY = "compatible_only"  # ad var ama uyumluluk ("for Makita")
COUNTERFEIT_PRONE = "counterfeit_prone"  # taklidi yaygin marka: yalniz yapilandirilmis kaynak
DEVICE_NEEDS_CATEGORY = "device_needs_category"  # cihaz ureticisi, kategori bilinmiyor
LATE_POSITION = "late_position"  # ad basligin cok ilerisinde / lead_only disinda
AMBIGUOUS = "ambiguous"  # birden fazla marka, hangisi urun belli degil


@dataclass(frozen=True)
class BrandFinding:
    brand: str | None
    basis: str  # 'title' | 'none' | 'ambiguous'
    compatible: tuple[str, ...]
    #: basis != 'title' ise nedeni (yukaridaki sabitler).
    reason: str | None = None


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
        return BrandFinding(None, "none", (), NO_KNOWN_BRAND)
    first_prefix = min((start for start, _, _ in _PREFIX.find(text)), default=None)
    postfix_at = {start for start, _, _ in _POSTFIX.find(text)}

    # Ayni yerde hem "xiaomi" hem "xiaomi mi" eslesebilir: en uzun eslesme kazanir.
    hits.sort(key=lambda h: (h[0], -h[1]))
    taken: set[int] = set()
    compatible: list[str] = []
    candidates: dict[str, KnownBrand] = {}
    restricted: set[str] = set()
    reasons: list[str] = []
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
        if start >= MAX_BRAND_POSITION or (brand.lead_only and start > 1):
            reasons.append(LATE_POSITION)
            continue
        if brand.title_ok and (category_known or not brand.device):
            candidates[brand.name] = brand
        else:
            restricted.add(brand.name)
            reasons.append(COUNTERFEIT_PRONE if not brand.title_ok else DEVICE_NEEDS_CATEGORY)

    compat_out = tuple(compatible[:8])
    names = set(candidates) | restricted
    if len(names) > 1:
        return BrandFinding(None, "ambiguous", compat_out, AMBIGUOUS)
    if len(candidates) == 1:
        return BrandFinding(next(iter(candidates)), "title", compat_out)
    reason = reasons[0] if reasons else COMPATIBLE_ONLY
    return BrandFinding(None, "none", compat_out, reason)


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
