"""Siniflandirma metni: katlama, kelimeler, ifade eslemesi (SAF; veritabani yok).

Kaynak kategori adi ("Phone Bags & Cases"), Turkce kategori adi ("Telefon Kılıfı") ve urun
basligi ayni bicime indirgenir: Turkce harfler ASCII'ye, kucuk harf, harf/rakam disi bosluk.
Ingilizce cogul (`cases` -> `case`) iki tarafta da ayni kirpilir.

Ifade: bosluklu kelime dizisi; `*` ile biten kelime onektir (`kilif*` -> kilifi, kiliflari).
Eslesme ardisik kelimelerle yapilir. Binlerce ifade x milyonlarca baslik icin ifadeler ilk
kelimenin ilk 3 harfiyle kovalanir; her baslik kelimesi yalnizca kendi kovasina bakar.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import TypeVar

from resolve.normalize import strip_accents

T = TypeVar("T")

_NON_WORD = re.compile(r"[^a-z0-9]+")
_BUCKET = 3


def fold(text: str) -> str:
    """'Telefon Kılıfı & Kapak' -> 'telefon kilifi kapak'."""
    return _NON_WORD.sub(" ", strip_accents(text).lower()).strip()


def _singular(word: str) -> str:
    # "cases" -> "case", "bags" -> "bag"; "glass", "dress" korunur.
    if len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
        return word[:-1]
    return word


def words(text: str) -> list[str]:
    return [_singular(w) for w in fold(text).split()]


def path_norm(source_path: str) -> str:
    """Kaynak kategori yolunun anahtari: 'ust > alt' bicimi, katlanmis.

    AliExpress 'Ust > Alt', bazi kaynaklar 'Ust/Alt' ya da tek ad verir. Ayni yol her zaman
    ayni anahtari uretir (category_source_map.path_norm).
    """
    parts = [fold(p) for p in re.split(r"\s*(?:>|/|\|)\s*", source_path)]
    return " > ".join(p for p in parts if p)[:500]


def segments(source_path: str) -> list[str]:
    return [s for s in path_norm(source_path).split(" > ") if s]


def phrase_tokens(phrase: str) -> tuple[str, ...]:
    """Ifade kelimeleri metinle AYNI katlanir ("Women's" -> women, s); `*` son parcaya kalir."""
    tokens: list[str] = []
    for raw in phrase.split():
        star = raw.endswith("*")
        parts = fold(raw.rstrip("*")).split()
        if not parts:
            continue
        tokens.extend(_singular(w) for w in parts[:-1])
        tokens.append(parts[-1] + "*" if star else _singular(parts[-1]))
    return tuple(tokens)


@dataclass(frozen=True)
class _Phrase[T]:
    tokens: tuple[str, ...]
    value: T

    def matches_at(self, text: Sequence[str], start: int) -> bool:
        if start + len(self.tokens) > len(text):
            return False
        for offset, token in enumerate(self.tokens):
            word = text[start + offset]
            if token.endswith("*"):
                if not word.startswith(token[:-1]):
                    return False
            elif word != token:
                return False
        return True


class PhraseIndex[T]:
    """Ifade -> deger. `find` metindeki tum eslesmeleri (konum, uzunluk, deger) dondurur."""

    def __init__(self, entries: Iterable[tuple[str, T]]) -> None:
        self._buckets: dict[str, list[_Phrase[T]]] = {}
        for phrase, value in entries:
            tokens = phrase_tokens(phrase)
            if not tokens:
                continue
            first = tokens[0]
            if first.endswith("*") and len(first) - 1 < _BUCKET:
                raise ValueError(f"onek ifadesi en az {_BUCKET} harf olmali: {phrase!r}")
            self._buckets.setdefault(first.rstrip("*")[:_BUCKET], []).append(_Phrase(tokens, value))

    def find(self, text: Sequence[str]) -> list[tuple[int, int, T]]:
        hits: list[tuple[int, int, T]] = []
        for start, word in enumerate(text):
            for phrase in self._buckets.get(word[:_BUCKET], ()):
                if phrase.matches_at(text, start):
                    hits.append((start, len(phrase.tokens), phrase.value))
        return hits
