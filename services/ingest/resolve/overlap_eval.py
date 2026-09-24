"""Gercek capraz-magaza eslestirme olcumu (docs/decisions/0029).

    python -m resolve.overlap_eval

`tests/fixtures/matching/overlap_pairs.json` elle dogrulanmis cift listesidir
(barkod, uretici SKU'su ya da marka+model+hacim/renk). Her cift veritabanindaki
offer'lara cevrilir ve eslestirmenin sonucu siniflandirilir:

- ayni urun cifti:  `tp_auto` (ayni product), `tp_queued` (insan kuyrugunda
  bekleyen dogru aday), `fn` (ayri urunler, aday bile yok)
- zor negatif:      `fp_auto` (yanlislikla ayni product — guvenlik ihlali),
  `fp_queued` (kuyrukta; insan reddedecek), `tn`

Offer bulunamayan cift `missing` sayilir (katalog tavani disinda kalmis
olabilir); olcumden dusulur, gizlenmez.
"""

from __future__ import annotations

import json
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import psycopg

PAIRS_PATH = (
    Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "matching" / "overlap_pairs.json"
)

FIND_OFFERS = """
SELECT o.id, o.product_id, o.attributes_raw->>'color'
  FROM offer o JOIN merchant m ON m.id = o.merchant_id
 WHERE m.slug = %(merchant)s AND o.attributes_raw->>'id' = %(shopify_id)s AND o.is_active
"""

#: Kuyruktaki aday: bir tarafin offer'i digerinin urunune onerilmis ama
#: bekliyor (offer bu durumda urune BAGLI DEGILDIR).
PENDING_BETWEEN = """
SELECT 1 FROM match_candidate mc
 WHERE mc.status = 'pending'
   AND ((mc.offer_id = %(a)s AND mc.product_id = %(pb)s)
        OR (mc.offer_id = %(b)s AND mc.product_id = %(pa)s))
"""


@dataclass
class OverlapResult:
    counts: Counter = field(default_factory=Counter)
    details: list[dict[str, Any]] = field(default_factory=list)


def _norm(value: str | None) -> str:
    return (value or "").strip().lower()


def _offer(conn: psycopg.Connection, side: dict[str, Any]) -> tuple[int, int | None] | None:
    """Cift tarafini offer'a cevirir. `variant` renk bolmesine karsilik
    geliyorsa o renk secilir; beden/hacim ise (renk bolmesi yok) tek offer."""
    with conn.cursor() as cur:
        cur.execute(
            FIND_OFFERS,
            {"merchant": side["merchant"], "shopify_id": str(side["shopify_product_id"])},
        )
        rows = cur.fetchall()
    if not rows:
        return None
    # Varyant ya renk ("Rose Quartz") ya da Shopify varyant basligidir
    # ("Peach Rose / 0.59 LT"): parcalardan biri renk bolmesiyle eslesir.
    parts = {_norm(part) for part in str(side.get("variant") or "").split("/")} - {""}
    if len(rows) > 1 and parts:
        rows = [row for row in rows if _norm(row[2]) in parts] or rows
    if len(rows) != 1:
        return None
    return int(rows[0][0]), (int(rows[0][1]) if rows[0][1] is not None else None)


def _pending(
    conn: psycopg.Connection, a: tuple[int, int | None], b: tuple[int, int | None]
) -> bool:
    if a[1] is None and b[1] is None:
        return False
    with conn.cursor() as cur:
        cur.execute(PENDING_BETWEEN, {"a": a[0], "b": b[0], "pa": a[1], "pb": b[1]})
        return cur.fetchone() is not None


def evaluate(conn: psycopg.Connection, path: Path = PAIRS_PATH) -> OverlapResult:
    data = json.loads(path.read_text(encoding="utf-8"))
    result = OverlapResult()
    for kind, pairs in (
        ("same", data["same_product"]),
        ("different", data["different_but_similar"]),
    ):
        for pair in pairs:
            a, b = _offer(conn, pair["a"]), _offer(conn, pair["b"])
            if a is None or b is None or a[0] == b[0]:
                # Ayni offer'a dusen cift (orn. ayni urunun iki bedeni) urun
                # duzeyinde olculemez.
                outcome = "missing" if a is None or b is None else "not_measurable"
            elif a[1] is not None and a[1] == b[1]:
                outcome = "tp_auto" if kind == "same" else "fp_auto"
            elif _pending(conn, a, b):
                outcome = "tp_queued" if kind == "same" else "fp_queued"
            else:
                outcome = "fn" if kind == "same" else "tn"
            result.counts[outcome] += 1
            result.details.append(
                {
                    "kind": kind,
                    "outcome": outcome,
                    "evidence": pair.get("evidence"),
                    "a": f"{pair['a']['merchant']}: {pair['a'].get('title', '')[:60]}",
                    "b": f"{pair['b']['merchant']}: {pair['b'].get('title', '')[:60]}",
                }
            )
    return result


def main() -> int:
    from db.connection import connect

    with connect() as conn:
        result = evaluate(conn)
    for detail in result.details:
        evidence = detail["evidence"] or "-"
        print(f"{detail['outcome']:<15} {evidence:<22} {detail['a']}  <>  {detail['b']}")
    print("\n" + " ".join(f"{key}={value}" for key, value in sorted(result.counts.items())))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
