"""Eski (V5) ve yeni (dinamik) siniflandirmanin YALNIZCA OKUYAN karsilastirmasi (karar 0154).

Hicbir sey yazilmaz: islem sonunda geri alinir. Ayni urun icin iki karar yan yana verilir;
dinamik motor etkin kapsam olarak `scopes` ya da (verilmezse) simule edilen tum Trendyol dallariyla
calisir. Cikti insan etiketlemesi icindir (TSV) ve kapsama/yanlis eslesme raporlarinin girdisidir.
"""

from __future__ import annotations

import random
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass, field

import psycopg

from classify.decide import Decision
from classify.run import SELECT_SAMPLE, Catalog, ClassifyAborted, _read, _Row, _rows, facts_for
from classify.scope import trendyol_scopes


@dataclass(frozen=True)
class Pair:
    product_id: int
    title: str
    source_path: str
    v5: Decision
    new: Decision

    @property
    def changed(self) -> bool:
        return self.v5.category_path != self.new.category_path

    @property
    def kind(self) -> str:
        """gain: V5 inceleme -> yazildi; refine: V5 kaynak-yalniz -> inceltildi; same: degismedi."""
        if not self.changed:
            return "same"
        return "gain" if self.v5.state == "review" else "refine"


@dataclass
class Comparison:
    pairs: list[Pair] = field(default_factory=list)
    scopes: tuple[str, ...] = ()

    def summary(self) -> dict[str, int | float]:
        n = len(self.pairs) or 1
        v5_applied = sum(1 for p in self.pairs if p.v5.state == "applied")
        new_applied = sum(1 for p in self.pairs if p.new.state == "applied")
        kinds = Counter(p.kind for p in self.pairs)
        # Dinamik motor yalniz inceltir/ekler: V5'te yazilan hicbir urun incelemeye DUSMEZ.
        lost = sum(1 for p in self.pairs if p.v5.state == "applied" and p.new.state == "review")
        return {
            "n": len(self.pairs),
            "v5_applied": v5_applied,
            "new_applied": new_applied,
            "v5_applied_pct": round(100 * v5_applied / n, 1),
            "new_applied_pct": round(100 * new_applied / n, 1),
            "gain": kinds["gain"],
            "refine": kinds["refine"],
            "same": kinds["same"],
            "lost": lost,
        }


def compare(
    conn: psycopg.Connection,
    *,
    n: int,
    mode: str = "random",
    seed: int | None = 1,
    after_id: int = 0,
    merchant_slug: str | None = None,
    scopes: Sequence[str] | None = None,
) -> Comparison:
    """`mode`: 'random' (rastgele n urun) ya da 'first' (kimlik sirasiyla ilk n urun)."""
    merchant_id: int | None = None
    if merchant_slug is not None:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM merchant WHERE slug = %s", (merchant_slug,))
            found = cur.fetchone()
        if found is None:
            raise ClassifyAborted("merchant_missing", merchant_slug)
        merchant_id = int(found[0])
    use = tuple(scopes) if scopes is not None else tuple(trendyol_scopes(conn))
    base = Catalog(conn)
    dyn = Catalog(conn, dynamic=True, scopes=use)
    rows = _pick(conn, n=n, mode=mode, seed=seed, after_id=after_id, merchant_id=merchant_id)
    out = Comparison(scopes=use)
    for row in rows:
        out.pairs.append(
            Pair(
                row.product_id,
                row.title,
                row.category_raw or "",
                base.decide(facts_for(row, base)),
                dyn.decide(facts_for(row, dyn)),
            )
        )
    base.pending_sources.clear()
    dyn.pending_sources.clear()
    conn.rollback()
    return out


def _pick(
    conn: psycopg.Connection,
    *,
    n: int,
    mode: str,
    seed: int | None,
    after_id: int,
    merchant_id: int | None,
) -> list[_Row]:
    if mode == "first":
        rows: list[_Row] = []
        after = after_id
        while len(rows) < n:
            batch = _read(conn, after, min(2_000, n - len(rows)), merchant_id)
            if not batch:
                break
            rows.extend(batch)
            after = batch[-1].product_id
        return rows
    rng = random.Random(seed)
    with conn.cursor() as cur:
        cur.execute("SELECT min(id), max(id) FROM product")
        lo, hi = cur.fetchone()  # type: ignore[misc]
    if lo is None:
        return []
    picked: dict[int, _Row] = {}
    for _ in range(20):
        if len(picked) >= n:
            break
        ids = list({rng.randint(int(lo), int(hi)) for _ in range(max(n * 4, 50))})
        with conn.cursor() as cur:
            cur.execute(SELECT_SAMPLE, {"ids": ids, "merchant_id": merchant_id})
            for row in _rows(cur.fetchall()):
                if len(picked) < n:
                    picked.setdefault(row.product_id, row)
    return sorted(picked.values(), key=lambda r: r.product_id)


def tsv(comparison: Comparison, *, only_changed: bool = False) -> str:
    """Insan etiketlemesi icin TSV (urun, baslik, kaynak, V5 yolu/dayanagi, yeni yol/dayanagi)."""
    head = "product_id\ttitle\tsource\tv5_path\tv5_basis\tnew_path\tnew_basis\tchange\tlabel_ok\n"
    lines = []
    for p in comparison.pairs:
        if only_changed and not p.changed:
            continue
        title = p.title.replace("\t", " ")[:160]
        lines.append(
            f"{p.product_id}\t{title}\t{p.source_path}\t{p.v5.category_path or ''}\t"
            f"{p.v5.category_basis}\t{p.new.category_path or ''}\t{p.new.category_basis}\t"
            f"{p.kind}\t"
        )
    return head + "\n".join(lines) + ("\n" if lines else "")
