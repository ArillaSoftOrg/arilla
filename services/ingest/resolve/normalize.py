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
from decimal import Decimal, InvalidOperation

from resolve.identity import clean_gtin, clean_mpn

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

#: "256 GB", "1 TB": depolama kapasitesi ayirt edicidir; "256 GB" ile "256GB" ayni olsun.
STORAGE = re.compile(r"\b(\d+)\s*(gb|tb)\b")

#: Urun kodu: "AB-1234", "HD-7432X". Tire ayiricidir ama kodun parcasi: "AB1234" ile
#: ayni olsun. Yalniz kisa harf + sayi bicimi; "t-shirt", "Lifting-sil" etkilenmez.
PRODUCT_CODE = re.compile(r"\b([a-z]{1,4})-(\d{2,}[a-z]?)\b")

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


def _canonical_amount(raw: str) -> str:
    """"100" -> "100", "50,0" -> "50", "0,50" -> "0.5".

    Yalnizca ONDALIK kisimdaki sondaki sifirlar anlamsizdir. Tam sayidaki
    sifirlar anlamlidir: "100" ile "10" farkli hacimdir (eskiden
    `rstrip("0")` ikisini de "1" yapiyordu).
    """
    text = raw.replace(",", ".")
    try:
        number = Decimal(text)
    except InvalidOperation:
        return text
    return format(number.normalize(), "f")


def _volume_token(match: re.Match[str]) -> str:
    """VOLUME eslesmesini tek bir token'a cevirir: "50 ml" -> " 50ml ".

    Ayri token olarak kalirsa "50" ile "ml" bagimsiz kelimeler gibi
    davranir ve "50 ml" ile "50ml" farkli kumeler uretir.
    """
    amount = _canonical_amount(match.group(1))
    unit = {"lt": "l", "litre": "l", "g": "gr"}.get(match.group(2), match.group(2))
    return f" {amount}{unit} "


def _version_token(match: re.Match[str]) -> str:
    """"v2" / "gen 2" / "2. nesil" -> " v2 ": ayni surum tek token olsun."""
    number = next(group for group in match.groups() if group)
    return f" v{number} "


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
    text = VERSION.sub(_version_token, text)
    text = PRODUCT_CODE.sub(r"\1\2", text)
    text = STORAGE.sub(lambda m: f" {m.group(1)}{m.group(2)} ", text)
    text = re.sub(r"[^a-z0-9\s]", " ", text)

    brand_tokens = set()
    if brand:
        brand_text = re.sub(r"[^a-z0-9\s]", " ", strip_accents(brand).lower())
        brand_tokens = {word for word in WHITESPACE.split(brand_text) if word}

    tokens: set[str] = set()
    for word in WHITESPACE.split(text):
        # Tek haneli SAYI kimliktir ("iPhone 7" / "iPhone 6"); yalniz tek harf atilir.
        if not word or (len(word) < 2 and not word.isdigit()):
            continue
        if word in NOISE_WORDS or word in brand_tokens:
            continue
        word = ABBREVIATIONS.get(word, word)
        # Renk es anlamlilari kanonik ada indirgenir: "navy" ile "lacivert"
        # ayni token olur, yoksa eslesme bosuna dusuk cikar.
        tokens.add(COLOR_SYNONYMS.get(word, word))
    return frozenset(tokens)


def normalize_title(value: str, brand: str | None = None) -> str:
    """Token kumesinin kararli metin hali — log ve hata ayiklama icin."""
    return " ".join(sorted(title_tokens(value, brand)))


#: Renk zincirini baglayan ayiricilar: "Siyah/Beyaz", "Siyah - Beyaz", "Siyah ve Beyaz".
_COLOR_JOINERS = frozenset({"/", "&", ",", "-", "ve"})

#: Renk sozcugu gibi gorunen ama urun adi olan sozcukler: ardindan bu isimler
#: geliyorsa renk DEGILDIR ("Kahve Makinesi" kahverengi degil).
_NOT_A_COLOR_BEFORE = {
    "kahve": frozenset(
        {
            "makinesi",
            "makinasi",
            "makina",
            "fincani",
            "fincan",
            "degirmeni",
            "ogutucu",
            "kapsul",
            "kapsulu",
            "filtresi",
            "filtre",
            "seti",
            "bardagi",
            "bardak",
            "cekirdegi",
            "kasigi",
            "cezvesi",
            "kupasi",
            "kupa",
            "termosu",
            "demlik",
            "demligi",
            "kremasi",
            "aparati",
        }
    ),
}

#: Tek basina renk olmayan, yalniz belirli bir sozcukle renk olan sozcukler:
#: "kirik" tek basina "kirik" demektir, "kirik beyaz" ise beyazdir.
_COLOR_ONLY_BEFORE = {"kirik": frozenset({"beyaz", "krem"})}


def _color_at(words: list[str], index: int, brand_tokens: frozenset[str]) -> str | None:
    word = words[index]
    canonical = COLOR_SYNONYMS.get(word)
    # Marka adinin parcasi olan renk sozcugu renk degildir ("Mavi" markasi).
    if canonical is None or word in brand_tokens:
        return None
    following = words[index + 1] if index + 1 < len(words) else ""
    if following in _NOT_A_COLOR_BEFORE.get(word, frozenset()):
        return None
    required = _COLOR_ONLY_BEFORE.get(word)
    if required is not None and following not in required:
        return None
    return canonical


def extract_color(value: str, brand: str | None = None) -> str | None:
    """Baslikta gecen ilk rengi (ya da bitisik renk zincirini) kanonik adla dondurur.

    "Siyah/Beyaz" ile "Beyaz/Siyah" ayni sonucu verir ("beyaz-siyah"): zincir
    sirali birlestirilir. Marka adindaki ve urun adi olan sozcukler renk sayilmaz.
    """
    text = strip_accents(value).lower()
    words = re.findall(r"[a-z0-9]+|[/&,\-]", text)
    brand_tokens = (
        frozenset(re.findall(r"[a-z0-9]+", strip_accents(brand).lower())) if brand else frozenset()
    )
    for index in range(len(words)):
        first = _color_at(words, index, brand_tokens)
        if first is None:
            continue
        chain = [first]
        cursor = index + 1
        while cursor + 1 < len(words) and words[cursor] in _COLOR_JOINERS:
            following = _color_at(words, cursor + 1, brand_tokens)
            if following is None:
                break
            if following not in chain:
                chain.append(following)
            cursor += 2
        return "-".join(sorted(chain))
    return None


#: Yuzde ve para tutari kimlik degil pazarlamadir ("%50 indirim", "199 TL").
_MARKETING_NUMBER = re.compile(r"%\s*\d+|\d+\s*%|\b\d+(?:[.,]\d+)?\s*(?:tl|try)\b")


def extract_numbers(value: str) -> frozenset[str]:
    """Basliktaki sayi dizileri (model, kapasite, ekran, paket adedi).

    Hacim cikarilir (kendi vetosu var). "iPhone 15 256 GB" -> {15, 256},
    "AB-1234" ile "AB1234" ayni {1234}. Bu kume ProductKey'de iki taraf da
    kendine OZGU sayi tasiyorsa veto sebebidir (bkz. `veto_reason`).
    """
    text = strip_accents(value).lower()
    text = VOLUME.sub(" ", text)
    text = _MARKETING_NUMBER.sub(" ", text)
    return frozenset(re.findall(r"\d+", text))


def extract_volume(value: str) -> str | None:
    """'50 ml' -> '50ml'. Birim normalize edilir (lt/litre -> l, g -> gr)."""
    match = VOLUME.search(strip_accents(value).lower())
    if not match:
        return None
    amount = _canonical_amount(match.group(1))
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


#: Aciklama sayilan parantez: 3+ kelime. "(24EA)", "(Haki)", "(Limited
#: Edition)" kimligin parcasi olabilir; kalir.
_PARENTHETICAL = re.compile(r"\(([^()]*)\)")
#: Bosluklu tire: "Marka - Urun Adi - Turkce aciklama". Kelime ici tire
#: ("Oil-Free", "t-shirt") ayirici DEGILDIR.
_DASH_SPLIT = re.compile(r"\s+[-–—]\s+")


def commercial_title(title: str, brand: str | None = None) -> str:
    """Basligin ticari cekirdegi (docs/decisions/0034).

    Kozmetik magazalari basliga uzun Turkce aciklama ekliyor:
    "Dr. Althea - Retinol Flat Iron Eye Roller (Elastikiyet Koruyucu ...) 25ml"
    ile "Dr. Althea Retinol Eye Roller - Kirisiklik Karsiti Goz Bakimi 25ml"
    ayni urun ama aciklamalar yuzunden token ortusmesi 0.39'da kaliyordu.

    Deterministik kurallar:
    1. 3+ kelimelik parantez aciklamasi silinir.
    2. Bosluklu tireyle bolunur; yalnizca markadan olusan parca atilir;
       kalan ILK parca cekirdektir. Sonraki parcalar aciklama sayilir.

    Hacim/beden/renk/kademe TAM basliktan cikarilmaya devam eder; cekirdek
    yalnizca metin benzerligi icindir.
    """
    text = _PARENTHETICAL.sub(lambda m: " " if len(m.group(1).split()) >= 3 else m.group(0), title)
    brand_tokens = set(title_tokens(brand)) if brand else set()
    segments = [segment for segment in _DASH_SPLIT.split(text) if segment.strip()]
    if len(segments) > 1 and brand_tokens:
        first = set(title_tokens(segments[0]))
        if first and first <= brand_tokens:
            segments = segments[1:]
    core = segments[0] if segments else text
    # Cekirdek bos ya da tek kelime kaldiysa kural bilgi kaybettiriyor: tam baslik.
    return core if len(core.split()) >= 2 else text


#: "100ml", "60 ml", "0.47 L": renk seceneginde hacim yazan magazalar var
#: (Korendy'de secenek adi renk ama deger hacim). Hacim renk degildir.
_VOLUME_ONLY = re.compile(r"^\s*\d+(?:[.,]\d+)?\s*(ml|l|lt|litre|gr|g|kg|cl|oz)\s*$")


_VOLUME_TOKEN = re.compile(r"^\d+(?:\.\d+)?(ml|l|gr|kg|cl)$")


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
    #: Tam basligin tokenlari (aciklamalar dahil). `tokens` ticari cekirdektir
    #: ve metin benzerligine girer; renk dogrulamasi tam basliga bakar.
    all_tokens: frozenset[str] = frozenset()
    #: Basliktaki sayi dizileri (model/kapasite/ekran/paket). Bkz. `extract_numbers`.
    numbers: frozenset[str] = frozenset()

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
        # Sozlukte olmayan acik renk ("Defne Yesili", "Navy/Beige") atilmaz:
        # normalize edilmis haliyle tutulur ki renk vetosu calissin (0005:
        # urun renk duzeyinde kanonik).
        explicit = strip_accents(color or "").lower().strip()
        if _VOLUME_ONLY.match(explicit):
            explicit = ""
        resolved_color = (
            COLOR_SYNONYMS.get(explicit)
            or ("-".join(re.sub(r"[^a-z0-9]+", " ", explicit).split()) or None)
            or extract_color(title, brand)
        )
        all_tokens = title_tokens(title, brand)
        # Hacim ayri bir oznitelik (catisirsa veto); cekirdekte bir tarafta
        # kalip digerinde aciklamayla silinirse benzerligi bosuna dusururdu.
        core = frozenset(
            token
            for token in title_tokens(commercial_title(title, brand), brand)
            if not _VOLUME_TOKEN.match(token)
        )
        tokens = core or all_tokens
        return cls(
            tokens=tokens,
            all_tokens=all_tokens,
            brand_norm=" ".join(sorted(title_tokens(brand))) if brand else None,
            color=resolved_color,
            volume=extract_volume(title),
            size=extract_numeric_size(title),
            qualifier=extract_qualifier(all_tokens, title),
            # Dogrulanamayan kimlik "yok" sayilir: cop deger kesin eslesme uretmesin.
            gtin=clean_gtin(gtin),
            mpn=clean_mpn(mpn),
            numbers=extract_numbers(title),
        )
