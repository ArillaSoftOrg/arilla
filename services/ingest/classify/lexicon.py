"""Arama/sohbet sozlugu: kategori yuzeyleri ve esanlamlar (karar 0133).

Kategori yuzeyi `/ara` ve `/sohbet`te KATI kategori filtresi uretir; kategorisiz urun o
sorguda gorunmez. Bu yuzden siniflandirma kapsami yeterli olmadan acilmaz: migration ile
degil, siniflandirmadan SONRA bu komutla (`classify lexicon --apply`) yazilir. Var olan
satirin degeri degistirilmez (baska bir karar yazmis olabilir); catisma raporlanir.
"""

from __future__ import annotations

from dataclasses import dataclass

import psycopg

from classify.categories import depth
from classify.taxonomy import LEXICON, SYNONYMS


@dataclass(frozen=True)
class LexiconRow:
    kind: str
    surface: str
    normalized: str
    weight: float


def rows() -> list[LexiconRow]:
    out = [
        LexiconRow("category", surface, path, float(depth(path)))
        for path, surfaces in LEXICON.items()
        for surface in surfaces
    ]
    out.extend(LexiconRow("synonym", surface, norm, 1.0) for surface, norm in SYNONYMS)
    return out


@dataclass
class LexiconReport:
    inserted: int = 0
    existing: int = 0
    conflicts: list[str] | None = None
    missing_paths: list[str] | None = None


def apply(conn: psycopg.Connection, *, write: bool) -> LexiconReport:
    report = LexiconReport(conflicts=[], missing_paths=[])
    with conn.cursor() as cur:
        cur.execute("SELECT path FROM category")
        paths = {str(r[0]) for r in cur.fetchall()}
        cur.execute("SELECT kind, surface, normalized FROM lexicon")
        current = {(str(k), str(s)): str(n) for k, s, n in cur.fetchall()}
    wanted: list[LexiconRow] = []
    for row in rows():
        if row.kind == "category" and row.normalized not in paths:
            report.missing_paths.append(row.normalized)  # type: ignore[union-attr]
            continue
        have = current.get((row.kind, row.surface))
        if have is None:
            wanted.append(row)
        elif have == row.normalized:
            report.existing += 1
        else:
            report.conflicts.append(
                f"{row.kind}:{row.surface} -> {have} (istenen {row.normalized})"
            )  # type: ignore[union-attr]
    if write and wanted:
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO lexicon (kind, surface, normalized, weight)
                   SELECT * FROM unnest(%s::text[], %s::text[], %s::text[], %s::real[])
                   ON CONFLICT (kind, surface) DO NOTHING""",
                (
                    [r.kind for r in wanted],
                    [r.surface for r in wanted],
                    [r.normalized for r in wanted],
                    [r.weight for r in wanted],
                ),
            )
            report.inserted = cur.rowcount
        conn.commit()
    else:
        report.inserted = len(wanted) if not write else 0
        conn.rollback()
    return report
