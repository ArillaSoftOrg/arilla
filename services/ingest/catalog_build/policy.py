"""Kaynak ilanin urun olmaya UYGUN olup olmadigina karar veren SAF kurallar.

Veritabani, ag ve saat yok: ayni girdi her zaman ayni sonucu verir. Kural
yalnizca kaynakta GORULEN alanlari kullanir; olmayan marka, GTIN, renk, beden ya
da varyant uretilmez (karar 0012, 0112). Bir ilan baska bir urunle baslik
benzerligiyle birlestirilmez: her kaynak ilani kendi urunudur.

Neden "ilan = urun"? AliExpress beslemesinde `offer@id` mağazanin urun (item)
kimligidir; `offer.external_id` ve `offer.url` (`/item/<id>.html`) ayni kimligi
tasir. Besleme SKU/varyant, marka ve barkod vermez, bu yuzden bir ilanin
icindeki renk/beden secenekleri bilinmez ve urun duzeyinde ayrilamaz; baska
ilanlarla da birlestirilemez. Kimlik kaniti yoksa tek guvenli birim ilandir.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass
from urllib.parse import urlsplit

from resolve.normalize import strip_accents

MIN_TITLE_CHARS = 8
MAX_TITLE_CHARS = 300
MAX_IMAGE_URL_CHARS = 2048
SLUG_TITLE_CHARS = 80

#: Atlama nedenleri (kontrol noktasinda sayilir; sabit kume).
SKIP_REASONS = (
    "inactive",
    "source_policy_missing",
    "source_id_invalid",
    "source_id_url_mismatch",
    "title_too_short",
    "title_too_long",
    "title_not_text",
    "title_repetitive",
    "title_has_url",
    "title_placeholder",
    "no_image",
    "bad_image",
    "no_price",
    "slug_conflict",
    # Karar 0129 (kesif defteri): ayni kod defterde baska adres turuyle kayitli.
    "discovery_kind_conflict",
)

_PLACEHOLDER_TITLES = frozenset(
    {"null", "none", "undefined", "n/a", "na", "test", "product", "item", "unknown", "-", "--"}
)
_URL_IN_TITLE = re.compile(r"(?:https?://|www\.)", re.IGNORECASE)
_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


@dataclass(frozen=True)
class SourcePolicy:
    """Bir kaynagin (merchant) kimlik kurali. Yeni kaynak = yeni kayit, kod degismez."""

    merchant_slug: str
    #: `offer.external_id` bicimi.
    id_pattern: re.Pattern[str]
    #: Kanonik `offer.url`; ILK grup kaynak kimligidir ve `external_id` ile AYNI olmali.
    url_pattern: re.Pattern[str]
    #: Fiyatsiz kesif defteri kaynagi (`catalog_discovery.source`, karar 0129). Varsa
    #: defterden taslak urun uretilebilir ve teklif geldiginde ayni kimlige baglanir.
    discovery_source: str | None = None
    #: Adresten kimlik TURU (or. Hepsiburada `p`/`pm`). Kesif defteriyle bag yalnizca ayni
    #: kod VE ayni tur ise kurulur.
    url_kind: Callable[[str], str | None] | None = None


#: Hepsiburada urun adresi: `/<slug>-p-<KOD>` (varyant) ya da `/<slug>-pm-<KOD>` (model).
#: Iki tur AYRI kimliktir; aralarindaki iliski dogrulanmadi (karar 0129), birbirine
#: baglanmaz. Kod tek basina kimliktir; tur adresten okunur ve eslesmede ayrica denetlenir.
HEPSIBURADA_URL = re.compile(
    r"^https://www\.hepsiburada\.com/[^/?#\s]+-(?:p|pm)-([A-Za-z0-9]{3,60})$"
)
_HEPSIBURADA_KIND = re.compile(r"-(p|pm)-[A-Za-z0-9]{3,60}$")


def hepsiburada_code_kind(url: str) -> str | None:
    """`p` (varyant adresi) / `pm` (model adresi); urun adresi degilse None."""
    match = _HEPSIBURADA_KIND.search(url)
    return match.group(1) if match else None


POLICIES: dict[str, SourcePolicy] = {
    # Admitad:6115 profili (karar 0112): offer@id = 16 haneli urun kimligi,
    # kanonik adres `https://www.aliexpress.com/item/<id>.html`.
    "aliexpress": SourcePolicy(
        merchant_slug="aliexpress",
        id_pattern=re.compile(r"^[0-9]{10,20}$"),
        url_pattern=re.compile(
            r"^https://(?:www\.|[a-z]{2}\.)?aliexpress\.com/item/([0-9]{10,20})\.html$"
        ),
    ),
    # Yonetici toplamasi (karar 0117/0129): `offer.external_id` adres sonundaki koddur
    # (feeds/intake.py), kanonik adres sorgusuz/parcasiz `www.hepsiburada.com`.
    "hepsiburada": SourcePolicy(
        merchant_slug="hepsiburada",
        id_pattern=re.compile(r"^[A-Za-z0-9]{3,60}$"),
        url_pattern=HEPSIBURADA_URL,
        discovery_source="hepsiburada",
        url_kind=hepsiburada_code_kind,
    ),
}

#: Urunu YALNIZCA kaynak ilani hattindan (taslak -> kapi -> acik yayin) acilan magazalar.
#: Cozumleyici (`python -m resolve`) bu magazalarin tekliflerinden urun ACMAZ ve onlari
#: baslik/gorsel benzerligiyle baska urune baglamaz (karar 0129).
SOURCE_LISTING_MERCHANTS: frozenset[str] = frozenset(POLICIES)


@dataclass(frozen=True)
class SourceOffer:
    """Aktarim icin okunan alanlar (`offer` satirindan)."""

    offer_id: int
    external_id: str
    url: str
    title_raw: str
    image_url: str | None
    current_price: int | None
    currency: str
    is_active: bool


@dataclass(frozen=True)
class ProductDraft:
    #: Kesif defterinden gelen (fiyatsiz) taslakta None: teklif yoktur, uydurulmaz.
    offer_id: int | None
    external_id: str
    slug: str
    title: str
    image_url: str


@dataclass(frozen=True)
class Verdict:
    draft: ProductDraft | None
    skip: str | None


def clean_title(raw: str) -> str:
    """NFC, bosluk daraltma. Icerik DEGISTIRILMEZ (kisaltma, yeniden yazma yok)."""
    text = unicodedata.normalize("NFC", _CONTROL.sub(" ", raw))
    return " ".join(text.split())


def title_problem(title: str) -> str | None:
    """Temizlenmis baslik kullanilamazsa neden, yoksa None."""
    if title.lower() in _PLACEHOLDER_TITLES:
        return "title_placeholder"
    if len(title) < MIN_TITLE_CHARS:
        return "title_too_short"
    if len(title) > MAX_TITLE_CHARS:
        return "title_too_long"
    if _URL_IN_TITLE.search(title):
        return "title_has_url"
    visible = [char for char in title if not char.isspace()]
    letters = sum(1 for char in visible if char.isalpha())
    if letters * 2 < len(visible):
        return "title_not_text"
    words = [word.lower() for word in title.split()]
    if len(words) >= 6 and len(set(words)) * 10 < len(words) * 3:
        return "title_repetitive"
    return None


def image_problem(url: str | None) -> str | None:
    if url is None or not url.strip():
        return "no_image"
    value = url.strip()
    if len(value) > MAX_IMAGE_URL_CHARS or any(char.isspace() for char in value):
        return "bad_image"
    try:
        parts = urlsplit(value)
    except ValueError:
        return "bad_image"
    host = parts.hostname or ""
    if parts.scheme != "https" or "." not in host or host.replace(".", "").isdigit():
        return "bad_image"
    return None


def source_slug(title: str, external_id: str) -> str:
    """`<ascii-baslik>-<kaynak-kimligi>`: kimlik son ekte, bu yuzden benzersizlik varlik
    sorgusuz, KALICI ve ayni ilan icin her zaman ayni. Baslik degisse bile slug sabit kalir."""
    text = strip_accents(title).lower()
    cleaned = "".join(char if char.isascii() and char.isalnum() else "-" for char in text)
    head = "-".join(part for part in cleaned.split("-") if part)[:SLUG_TITLE_CHARS].strip("-")
    return f"{head or 'urun'}-{external_id}"


def evaluate(offer: SourceOffer, policy: SourcePolicy | None) -> Verdict:
    """Bir teklif icin taslak urun ya da atlama nedeni. Sira: ucuzdan pahaliya, kimlik once."""
    if policy is None:
        return Verdict(None, "source_policy_missing")
    if not offer.is_active:
        return Verdict(None, "inactive")
    if not policy.id_pattern.match(offer.external_id):
        return Verdict(None, "source_id_invalid")
    match = policy.url_pattern.match(offer.url)
    if match is None or match.group(1) != offer.external_id:
        # Kaynak urun kimligi ile teklif kimligi ayni kavram degilse urun acilmaz.
        return Verdict(None, "source_id_url_mismatch")
    title = clean_title(offer.title_raw)
    problem = title_problem(title)
    if problem:
        return Verdict(None, problem)
    image_issue = image_problem(offer.image_url)
    if image_issue:
        return Verdict(None, image_issue)
    if offer.current_price is None or offer.current_price <= 0:
        return Verdict(None, "no_price")
    assert offer.image_url is not None
    return Verdict(
        ProductDraft(
            offer_id=offer.offer_id,
            external_id=offer.external_id,
            slug=source_slug(title, offer.external_id),
            title=title,
            image_url=offer.image_url.strip(),
        ),
        None,
    )
