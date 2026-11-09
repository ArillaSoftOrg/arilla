"""Embedding kapsami: model basina kac uygun urunun guncel vektoru var (salt okunur, karar 0180).

    python -m enrich.coverage

Uygun urun, `enrich.products`'in hedefiyle aynidir: yayinda ve en az bir teklifi olan. Cikti
JSON'dur ve yalnizca sayilar icerir. Islem `READ ONLY` acilir; hicbir sey yazilmaz.
"""

from __future__ import annotations

import json
import sys
from typing import Any

import psycopg

from enrich.product_text import TEXT_VERSION
from enrich.registry import registry

ELIGIBLE_SQL = """
SELECT count(*)
  FROM product p
 WHERE p.publication_state = 'published' AND p.offer_count + p.foreign_offer_count > 0
"""

#: Tablo adi kayit defterinin ailelerinden gelir (beyaz liste), kullanici girdisi degildir.
PER_MODEL_SQL = """
SELECT e.model_version,
       count(*)                                          AS vectors,
       count(*) FILTER (WHERE e.text_version = %(tv)s)   AS current_text_version,
       count(*) FILTER (WHERE p.publication_state = 'published'
                          AND p.offer_count + p.foreign_offer_count > 0) AS eligible_covered,
       max(e.embedded_at)                                AS last_embedded_at
  FROM {table} e
  JOIN product p ON p.id = e.product_id
 GROUP BY e.model_version
 ORDER BY e.model_version
"""


def product_text_tables() -> list[str]:
    """Kayit defterinde urun metni ailelerinin yazilabilir tablolari (sirali, tekil)."""
    reg = registry()
    tables = {
        reg.family(spec).table
        for spec in reg.models.values()
        if "product_text" in spec.roles and reg.family(spec).table
    }
    return sorted(t for t in tables if t)


def coverage(conn: psycopg.Connection) -> dict[str, Any]:
    rows: list[tuple[str, tuple]] = []
    with conn.cursor() as cur:
        cur.execute("SET TRANSACTION READ ONLY")
        cur.execute(ELIGIBLE_SQL)
        eligible = int(cur.fetchone()[0])
        for table in product_text_tables():
            cur.execute(PER_MODEL_SQL.format(table=table), {"tv": TEXT_VERSION})
            rows.extend((table, row) for row in cur.fetchall())
    conn.rollback()
    models = [
        {
            "table": table,
            "model_version": model,
            "vectors": int(vectors),
            "current_text_version": int(current),
            "eligible_covered": int(covered),
            "coverage_ratio": round(int(covered) / eligible, 4) if eligible else None,
            "last_embedded_at": last.isoformat() if last else None,
        }
        for table, (model, vectors, current, covered, last) in rows
    ]
    return {"eligible_products": eligible, "models": models}


def main() -> int:
    from db.connection import connect

    with connect() as conn:
        print(json.dumps(coverage(conn), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
