"""Urun kimligi duzey kurallari ve otomatik birlestirme politikasi (karar 0111).

Tanimlayicinin hangi DUZEYI tanimladigi turune baglidir:

- **GTIN** -> kanonik varyant. GS1 kurali: her ticari varyantin (renk, beden,
  kapasite) kendi barkodu vardir. 14 haneye tamamlanir. Kisitli dolasim
  onekleri (magaza ici, kupon, ISBN/ISSN, degisken olcu) kimlik DEGILDIR.
  GTIN-14 paket gostergesi (1-8) coklu paket/kolidir: ayri varyanttir.
- **Marka + MPN** -> urun (model). Marka cozulmeden MPN kimlik degildir.
- **Model ipucu** (`model_key`) -> yalnizca aday uretimi; otomatik birlestirmez.

Politika: DOGRULANMAMIS urun otomatik birlestirilmez. Otomatik bag yalnizca
aktif ve celiskisiz bir kesin kimlikle kurulur; marka, kategori kok yolu ve
varyant eksenleri uyusmuyorsa karar `hold` (inceleme) olur ve kimlik celiskili
isaretlenir. Kesin kimlik yoksa karar `unmatched`: kayit eslesmemis yasar,
mevcut puanli cozumleyici ve inceleme kuyrugu karar verir.

Bu modul saftir (veritabani yok); yazim tarafi kararlari `match_decision_log`a
ve `product_identity`ye uygular.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal

from resolve.identity import clean_gtin, clean_mpn

GtinStatus = Literal["valid", "restricted", "invalid"]


@dataclass(frozen=True)
class GtinInfo:
    #: 14 haneli bicim; gecersizse None.
    value: str | None
    status: GtinStatus
    #: GTIN-14 paket gostergesi 1-8: coklu paket/koli (tekli urunle birlesmez).
    package_level: bool = False


#: GTIN-13 bicimindeki (14 hanenin son 13'u) kisitli onekler. GS1 Genel Ozellikler:
#: 020-029 / 040-049 / 200-299 kisitli dolasim (magaza ici, tartili urun),
#: 050-059 kupon, 977 ISSN, 978-979 ISBN/ISMN (urun degil yayin kimligi),
#: 980 iade fisi, 981-984 / 990-999 kupon.
_RESTRICTED_13 = tuple(
    [f"0{d}" for d in "245"]
    + [str(n) for n in range(200, 300)]
    + ["977", "978", "979", "980", "981", "982", "983", "984"]
    + [str(n) for n in range(990, 1000)]
)


def classify_gtin(raw: str | None) -> GtinInfo:
    """Ham barkodu siniflandirir. Kontrol basamagi ve cop deger elemesi `clean_gtin`'dedir."""
    code = clean_gtin(raw)
    if code is None:
        return GtinInfo(None, "invalid")
    if len(code) == 8:
        # GTIN-8: 0 ve 2 ile baslayanlar kisitli dolasim numarasidir (RCN-8).
        if code[0] in "02":
            return GtinInfo(None, "restricted")
        return GtinInfo(code.zfill(14), "valid")
    value = code.zfill(14)
    indicator, gs1_13 = value[0], value[1:]
    if indicator == "9":
        # Degisken olculu ticari urun (tartili): sabit urun kimligi degil.
        return GtinInfo(None, "restricted")
    if gs1_13.startswith(_RESTRICTED_13):
        return GtinInfo(None, "restricted")
    return GtinInfo(value, "valid", package_level=indicator != "0")


def mpn_norm(raw: str | None) -> str | None:
    """Karsilastirma bicimi: buyuk harf, bosluk/tire/nokta/alt cizgi/bolu yok."""
    value = clean_mpn(raw)
    if value is None:
        return None
    norm = re.sub(r"[\s\-._/]", "", _ascii_fold(value)).upper()
    return norm or None


# --------------------------------------------------------------------------
# Varyant eksenleri
# --------------------------------------------------------------------------

#: Kaynaklarin eksen adlari -> bizim eksen adimiz. Listede olmayan eksen
#: normalize adiyla korunur (uydurma esleme yapilmaz).
AXIS_ALIASES: Mapping[str, str] = {
    "beden": "beden",
    "size": "beden",
    "numara": "beden",
    "olcu": "beden",
    "renk": "renk",
    "color": "renk",
    "colour": "renk",
    "kapasite": "kapasite",
    "capacity": "kapasite",
    "storage": "kapasite",
    "hafiza": "kapasite",
    "depolama": "kapasite",
    "hacim": "hacim",
    "volume": "hacim",
    "agirlik": "agirlik",
    "weight": "agirlik",
    "adet": "adet",
    "quantity": "adet",
    "paket": "adet",
}

_UNIT_SPACE = re.compile(r"(\d)\s+(gb|tb|mb|ml|l|lt|g|gr|kg|cm|mm|adet)\b")


def _ascii_fold(value: str) -> str:
    text = value.replace("İ", "i").replace("I", "ı").replace("ı", "i")
    text = unicodedata.normalize("NFKD", text)
    return "".join(ch for ch in text if not unicodedata.combining(ch))


def _axis_name(name: str) -> str | None:
    key = re.sub(r"[^a-z0-9]+", "_", _ascii_fold(name).lower()).strip("_")
    if not key:
        return None
    return AXIS_ALIASES.get(key, key)


def _axis_value(value: str) -> str | None:
    text = _ascii_fold(value).lower().strip()
    text = re.sub(r"\s+", " ", text)
    text = _UNIT_SPACE.sub(r"\1\2", text)
    # Anahtarin ayraclari degerde bulunamaz.
    text = text.replace(";", ",").replace("=", "-").strip()
    return text or None


def normalize_options(options: Mapping[str, str | None]) -> dict[str, str]:
    """Kaynak secenekleri -> normalize eksen sozlugu. Bos degerler atilir."""
    out: dict[str, str] = {}
    for name, value in options.items():
        axis = _axis_name(name)
        norm = _axis_value(value) if value is not None else None
        if axis and norm:
            out[axis] = norm
    return out


def option_key(options: Mapping[str, str | None]) -> str:
    """Sirali, normalize "eksen=deger;..." anahtari. Tek varyantli urunde ''."""
    norm = normalize_options(options)
    return ";".join(f"{axis}={norm[axis]}" for axis in sorted(norm))


# --------------------------------------------------------------------------
# Otomatik birlestirme karari
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class OfferIdentity:
    """Eslestirilecek kaynak kaydin kimlik ozeti."""

    gtin: GtinInfo | None
    mpn: str | None
    brand_id: int | None
    #: Kategori kok yolu ("moda", "elektronik"); bilinmiyorsa None.
    category_root: str | None
    options: Mapping[str, str]


@dataclass(frozen=True)
class KnownIdentity:
    """Veritabanindaki product_identity satiri + hedef urunun ozeti."""

    kind: Literal["gtin", "mpn", "model_hint"]
    status: Literal["active", "conflict", "restricted", "retired"]
    product_id: int
    canonical_variant_id: int | None
    brand_id: int | None
    category_root: str | None
    #: Hedef kanonik varyantin eksenleri (GTIN icin); urun duzeyinde bos.
    options: Mapping[str, str]


Decision = Literal["link", "hold", "unmatched"]


@dataclass(frozen=True)
class LinkDecision:
    decision: Decision
    #: 'gtin' | 'mpn' | ... ya da hold/unmatched nedeni.
    basis: str
    product_id: int | None = None
    canonical_variant_id: int | None = None
    #: True: kimlik celiskili isaretlenmeli (otomatik birlestirme durur).
    mark_conflict: bool = False


def _compatible(a: object | None, b: object | None) -> bool:
    return a is None or b is None or a == b


def _axes_conflict(left: Mapping[str, str], right: Mapping[str, str]) -> bool:
    """Ortak eksende farkli deger var mi (128gb vs 256gb)."""
    return any(left[axis] != right[axis] for axis in left.keys() & right.keys())


def decide_link(offer: OfferIdentity, known: list[KnownIdentity]) -> LinkDecision:
    """Kesin kimlige gore otomatik bag karari. Belirsizlikte ASLA `link` donmez."""
    if offer.gtin is not None and offer.gtin.status == "valid":
        matches = [k for k in known if k.kind == "gtin"]
        if any(k.status == "conflict" for k in matches):
            return LinkDecision("hold", "gtin_conflict_known")
        active = [k for k in matches if k.status == "active"]
        if len(active) > 1:
            return LinkDecision("hold", "gtin_ambiguous", mark_conflict=True)
        if active:
            target = active[0]
            if not _compatible(offer.brand_id, target.brand_id):
                return LinkDecision("hold", "gtin_brand_mismatch", mark_conflict=True)
            if not _compatible(offer.category_root, target.category_root):
                return LinkDecision("hold", "gtin_category_mismatch", mark_conflict=True)
            if _axes_conflict(normalize_options(offer.options), target.options):
                return LinkDecision("hold", "gtin_variant_mismatch", mark_conflict=True)
            return LinkDecision("link", "gtin", target.product_id, target.canonical_variant_id)

    if offer.mpn and offer.brand_id is not None:
        active = [
            k
            for k in known
            if k.kind == "mpn" and k.status == "active" and k.brand_id == offer.brand_id
        ]
        if any(k.kind == "mpn" and k.status == "conflict" for k in known):
            return LinkDecision("hold", "mpn_conflict_known")
        if len(active) > 1:
            return LinkDecision("hold", "mpn_ambiguous", mark_conflict=True)
        if active:
            target = active[0]
            if not _compatible(offer.category_root, target.category_root):
                return LinkDecision("hold", "mpn_category_mismatch", mark_conflict=True)
            # Urun duzeyi bag; varyant ayrica option_key ile cozulur.
            return LinkDecision("link", "mpn", target.product_id)

    # Model ipucu, baslik ya da gorsel benzerligi: yalnizca aday. Otomatik bag yok.
    return LinkDecision("unmatched", "no_verified_identity")
