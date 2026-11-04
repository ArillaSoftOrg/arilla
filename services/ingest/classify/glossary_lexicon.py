"""Glossary -> arama sozlugu kopru satirlari (karar 0172, Faz 3).

`data/glossary_tr_en.tsv` (karar 0154; Turkce govde -> Ingilizce karsiliklar) kategori adlarindaki
Turkce kelimelerle birlestirilir ve `lexicon(kind='synonym')` adaylari uretilir. Ayni `normalized`
degerini paylasan yuzeyler aramada birbirinin alternatifidir (karar 0029); boylece "pantolon"
araması Ingilizce "trousers/pants" basliklarini da bulur. Satirlar SURUM DENETIMLI veriden
uretilir; calisma aninda model/ceviri cagrisi yoktur.

Gelistirme kumesi olcumu (`packages/core/scripts/eval-glossary-filter.ts`) su kurallari secti:

1. Yalniz CEKIM EKI. Govdeyi paylasan kelimelerden en kisasi taban; tabanin yalniz cogul/iyelik/
   belirtme ekli bicimleri alinir. Yapim eki anlami degistirir: `kablo-suz` (wireless, karsit),
   `ayakkabi-lik` (ayakkabi dolabi), `supurge-lik`, `kulak-lik`.
2. Birden fazla govdede gecen Ingilizce karsilik belirsizdir; hicbirine yazilmaz.
3. Var olan bir gruba YALNIZ Turkce kelimesi zaten o gruptaysa katilinir (`kiliflari` -> `kilif`).
   Ingilizce kelime uzerinden zincirleme katilim yok (`kapak` -> cover -> `kilif` olmaz); baska
   gruptaki Ingilizce karsilik atilir. Turkce kelimeleri iki ayri gruba dusen govde atlanir.
4. `~` (genel sozcuk) govdeleri yazilmaz.

Yazim yalniz ekler (`ON CONFLICT DO NOTHING`); var olan satir degistirilmez. Eklenen satirlar
manifest dosyasina yazilir ve `--rollback MANIFEST` tam olarak onlari siler.
"""

from __future__ import annotations

import csv
import re
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path

import psycopg

GLOSSARY = Path(__file__).resolve().parent / "data" / "glossary_tr_en.tsv"
GROUP_PREFIX = "glossary:"
WEIGHT = 1.0

_FOLD = str.maketrans("ıİIŞşÇçĞğÖöÜüÂâÎîÛû", "iiissccggoouuaaiiuu")
_SPLIT = re.compile(r"[^\w]+")

#: Katlanmis cekim ekleri (cogul, iyelik, belirtme, cogul+iyelik). Yapim eki YOK.
INFLECTIONS = frozenset(
    {"", "lar", "ler", "i", "u", "si", "su", "lari", "leri", "yi", "yu", "ni", "nu"}
)


def fold(text: str) -> str:
    """Arama tarafindaki `foldForMatch` ile ayni kelime kimligi (Turkce katlama + kucuk harf)."""
    return text.translate(_FOLD).lower()


def _tokens(text: str) -> list[str]:
    return [t for t in _SPLIT.split(fold(text)) if len(t) >= 2 and not any(c.isdigit() for c in t)]


def key(text: str) -> str:
    return " ".join(_tokens(text))


def stem(word: str) -> str:
    """Glossary govdesi: katlanmis kelimenin ilk 5 harfi (`classify.dynamic.stem`)."""
    return word[:5]


@dataclass(frozen=True)
class GlossaryEntry:
    stem: str
    phrases: tuple[str, ...]

    @property
    def generic(self) -> bool:
        return self.phrases == ("~",)


def read_glossary(path: Path = GLOSSARY) -> list[GlossaryEntry]:
    out: list[GlossaryEntry] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        head, _, rest = line.partition("\t")
        out.append(GlossaryEntry(head, tuple(p.strip() for p in rest.split(",") if p.strip())))
    return out


@dataclass(frozen=True)
class SynonymRow:
    surface: str
    normalized: str


@dataclass
class Plan:
    rows: list[SynonymRow] = field(default_factory=list)
    stats: Counter[str] = field(default_factory=Counter)


def inflected_family(words: Sequence[str]) -> list[str]:
    """En kisa kelime taban; taban ve yalniz cekim ekli bicimleri (katlanmis)."""
    base = min(words, key=len)
    return [w for w in words if w.startswith(base) and w[len(base) :] in INFLECTIONS]


def plan(
    glossary: Sequence[GlossaryEntry],
    category_names: Iterable[str],
    existing: Mapping[str, str],
) -> Plan:
    """Saf hesap. `existing`: var olan es anlam yuzeyi (katlanmis, `key`) -> `normalized`."""
    display: dict[str, Counter[str]] = defaultdict(Counter)
    for name in category_names:
        for raw in _SPLIT.split(name.strip().lower()):
            if len(raw) < 2 or any(c.isdigit() for c in raw):
                continue
            display[fold(raw)][raw] += 1
    by_stem: dict[str, list[str]] = defaultdict(list)
    for folded in sorted(display):
        by_stem[stem(folded)].append(folded)

    owners: dict[str, set[str]] = defaultdict(set)
    for entry in glossary:
        if not entry.generic:
            for phrase in entry.phrases:
                if key(phrase):
                    owners[key(phrase)].add(entry.stem)

    result = Plan()
    taken: set[str] = set()
    for entry in glossary:
        if entry.generic:
            result.stats["generic_skipped"] += 1
            continue
        words = by_stem.get(entry.stem, [])
        if not words:
            result.stats["no_turkish_word"] += 1
            continue
        family = inflected_family(words)
        result.stats["derived_dropped"] += len(words) - len(family)
        turkish = [display[w].most_common(1)[0][0] for w in family]
        english = [p for p in entry.phrases if key(p)]
        shared = [p for p in english if len(owners[key(p)]) > 1]
        result.stats["shared_english_dropped"] += len(shared)
        english = [p for p in english if p not in shared]

        anchors = {existing[key(t)] for t in turkish if key(t) in existing}
        if len(anchors) > 1:
            result.stats["multi_group_skipped"] += 1
            continue
        group = next(iter(anchors)) if anchors else f"{GROUP_PREFIX}{entry.stem}"
        foreign = [p for p in english if key(p) in existing and existing[key(p)] != group]
        result.stats["english_in_other_group_dropped"] += len(foreign)
        english = [p for p in english if p not in foreign]
        has_english = bool(english) or any(existing.get(key(p)) == group for p in entry.phrases)
        if not has_english:
            result.stats["no_english_left"] += 1
            continue

        new: list[str] = []
        local: set[str] = set()
        for surface in turkish + english:
            k = key(surface)
            if k in existing or k in taken or k in local:
                continue
            local.add(k)
            new.append(surface)
        if not new:
            result.stats["nothing_new"] += 1
            continue
        if anchors:
            result.stats["joined_existing_group"] += 1
        result.stats["stems_used"] += 1
        taken.update(local)
        result.rows.extend(SynonymRow(surface, group) for surface in new)
    result.stats["rows"] = len(result.rows)
    return result


@dataclass
class Report:
    stats: Counter[str]
    rows: list[SynonymRow]
    inserted: list[SynonymRow] = field(default_factory=list)


def _load(conn: psycopg.Connection) -> tuple[list[str], dict[str, str]]:
    with conn.cursor() as cur:
        cur.execute("SELECT name FROM category")
        names = [str(r[0]) for r in cur.fetchall()]
        cur.execute("SELECT surface, normalized FROM lexicon WHERE kind = 'synonym'")
        existing = {key(str(s)): str(n) for s, n in cur.fetchall() if key(str(s))}
    return names, existing


def apply(conn: psycopg.Connection, *, write: bool, glossary_path: Path = GLOSSARY) -> Report:
    names, existing = _load(conn)
    result = plan(read_glossary(glossary_path), names, existing)
    report = Report(stats=result.stats, rows=result.rows)
    if not write or not result.rows:
        conn.rollback()
        return report
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO lexicon (kind, surface, normalized, weight)
               SELECT 'synonym', s, n, %s
                 FROM unnest(%s::text[], %s::text[]) AS t(s, n)
               ON CONFLICT (kind, surface) DO NOTHING
               RETURNING surface, normalized""",
            (WEIGHT, [r.surface for r in result.rows], [r.normalized for r in result.rows]),
        )
        report.inserted = [SynonymRow(str(s), str(n)) for s, n in cur.fetchall()]
    conn.commit()
    return report


def write_manifest(path: Path, rows: Sequence[SynonymRow]) -> None:
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        writer = csv.writer(handle, delimiter="\t", lineterminator="\n")
        writer.writerow(["surface", "normalized"])
        writer.writerows((r.surface, r.normalized) for r in rows)


def read_manifest(path: Path) -> list[SynonymRow]:
    with path.open(encoding="utf-8", newline="") as handle:
        reader = csv.reader(handle, delimiter="\t")
        header = next(reader, None)
        if header != ["surface", "normalized"]:
            raise ValueError(f"manifest basligi beklenmiyor: {header}")
        return [SynonymRow(s, n) for s, n in reader]


def rollback(conn: psycopg.Connection, rows: Sequence[SynonymRow], *, write: bool) -> int:
    """Manifestteki satirlari (kind, surface, normalized uclusu birebir) siler."""
    with conn.cursor() as cur:
        cur.execute(
            """SELECT count(*) FROM lexicon l
                 JOIN unnest(%s::text[], %s::text[]) AS t(s, n)
                   ON l.kind = 'synonym' AND l.surface = t.s AND l.normalized = t.n""",
            ([r.surface for r in rows], [r.normalized for r in rows]),
        )
        matched = int(cur.fetchone()[0])  # type: ignore[index]
        if write and matched:
            cur.execute(
                """DELETE FROM lexicon l
                    USING unnest(%s::text[], %s::text[]) AS t(s, n)
                    WHERE l.kind = 'synonym' AND l.surface = t.s AND l.normalized = t.n""",
                ([r.surface for r in rows], [r.normalized for r in rows]),
            )
            conn.commit()
        else:
            conn.rollback()
    return matched
