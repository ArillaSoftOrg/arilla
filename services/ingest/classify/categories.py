"""Kaynak kategori yolu ve baslik -> merkezi kategori yolu (SAF; veritabani yok).

Ayni kural kumesi (`taxonomy.RULES`) iki metne uygulanir:

- Kaynak yolu ("Luggage & Bags > Women's Bags > Shoulder Bags"): EN DERIN eslesen bolum
  secilir; ust bolumler cok yollu kurali (cinsiyet) ayirmak ve celiskiyi olcmek icin
  kullanilir. Yaprak bolum eslesmezse ("Others") bir ust bolumun sonucu daha dusuk guvenle
  kullanilir.
- Baslik: tum eslesen kurallar; atasi olan aday elenir (daha ozel kazanir). Birden fazla
  aday kalirsa ortak ata (LCA): ayni ana kategoride derin bir ata kabul edilir, yalnizca
  ana kategoride bulusan ya da farkli ana kategorilere dagilan adaylar inceleme bekler.

Kaynak yolunda parca/aksesuar bolumu ("Laptop Parts & Accessories") cihaz kategorisine
(`taxonomy.DEVICE_PATHS`) eslenmez (karar 0138): yalniz aksesuar diyorsa cihazin aksesuar dali,
aksi halde aday dusurulur ve ust bolumun sonucu ZAYIF kalir (baslik dogrulamasi gerekir).

`title_evidence` basligi kaynaktan BAGIMSIZ okur: tum adaylar + alan isaretleri (`cue`).
Karar katmani bununla kaynak/baslik celiskisini olcer.

Guven 0-100; `taxonomy.APPLY_MIN_CONFIDENCE` altindaki sonuc urune yazilmaz.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field

from classify.taxonomy import (
    ACCESSORY_OF,
    ACCESSORY_WORDS,
    COMPAT_WORDS,
    DEVICE_PATHS,
    PART_WORDS,
    RULES,
    Rule,
)
from classify.text import PhraseIndex, segments, words

#: Baslik kanitinin kurala gore indirimi (anahtar kelime yigini, pazarlama metni).
TITLE_PENALTY = 5
#: Kaynak yolunda yaprak eslesmeyip bir ust bolume dusuldugunde, seviye basina.
SOURCE_LEVEL_PENALTY = 5
#: Celisen kaynak ust bolumu (or. Home & Garden > Pet Products) icin.
ANCESTOR_MISMATCH_PENALTY = 5
#: Parca/aksesuar bolumunun cihaz adayi dusuruldugunde ust bolum sonucuna (esigin altina iner).
PART_PENALTY = 10


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


def _covered(
    start: int,
    end: int,
    length: int,
    index: int,
    spans: list[tuple[int, int, int, int]],
    rules: Sequence[Rule],
) -> bool:
    """Daha uzun, bu ifadeyi ICINE alan baska (aday) kuralin ifadesi varsa bu kural eler.

    "stroller organizer" (bebek arabasi aksesuari) icindeki "organizer" (duzenleme) ya da
    "gaming headset" icindeki "headset" bagimsiz kanit degildir: ozel ifade genelin yerine
    gecer (karar 0139). Baglam ve alan-isareti kurallari bu elemeye katilmaz.
    """
    for s, e, j, n in spans:
        if j == index or n <= length:
            continue
        other = rules[j]
        if other.context or other.cue:
            continue
        if s <= start and end <= e:
            return True
    return False


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
    ) -> tuple[list[tuple[Rule, int]], set[str], set[str]]:
        """(kural, en uzun ifade uzunlugu) listesi, baglam yollari ve alan isaretleri."""
        excluded = {i for _, _, i in self._excludes.find(text)}
        best: dict[int, tuple[int, int]] = {}  # kural -> (uzunluk, baslangic) en uzun eslesme
        for start, length, i in self._phrases.find(text):
            if i in excluded:
                continue
            rule = self.rules[i]
            if (rule.source_only and not source) or (rule.cue and source):
                continue
            if i not in best or length > best[i][0]:
                best[i] = (length, start)
        context: set[str] = set()
        cues: set[str] = set()
        matched: list[tuple[Rule, int]] = []
        spans = [(start, start + length, i, length) for i, (length, start) in best.items()]
        for i, (length, start) in best.items():
            rule = self.rules[i]
            if rule.context:
                context.update(rule.paths)
            elif rule.cue:
                cues.update(rule.paths)
            elif _covered(start, start + length, length, i, spans, self.rules):
                continue
            else:
                matched.append((rule, length))
        return matched, context, cues


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


def _title_guess(
    matched: list[tuple[Rule, int]], context: set[str], within: str | None
) -> CategoryGuess:
    cands = _candidates(matched, context, {within} if within else set())
    if within is not None:
        inside = {p: c for p, c in cands.items() if is_within(p, within)}
        if inside:
            cands = inside
    guess = _reduce(cands)
    if guess.path is None:
        return guess
    return CategoryGuess(guess.path, max(guess.confidence - TITLE_PENALTY, 0), guess.kind)


def guess_title(title: str, *, within: str | None = None) -> CategoryGuess:
    """Basliktan tahmin. `within`: kaynak kategorisi biliniyorsa onun altindaki adaylar."""
    matched, context, _ = _MATCHER.match(words(title), source=False)
    return _title_guess(matched, context, within)


@dataclass(frozen=True)
class TitleEvidence:
    """Basligin kaynaktan bagimsiz okunusu (karar 0138)."""

    #: `guess_title(title)` ile ayni sonuc.
    guess: CategoryGuess
    #: Tum aday yollar -> baslik guveni (TITLE_PENALTY dusulmus); indirgemeden once.
    paths: dict[str, int]
    #: Alan isaretleri (`cue` kurallari): atamaya yetmez, celiski olcer.
    cues: frozenset[str]
    #: Parca/aksesuar/uyumluluk basligi ("Replacement ... for", "Suitable for ...").
    part: bool
    _matched: list[tuple[Rule, int]] = field(repr=False, compare=False)
    _context: set[str] = field(repr=False, compare=False)

    def within(self, path: str) -> CategoryGuess:
        """`guess_title(title, within=path)`; eslesme yeniden yapilmaz."""
        return _title_guess(self._matched, self._context, path)


def title_evidence(title: str) -> TitleEvidence:
    text = words(title)
    matched, context, cues = _MATCHER.match(text, source=False)
    cands = _candidates(matched, context, set())
    guess = _reduce(cands)
    if guess.path is not None:
        guess = CategoryGuess(guess.path, max(guess.confidence - TITLE_PENALTY, 0), guess.kind)
    paths = {p: max(c - TITLE_PENALTY, 0) for p, c in cands.items()}
    part = any(w in PART_WORDS or w in ACCESSORY_WORDS or w in COMPAT_WORDS for w in text)
    return TitleEvidence(guess, paths, frozenset(cues), part, matched, context)


def _device_part(cands: dict[str, int], part: bool) -> tuple[dict[str, int], bool]:
    """Parca/aksesuar bolumunde cihaz adaylari: aksesuar dalina tasinir ya da dusurulur."""
    out: dict[str, int] = {}
    dropped = False
    for path, conf in cands.items():
        if path not in DEVICE_PATHS:
            out[path] = max(out.get(path, 0), conf)
        elif not part and path in ACCESSORY_OF:
            target = ACCESSORY_OF[path]
            out[target] = max(out.get(target, 0), conf)
        else:
            dropped = True
    return out, dropped


def guess_source(source_path: str) -> CategoryGuess:
    """Kaynak kategori yolundan tahmin (yol basina bir kez; sonuc onbelleklenir)."""
    parts = segments(source_path)
    if not parts:
        return NONE
    texts = [words(part) for part in parts]
    layers = [_MATCHER.match(text, source=True) for text in texts]
    context: set[str] = set()
    for _, ctx, _ in layers:
        context |= ctx
    # Her bolumun kendi adaylari (ust bolum adaylari alt bolumu daraltir).
    ancestors: set[str] = set()
    per_layer: list[dict[str, int]] = []
    for matched, _, _ in layers:
        cands = _candidates(matched, context, ancestors)
        per_layer.append(cands)
        ancestors |= set(cands)
    # Parca/aksesuar isareti: bolumun kendisinde ya da altindaki bir bolumde.
    qualifier: list[tuple[bool, bool]] = []
    below_part = below_accessory = False
    for text in reversed(texts):
        below_part = below_part or any(w in PART_WORDS for w in text)
        below_accessory = below_accessory or any(w in ACCESSORY_WORDS for w in text)
        qualifier.append((below_part, below_accessory))
    qualifier.reverse()
    penalty = 0
    for level in range(len(parts) - 1, -1, -1):
        cands = per_layer[level]
        part, accessory = qualifier[level]
        if cands and (part or accessory):
            cands, dropped = _device_part(cands, part)
            if dropped:
                # Bolumun asil anlami (cihaz parcasi) kayboldu: kalan genel eslesme zayiftir.
                penalty = PART_PENALTY
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
        conf = guess.confidence - SOURCE_LEVEL_PENALTY * (len(parts) - 1 - level) - penalty
        if mismatch:
            conf -= ANCESTOR_MISMATCH_PENALTY
        return CategoryGuess(guess.path, max(conf, 0), guess.kind)
    return NONE
