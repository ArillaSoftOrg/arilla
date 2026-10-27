"""Dinamik kategori adayi secimi (karar 0154; SAF, veritabani/model/ag YOK, ayni girdi ayni sonuc).

Trendyol'dan gelen ~3.800 kategori icin tek tek Python kurali YAZILMAZ. Aday, uc kanittan secilir:

1. **Kaynak yolu -> bolge** (`data/source_bridge.tsv`, ~275 satir, elle gozden gecirilir):
   AliExpress yolu YALNIZ hangi Trendyol dalinin altina bakilacagini soyler. Kaynak yolu tek
   basina asla bir yaprak kategori vermez ("kaynak kategorisine asiri guven" yok). Bolgesi
   olmayan kaynak icin aday uretilmez.
2. **Kategori adi + hiyerarsi** (`category.name`, ata adlari): Turkce ad govdelerine (ilk 5 harf)
   ayrilir; ata adlarinda zaten gecen govdeler "genel baglam"dir, dugumun KENDI govdeleri
   (`own`) ayirt edicidir. Ayni adli kategoriler ebeveyn yoluyla ayrilir (anahtar `path`).
3. **Urun basligi**: Ingilizce baslik, `data/glossary_tr_en.tsv` (govde -> Ingilizce karsiliklar,
   surum denetimli veri) ile govde duzeyinde eslenir; Turkce baslik ve yabanci sozcukler
   (usb, led, laptop) govdeyle dogrudan eslenir.

Puan = 0.60 kapsama (ayirt edici govdelerin IDF agirlikli yuzdesi) + 0.25 bas sozcuk (adin son
ayirt edici govdesi baslikta) + 0.15 ata destegi (ata govdeleri baslikta ya da kaynak yolunda).
Yazilabilir karar icin: bas sozcuk ZORUNLU, puan >= `APPLY_SCORE`, ikinci (alakasiz) adaya fark >=
`MARGIN`. Cinsiyet/yas celiskisi, ve basligin "... for <cihaz>" biciminde urunu degil UYUMLU CIHAZI
anmasi (parca/aksesuar) adayi eler. Belirsiz ya da zayif aday YAZILMAZ (`ambiguous`/`weak`).

Bu modul tek basina kimseyi sinifa atamaz: `classify.run` yalniz etkin kapsamlarda
(`classifier_scope.mode = 'apply'`) ve `--dynamic` ile cagirir; varsayilan davranis V5'tir.
"""

from __future__ import annotations

import math
from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field, replace
from functools import lru_cache
from pathlib import Path

from classify.categories import common_ancestor, depth, is_within, source_gender
from classify.decide import Decision
from classify.taxonomy import ERKEK, KADIN
from classify.text import fold, path_norm, words

DATA = Path(__file__).parent / "data"

#: Dinamik motorun surumu: `Decision` degil, motorun KENDI davranisi (rapor/denetim icin).
DYNAMIC_VERSION = 1
#: Dinamik motor etkinse kural surumu V5 + bu kadar olur (kontrol noktasi ve denetim ayri).
ACTIVE_VERSION_BUMP = 1
#: Aday yazilabilir (apply) alt puan siniri ve ikinci alakasiz adaya en az fark.
APPLY_SCORE = 0.78
MARGIN = 0.15
#: Basligin ilk bu kadar sozcugu "ana urun bolgesi" sayilir (tek govdeli kanit icin).
HEAD_ZONE = 8
#: Tek govdeli kanit yalniz genis tur adlarinda (L1-L3) kabul edilir; derin dugum >= 2 govde ister.
SINGLE_MAX_DEPTH = 3
#: Glossary'de karsiligi olmadan dogrudan sozcukle eslenebilen yabanci/ortak sozcuk govdeleri.
#: Rastgele onek cakismasi ("trans" -> transceiver) onlemek icin YALNIZ bu liste.
DIRECT_STEMS = frozenset(
    {
        "usb",
        "led",
        "hdmi",
        "wifi",
        "bluet",
        "laptop",
        "lapto",
        "table",
        "robot",
        "drone",
        "mouse",
        "xbox",
        "plays",
        "ninte",
        "gps",
        "vr",
        "lpg",
        "rgb",
        "tv",
        "lcd",
        "bmx",
        "mdf",
        "pvc",
        "abs",
        "scoot",
        "yoga",
        "pilat",
        "crossfit",
        "cross",
        "bowli",
        "golf",
        "squas",
        "badmi",
        "tenis",
        "hokey",
        "kayak",
        "snowb",
        "puzzl",
        "modem",
        "power",
        "lazer",
        "lens",
        "film",
        "body",
        "mini",
        "shirt",
        "sweat",
        "polar",
        "bikin",
        "mayo",
        "foto",
        "album",
        "model",
        "serum",
        "jel",
        "sprey",
    }
)
#: Bu puanin altindaki aday raporlanmaz bile.
SUGGEST_SCORE = 0.55

#: Ad govdelerinde yok sayilan baglac/genel sozcukler (Turkce, katlanmis).
STOP = frozenset(
    {"ve", "ile", "icin", "diger", "urunleri", "urun", "cesitleri", "setleri", "takimlari", "grubu"}
)
#: Basliktaki bu sozcuklerden sonra gelen cihaz adi urunun degil UYUMLU CIHAZIN adidir.
PART_STEMS = frozenset(
    {"parca", "yedek", "akses", "aksam", "kilif", "kablo", "adapt", "filtr", "lasti"}
)
PART_HINTS = frozenset(
    {
        "part",
        "spare",
        "replacement",
        "accessory",
        "adapter",
        "compatible",
        "suitable",
        "assembly",
        "kit",
        "case",
        "cover",
    }
)
COMPAT_MARKERS = frozenset(
    {"for", "suitable", "compatible", "fit", "fits", "replacement", "applicable"}
)

#: Bas sozcuge bitisik gelip urunun ASIL turunu belirleyen parca/aksesuar adlari: "helmet visor"
#: kask degil vizordur, "phone case" telefon degil kiliftir. Parca/aksesuar OLMAYAN dugum bu
#: durumda secilmez.
HEAD_MODIFIERS = frozenset(
    {
        "visor",
        "lens",
        "strap",
        "holder",
        "mount",
        "bracket",
        "adapter",
        "charger",
        "cable",
        "pad",
        "sticker",
        "decal",
        "bag",
        "pouch",
        "sleeve",
        "stand",
        "rack",
        "hook",
        "screw",
        "filter",
        "nozzle",
        "blade",
        "brush",
        "handle",
        "knob",
        "switch",
        "button",
        "battery",
        "remote",
        "key",
        "cover",
        "case",
        "protector",
        "shell",
        "housing",
        "cap",
        "rubber",
    }
)

#: Cinsiyet/yas govdeleri (Turkce ad) ve Ingilizce baslik sozcukleri.
#: Yalniz kadin/erkek govdeleri kapsamaya girmez (cinsiyet kapisiyla olculur); bebek/cocuk
#: urun turudur ("Bebek Bakim", "Cocuk Bisikleti") ve normal sayilir.
SEX_STEMS = frozenset({"kadin", "bayan", "erkek"})
GENDER_STEMS = {"kadin": "K", "bayan": "K", "erkek": "E", "cocuk": "C", "bebek": "C", "genc": "C"}
GENDER_WORDS = {
    "woman": "K",
    "women": "K",
    "lady": "K",
    "ladies": "K",
    "female": "K",
    "girl": "K",
    "man": "E",
    "men": "E",
    "male": "E",
    "boy": "E",
    "gentleman": "E",
    "kid": "C",
    "child": "C",
    "children": "C",
    "baby": "C",
    "toddler": "C",
    "infant": "C",
}


def stem(token: str) -> str:
    return token[:5]


def name_stems(name: str) -> tuple[str, ...]:
    """'Kadın Spor Ayakkabı' -> ('kadin', 'spor', 'ayakk'); baglac ve rakamlar atilir."""
    out: list[str] = []
    for token in fold(name).split():
        if token in STOP or token.isdigit() or (len(token) < 3 and token != "tv"):
            continue
        out.append(stem(token))
    return tuple(out)


@lru_cache(maxsize=1)
def glossary() -> tuple[dict[str, tuple[tuple[str, ...], ...]], frozenset[str]]:
    """(govde -> Ingilizce ifadeler [kelime dizileri], genel govdeler)."""
    entries: dict[str, tuple[tuple[str, ...], ...]] = {}
    generic: set[str] = set()
    for line in (DATA / "glossary_tr_en.tsv").read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        key, _, rest = line.partition("\t")
        if rest.strip() == "~":
            generic.add(key)
            continue
        phrases = tuple(
            tuple(words(p)) for p in (x.strip() for x in rest.split(",")) if p and words(p)
        )
        entries[key] = phrases
    return entries, frozenset(generic)


@lru_cache(maxsize=1)
def bridge() -> dict[str, tuple[str, ...]]:
    """path_norm(kaynak yolu) -> bolge yollari (`category.path`); bolgesiz = bos demet."""
    out: dict[str, tuple[str, ...]] = {}
    for line in (DATA / "source_bridge.tsv").read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        source, _, regions = line.partition("\t")
        regions = regions.strip()
        out[path_norm(source)] = () if regions in ("", "-") else tuple(regions.split(","))
    return out


def regions_for(source_path: str | None) -> tuple[str, ...]:
    return bridge().get(path_norm(source_path), ()) if source_path else ()


@dataclass(frozen=True)
class Node:
    path: str
    name: str
    depth: int
    stems: tuple[str, ...]
    #: Ata adlarinda bulunmayan, dugumu AYIRT EDEN govdeler (yoksa tum govdeler).
    own: tuple[str, ...]
    #: Ata govdeleri (kok haric).
    context: tuple[str, ...]
    gender: frozenset[str]
    #: Dugum (ya da atasi) zaten bir parca/aksesuar/sarf dalidir.
    part: bool


@dataclass(frozen=True)
class DynamicGuess:
    path: str | None
    #: 0-100 (V5 ile ayni olcek).
    confidence: int
    #: 'match' (yazilabilir) | 'weak' | 'ambiguous' | 'none'
    kind: str
    score: float = 0.0
    runner_up: str | None = None
    #: Kisa, sirsiz kanit ozeti ("hit:ayakk,spor"; yol, baslik yok).
    evidence: tuple[str, ...] = field(default_factory=tuple)
    reason: str | None = None
    #: Bagimsiz eslesen govde sayisi (kendi + ata baglami).
    evidence_n: int = 0


NONE = DynamicGuess(None, 0, "none")


class DynamicIndex:
    """Kapsamdaki kategorilerin dizini. `categories`: (path, name), TUM agac (ata adlari icin)."""

    def __init__(self, categories: Iterable[tuple[str, str]], scopes: Sequence[str]) -> None:
        names = {p: n for p, n in categories}
        self.scopes = tuple(sorted(set(scopes)))
        entries, generic = glossary()
        self._generic = generic
        self._entries = entries
        self.nodes: dict[str, Node] = {}
        for path, name in names.items():
            if not any(is_within(path, s) for s in self.scopes):
                continue
            self.nodes[path] = self._node(path, name, names)
        df: dict[str, int] = defaultdict(int)
        for node in self.nodes.values():
            for s in set(node.own):
                df[s] += 1
        total = max(len(self.nodes), 1)
        self._idf = {
            s: max(0.3, math.log((total + 1) / (n + 1)) / math.log(total + 1))
            for s, n in df.items()
        }
        # Ters dizinler: Ingilizce sozcuk -> govdeler; govde -> dugumler.
        self._en: dict[str, list[tuple[tuple[str, ...], str, bool]]] = defaultdict(list)
        self._direct: dict[str, list[str]] = defaultdict(list)
        self._by_stem: dict[str, list[str]] = defaultdict(list)
        for path, node in self.nodes.items():
            for s in set((*node.stems, *node.context)):
                self._by_stem[s].append(path)
        wanted = {s for node in self.nodes.values() for s in (*node.stems, *node.context)}
        for s in wanted:
            if s in entries:
                for rank, phrase in enumerate(entries[s]):
                    if phrase:
                        self._en[phrase[0]].append((phrase, s, rank == 0))
            elif s in DIRECT_STEMS:
                self._direct[s].append(s)

    def _node(self, path: str, name: str, names: dict[str, str]) -> Node:
        own_stems = name_stems(name)
        ancestors: list[str] = []
        parts = path.split("/")
        for i in range(1, len(parts)):
            ancestors.extend(name_stems(names.get("/".join(parts[:i]), "")))
        generic = self._generic
        # Cinsiyet/yas govdeleri kapsama girmez: cinsiyet kapisiyla (node.gender) ayrica olculur.
        stems = tuple(s for s in own_stems if s not in generic and s not in SEX_STEMS)
        own = tuple(s for s in stems if s not in set(ancestors)) or stems
        # Kok adi baglamdan cikarilir (her dugumde ortak): yalniz L2+ ata govdeleri baglamdir.
        context = tuple(
            s
            for i in range(2, len(parts))
            for s in name_stems(names.get("/".join(parts[:i]), ""))
            if s not in generic and s not in SEX_STEMS
        )
        gender = frozenset(GENDER_STEMS[s] for s in (*own_stems, *ancestors) if s in GENDER_STEMS)
        ancestor_names = " ".join(names.get("/".join(parts[:i]), "") for i in range(1, len(parts)))
        part = any(stem(t) in PART_STEMS for t in fold(f"{name} {ancestor_names}").split())
        return Node(path, name, len(parts), stems, own, context, gender, part)

    # -- kanit -------------------------------------------------------------------------------

    def _hits(self, word_list: Sequence[str]) -> tuple[dict[str, int], set[str]]:
        """Metinde gecen govdeler -> ilk konum; ve ASIL karsiligi (ilk ifade) gecenler."""
        hits: dict[str, int] = {}
        primary: set[str] = set()
        for pos, word in enumerate(word_list):
            for phrase, s, is_primary in self._en.get(word, ()):
                if tuple(word_list[pos : pos + len(phrase)]) != phrase:
                    continue
                hits.setdefault(s, pos)
                if is_primary:
                    primary.add(s)
            for s in self._direct.get(stem(word), ()):
                hits.setdefault(s, pos)
                primary.add(s)
        return hits, primary

    def guess(self, title: str, source_path: str | None) -> DynamicGuess:
        regions = regions_for(source_path)
        if not regions or not self.nodes:
            return DynamicGuess(None, 0, "none", reason="no_region")
        title_words = words(title)
        source_words = words(source_path or "")
        title_hits, title_primary = self._hits(title_words)
        if not title_hits:
            return DynamicGuess(None, 0, "none", reason="no_title_hit")
        source_hits, _ = self._hits(source_words)
        marker = next((i for i, w in enumerate(title_words) if w in COMPAT_MARKERS and i > 0), None)
        title_gender = {GENDER_WORDS[w] for w in title_words if w in GENDER_WORDS}
        source_side = {
            "K" if g == KADIN else "E"
            for g in source_gender(source_path or "")
            if g in (KADIN, ERKEK)
        }
        # Baslik ile kaynak AYNI alanda celisirse ("Men" baslik, "Women's" kaynak) aday uretilmez;
        # celiskiyi V5 inceleme olarak yakalar. Baslik susuyorsa kaynagin cinsiyeti gecerlidir.
        if title_gender and source_side and not title_gender & source_side:
            return DynamicGuess(None, 0, "none", reason="gender_conflict")
        evidence_gender = title_gender or source_side

        candidates: set[str] = set()
        for s in title_hits:
            candidates.update(self._by_stem.get(s, ()))
        scored: list[_Cand] = []
        for path in candidates:
            if not any(is_within(path, r) for r in regions):
                continue
            node = self.nodes[path]
            # Kok (L1) sonuc vermez: kaynak zaten kaba dali soyler; dinamik motor INCELTIR.
            if node.depth < 2 or "diger" in fold(node.name).split():
                continue  # "Diger ..." artik kovasi kanit sayilmaz
            if node.gender and evidence_gender and not node.gender & evidence_gender:
                continue
            own_w = [(s, self._idf.get(s, 0.3)) for s in node.own]
            total = sum(w for _, w in own_w)
            if total <= 0:
                continue
            # Dugum adinin TUM (genel olmayan) govdeleri baslikta ya da kaynak yolunda gecmeli.
            # Ata ile paylasilan govde ("Akilli Aydinlatma"daki "akilli") ya da cevirisi olmayan
            # govde de adin parcasidir; yalniz ayirt edici govdeye bakmak "grow light" ->
            # "Akilli Aydinlatma" gibi hata uretir.
            if any(s not in title_hits and s not in source_hits for s in node.stems):
                continue
            hit_own = [s for s, _ in own_w if s in title_hits]
            # Parca/aksesuar dali, basliktaki TEK genel sozcukle ("tool") secilmez: parca dilini
            # (replacement, accessory, adapter...) ya da >= 2 govdeyi ister.
            if node.part and len(hit_own) <= 1 and not PART_HINTS & set(title_words):
                continue
            coverage = sum(w for s, w in own_w if s in title_hits) / total
            head = node.own[-1]
            if head not in title_hits:
                continue
            nxt = title_words[title_hits[head] + 1 : title_hits[head] + 3]
            if not node.part and HEAD_MODIFIERS & set(nxt):
                continue  # "helmet visor": urunun asil adi parca/aksesuar sozcugu
            # Parca/uyumluluk: bas sozcuk isaretten SONRA geciyorsa urun degil uyumlu cihazdir.
            if marker is not None and title_hits[head] > marker and not node.part:
                continue
            ctx_hit = [s for s in node.context if s in title_hits or s in source_hits]
            support = len(ctx_hit) / len(node.context) if node.context else 1.0
            # Kanit zenginligi: tek, genel bir sozcuk kategoriyi kanitlamaz. Ya >= 2 bagimsiz govde
            # (kendi + ata baglami) ya da tek govde ASIL karsiligiyla basligin ilk sozcuklerinde.
            # Kaynak yolu YALNIZ destek puanina girer; bagimsiz KANIT sayilmaz (yalniz baslik).
            ctx_title = [s for s in node.context if s in title_hits]
            evidence_n = len(set(hit_own) | set(ctx_title))
            if evidence_n < 2 and not (
                len(node.own) == 1
                and node.depth <= SINGLE_MAX_DEPTH
                and head in title_primary
                and title_hits[head] < HEAD_ZONE
            ):
                continue
            score = 0.60 * coverage + 0.25 + 0.15 * support
            if node.gender and not evidence_gender:
                score -= 0.10
            hit_all = frozenset(s for s in (*node.stems, *node.context) if s in title_hits)
            scored.append(
                _Cand(score, node.depth, path, tuple(hit_own), hit_all, coverage, evidence_n)
            )
        if not scored:
            return DynamicGuess(None, 0, "none", reason="no_candidate")
        # En yuksek puan; esitlikte EN GENEL (sig) dugum. Derine yalniz tam kapsama + atasinin
        # karsilamadigi ek kanit varsa ve tek bir dal belirginse inilir ("Diger", "Set" kardesleri
        # kanitsiz secilmez).
        scored.sort(key=lambda c: (-c.score, c.depth, c.path))
        chosen = scored[0]
        while True:
            deeper = [
                c
                for c in scored
                if c.path != chosen.path
                and is_within(c.path, chosen.path)
                and c.coverage >= 0.999
                and len(c.hit_all) > len(chosen.hit_all)
                and c.score >= chosen.score - 0.05
            ]
            if not deeper:
                break
            best_deeper = max(deeper, key=lambda c: (len(c.hit_all), c.score))
            tied = [
                c
                for c in deeper
                if len(c.hit_all) == len(best_deeper.hit_all)
                and not (is_within(c.path, best_deeper.path) or is_within(best_deeper.path, c.path))
            ]
            if tied:  # iki kardes dal ayni kanitla: inme, ust dugumde kal
                break
            chosen = best_deeper
        rivals = [
            c
            for c in scored
            if not (is_within(c.path, chosen.path) or is_within(chosen.path, c.path))
        ]
        runner = rivals[0] if rivals else None
        confidence = round(60 + 35 * max(min(chosen.score, 1.0), 0.0))
        evidence = (f"hit:{','.join(chosen.hit_own)}", f"score:{chosen.score:.2f}")
        runner_path = runner.path if runner else None
        if chosen.score < SUGGEST_SCORE:
            return DynamicGuess(None, 0, "none", chosen.score, None, evidence, "low_score")
        base = (chosen.path, confidence)
        if chosen.score < APPLY_SCORE:
            return DynamicGuess(
                *base, "weak", chosen.score, runner_path, evidence, "below_apply", chosen.evidence_n
            )
        if runner is not None and chosen.score - runner.score < MARGIN:
            # Belirsizlik ust dugume geri cekilerek cozulur (kardes yapraklar ayni kanitla
            # yarisirken ortak ata yeterince destekliyorsa o yazilir); yoksa YAZILMAZ.
            common = common_ancestor([chosen.path, runner.path])
            anc = next((c for c in scored if c.path == common), None) if common else None
            if anc is not None and anc.depth >= 2 and anc.score >= APPLY_SCORE:
                return DynamicGuess(
                    anc.path,
                    round(60 + 35 * min(anc.score, 1.0)),
                    "match",
                    anc.score,
                    runner_path,
                    (f"hit:{','.join(anc.hit_own)}", f"score:{anc.score:.2f}"),
                    "backoff",
                    anc.evidence_n,
                )
            return DynamicGuess(
                *base, "ambiguous", chosen.score, runner_path, evidence, "margin", chosen.evidence_n
            )
        return DynamicGuess(
            *base, "match", chosen.score, runner_path, evidence, None, chosen.evidence_n
        )


@dataclass(frozen=True)
class _Cand:
    score: float
    depth: int
    path: str
    hit_own: tuple[str, ...]
    hit_all: frozenset[str]
    coverage: float
    evidence_n: int


#: V5 henuz karar vermemisken (inceleme) dinamik adayin gecmesi gereken siki esikler.
UNRESOLVED_MIN_SCORE = 0.95
UNRESOLVED_MIN_EVIDENCE = 2


def refine(decision: Decision, guess: DynamicGuess) -> Decision:
    """V5 kararini dinamik adayla INCELTIR; baska hicbir durumda V5'i degistirmez (karar 0154).

    - Urunde zaten deger varsa (`existing`): dokunulmaz.
    - V5 kaynak/baslik CELISKISI bulduysa (`conflict`): inceleme kalir (baslik kaynagi bozmaz).
    - V5 baslikla DOGRULANMIS bir dala yazdiysa (`source_title`, `title`): V5 kalir.
    - V5 yalniz kaynakla (`source`, baslik dogrulamasi yok) yazdiysa ve aday `match` ise: aday,
      `source_title` olarak (kaynak bolgeyi, baslik yaprak'i soyluyor).
    - V5 belirsizse (`low_confidence`, `none`): aday ancak siki esiklerle (puan >= 0.92 ve >= 2
      bagimsiz govde) yazilir.
    Marka, parca/uyumluluk gibi diger alanlara dokunulmaz.
    """
    if guess.kind != "match" or guess.path is None:
        return decision
    # INCELTME: aday V5 yolundan DAHA DERIN olmali. Cok daha genel (ya da ayni derinlikte, yani
    # kazanc getirmeyen) bir Trendyol dugumune tasimak urunu paralel agaca bolerdi.
    if decision.category_path is not None and depth(guess.path) <= depth(decision.category_path):
        return decision
    basis = decision.category_basis
    if basis in ("existing", "conflict", "source_title", "title"):
        return decision
    if basis == "source":
        pass
    elif basis in ("low_confidence", "none"):
        if guess.score < UNRESOLVED_MIN_SCORE or guess.evidence_n < UNRESOLVED_MIN_EVIDENCE:
            return decision
    else:
        return decision
    return replace(
        decision,
        category_path=guess.path,
        category_basis="source_title",
        confidence=min(guess.confidence, 95),
        detail=None,
    )
