"""Metin katlama ve terim eslestirme (saf fonksiyonlar: ag yok, veritabani yok).

Katlama, `0019_product_title_fold_trgm.sql` indeksindeki SQL ifadesiyle AYNIDIR:
`lower(translate(title, 'ıİIŞşÇçĞğÖöÜüÂâÎîÛû', 'iiissccggoouuaaiiuu'))`. Boylece aday
suzgeci (SQL, indeksli) ile puanlayici (Python) ayni metni gorur.
"""

from __future__ import annotations

import re
from functools import lru_cache

_FOLD_FROM = "ıİIŞşÇçĞğÖöÜüÂâÎîÛû"
_FOLD_TO = "iiissccggoouuaaiiuu"
_FOLD_TABLE = str.maketrans(_FOLD_FROM, _FOLD_TO)

#: Turkce cekim ekleri; "$" ile biten terimlerde kelime sonunda opsiyoneldir.
#: Turetme ekleri (-li/-lu: "Denizli", "kotlu") BILEREK yok: baska kelimeyi yutar.
_SUFFIXES = r"(?:lar|ler|i|u|a|e|un|in|si|su|dan|den)?"


def fold(text: str) -> str:
    """Kucuk harf + Turkce karakterleri ASCII'ye katla (SQL katlamasiyla ayni)."""
    return text.translate(_FOLD_TABLE).lower()


def sql_pattern(term: str) -> str:
    """Terimin SQL `LIKE` kalibi (katlanmis metin uzerinde, indeksli on suzgec)."""
    plain = fold(term).rstrip("$")
    return "%" + plain.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


@lru_cache(maxsize=4096)
def term_regex(term: str) -> re.Pattern[str]:
    """Terim -> regex.

    - Duz terim: kelime BASI sinirli, devami serbest ("kazak" -> "kazaklar").
    - "$" ile biten: kelimenin TAMAMI (+ olasi cekim eki); "bot$" "bottle"i yakalamaz.
    - Bosluklu terim: kelimeler arasi bosluk/tire/kosegen esnek.
    """
    plain = fold(term)
    whole = plain.endswith("$")
    plain = plain.rstrip("$").strip()
    body = r"[\s\-/]+".join(re.escape(part) for part in plain.split())
    tail = _SUFFIXES + r"(?![a-z0-9])" if whole else ""
    return re.compile(r"(?<![a-z0-9])" + body + tail)


def matches(term: str, folded_text: str) -> bool:
    return term_regex(term).search(folded_text) is not None


def count_matches(terms: tuple[str, ...] | list[str], folded_text: str) -> int:
    """Eslesen BENZERSIZ terim sayisi."""
    return sum(1 for term in terms if matches(term, folded_text))


#: Varyant/boyut/renk gurultusu: yakin-kopya tespitinde atilir.
_NOISE = re.compile(
    r"\b\d+([.,]\d+)?\s*(ml|gr|g|kg|cm|mm|lt|l|x|adet|li|lu|'li)?\b"
    r"|\bskt\b|\bindirim(i|li)?\b|\bset(i)?\b|\bspf\s*\d+\+*\b",
)
_COLORS = frozenset(
    {
        "siyah",
        "beyaz",
        "krem",
        "bej",
        "kahverengi",
        "kahve",
        "gri",
        "lacivert",
        "mavi",
        "yesil",
        "haki",
        "kirmizi",
        "bordo",
        "pembe",
        "mor",
        "sari",
        "turuncu",
        "camel",
        "antrasit",
        "gumus",
        "altin",
        "ekru",
        "taba",
    }  # fmt: skip
)
_TOKEN = re.compile(r"[a-z]{3,}")


def signature(title: str) -> frozenset[str]:
    """Yakin-kopya parmak izi: boyut/renk/sayi atilmis anlamli kelimeler."""
    cleaned = _NOISE.sub(" ", fold(title))
    return frozenset(t for t in _TOKEN.findall(cleaned) if t not in _COLORS)


#: Cinsiyet/yas belirteci: ayni temel urunun Erkek/Kadin/Unisex kopyalarini ayirir.
GENDER_TOKENS = frozenset({"erkek", "kadin", "unisex", "cocuk", "kiz"})
#: Aile parmak izi en az bu kadar anlamli kelime tasimali; kisa basliklar birlesmez.
MIN_FAMILY_TOKENS = 3


def family_signature(title: str) -> frozenset[str]:
    """`signature` eksi cinsiyet belirteclerinin etkisi. Yalniz TAM ESITLIK dostur:
    cinsiyet kelimesi disinda her sey ayni olan basliklar ayni urun ailesidir."""
    return signature(title) - GENDER_TOKENS


def same_family(a: frozenset[str], b: frozenset[str]) -> bool:
    return len(a) >= MIN_FAMILY_TOKENS and a == b


def jaccard(a: frozenset[str], b: frozenset[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)
