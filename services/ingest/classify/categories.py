"""Kaynak kategori yolu ve baslik -> merkezi kategori yolu (SAF; veritabani yok).

Ayni kural kumesi (`taxonomy.RULES`) iki metne uygulanir:

- Kaynak yolu ("Luggage & Bags > Women's Bags > Shoulder Bags"): EN DERIN eslesen bolum
  secilir; ust bolumler cok yollu kurali (cinsiyet) ayirmak ve celiskiyi olcmek icin
  kullanilir. Yaprak bolum eslesmezse ("Others") bir ust bolumun sonucu daha dusuk guvenle
  kullanilir.
- Baslik: tum eslesen kurallar; atasi olan aday elenir (daha ozel kazanir). Birden fazla
  aday kalirsa ortak ata (LCA): ayni ana kategoride derin bir ata kabul edilir, yalnizca
  ana kategoride bulusan ya da farkli ana kategorilere dagilan adaylar inceleme bekler.

Guven 0-100; `taxonomy.APPLY_MIN_CONFIDENCE` altindaki sonuc urune yazilmaz.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from classify.taxonomy import RULES, Rule
from classify.text import PhraseIndex, segments, words

#: Baslik kanitinin kurala gore indirimi (anahtar kelime yigini, pazarlama metni).
TITLE_PENALTY = 5
#: Kaynak yolunda yaprak eslesmeyip bir ust bolume dusuldugunde, seviye basina.
SOURCE_LEVEL_PENALTY = 5
#: Celisen kaynak ust bolumu (or. Home & Garden > Pet Products) icin.
ANCESTOR_MISMATCH_PENALTY = 5


@dataclass(frozen=True)
class CategoryGuess:
    path: str | None
    confidence: int
    #: 'match' | 'lca' | 'conflict' | 'none'
    kind: str


NONE = CategoryGuess(None, 0, "none")


def depth(path: str) -> int:
    return path.count("/") + 1


def is_within(path: str, ancestor: str) -> bool:
    return path == ancestor or path.startswith(ancestor + "/")


def common_ancestor(paths: Sequence[str]) -> str | None:
    parts = [p.split("/") for p in paths]
    common: list[str] = []
    for level in zip(*parts, strict=False):
        if all(x == level[0] for x in level):
            common.append(level[0])
        else:
            break
    return "/".join(common) or None


class _Matcher:
    def __init__(self, rules: Sequence[Rule]) -> None:
        self.rules = tuple(rules)
        self._phrases: PhraseIndex[int] = PhraseIndex(
            (phrase, i) for i, rule in enumerate(self.rules) for phrase in rule.phrases
        )
        self._excludes: PhraseIndex[int] = PhraseIndex(
            (phrase, i) for i, rule in enumerate(self.rules) for phrase in rule.exclude
        )

    def match(
        self, text: Sequence[str], *, source: bool
    ) -> tuple[list[tuple[Rule, int]], set[str]]:
        """(kural, en uzun ifade uzunlugu) listesi ve baglam yollari."""
        excluded = {i for _, _, i in self._excludes.find(text)}
        best: dict[int, int] = {}
        for _, length, i in self._phrases.find(text):
            if i in excluded:
                continue
            rule = self.rules[i]
            if rule.source_only and not source:
                continue
            best[i] = max(best.get(i, 0), length)
        context: set[str] = set()
        matched: list[tuple[Rule, int]] = []
        for i, length in best.items():
            rule = self.rules[i]
            if rule.context:
                context.update(rule.paths)
            else:
                matched.append((rule, length))
        return matched, context


_MATCHER = _Matcher(RULES)


def _candidates(
    matched: list[tuple[Rule, int]], context: set[str], ancestors: set[str]
) -> dict[str, int]:
    """yol -> guven. Cok yollu kural baglam ya da kaynak atasiyla daraltilir."""
    out: dict[str, int] = {}
    for rule, _ in matched:
        paths = rule.paths
        if len(paths) > 1:
            narrowed = tuple(p for p in paths if any(is_within(p, c) for c in context | ancestors))
            paths = narrowed or paths
        for path in paths:
            out[path] = max(out.get(path, 0), rule.confidence)
    return out


def _reduce(cands: dict[str, int]) -> CategoryGuess:
    if not cands:
        return NONE
    # Atasi aday olan genel aday elenir: "Phone Accessories" + "Phone Case" -> kilif.
    specific = {
        p: c for p, c in cands.items() if not any(q != p and is_within(q, p) for q in cands)
    }
    if len(specific) == 1:
        path, conf = next(iter(specific.items()))
        return CategoryGuess(path, conf, "match")
    lca = common_ancestor(list(specific))
    if lca is None:
        return CategoryGuess(None, 0, "conflict")
    conf = min(specific.values()) - (3 if depth(lca) >= 2 else 15)
    return CategoryGuess(lca, max(conf, 0), "lca")


def guess_title(title: str, *, within: str | None = None) -> CategoryGuess:
    """Basliktan tahmin. `within`: kaynak kategorisi biliniyorsa onun altindaki adaylar."""
    matched, context = _MATCHER.match(words(title), source=False)
    cands = _candidates(matched, context, {within} if within else set())
    if within is not None:
        inside = {p: c for p, c in cands.items() if is_within(p, within)}
        if inside:
            cands = inside
    guess = _reduce(cands)
    if guess.path is None:
        return guess
    return CategoryGuess(guess.path, max(guess.confidence - TITLE_PENALTY, 0), guess.kind)


def guess_source(source_path: str) -> CategoryGuess:
    """Kaynak kategori yolundan tahmin (yol basina bir kez; sonuc onbelleklenir)."""
    parts = segments(source_path)
    if not parts:
        return NONE
    layers = [_MATCHER.match(words(part), source=True) for part in parts]
    context: set[str] = set()
    for _, ctx in layers:
        context |= ctx
    # Her bolumun kendi adaylari (ust bolum adaylari alt bolumu daraltir).
    ancestors: set[str] = set()
    per_layer: list[dict[str, int]] = []
    for matched, _ in layers:
        cands = _candidates(matched, context, ancestors)
        per_layer.append(cands)
        ancestors |= set(cands)
    for level in range(len(parts) - 1, -1, -1):
        cands = per_layer[level]
        if not cands:
            continue
        above = set().union(*per_layer[:level]) if level else set()
        # Ust bolumle uyumlu adaylar tercih edilir (cinsiyet / ana kategori).
        compatible = {
            p: c for p, c in cands.items() if any(is_within(p, a) or is_within(a, p) for a in above)
        }
        mismatch = bool(above) and not compatible
        guess = _reduce(compatible or cands)
        if guess.path is None:
            return guess
        conf = guess.confidence - SOURCE_LEVEL_PENALTY * (len(parts) - 1 - level)
        if mismatch:
            conf -= ANCESTOR_MISMATCH_PENALTY
        return CategoryGuess(guess.path, max(conf, 0), guess.kind)
    return NONE
