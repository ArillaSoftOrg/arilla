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

ELIGIBLE_SQL = """
SELECT count(*)
  FROM product p
 WHERE p.publication_state = 'published' AND p.offer_count + p.foreign_offer_count > 0
"""

PER_MODEL_SQL = """
SELECT e.model_version,
       count(*)                                          AS vectors,
       count(*) FILTER (WHERE e.text_version = %(tv)s)   AS current_text_version,
       count(*) FILTER (WHERE p.publication_state = 'published'
                          AND p.offer_count + p.foreign_offer_count > 0) AS eligible_covered,
       max(e.embedded_at)                                AS last_embedded_at
  FROM product_text_embedding e
  JOIN product p ON p.id = e.product_id
 GROUP BY e.model_version
 ORDER BY e.model_version
"""


def coverage(conn: psycopg.Connection) -> dict[str, Any]:
    with conn.cursor() as cur:
        cur.execute("SET TRANSACTION READ ONLY")
        cur.execute(ELIGIBLE_SQL)
        eligible = int(cur.fetchone()[0])
        cur.execute(PER_MODEL_SQL, {"tv": TEXT_VERSION})
        rows = cur.fetchall()
    conn.rollback()
    models = [
        {
            "model_version": model,
            "vectors": int(vectors),
            "current_text_version": int(current),
            "eligible_covered": int(covered),
            "coverage_ratio": round(int(covered) / eligible, 4) if eligible else None,
            "last_embedded_at": last.isoformat() if last else None,
        }
        for model, vectors, current, covered, last in rows
    ]
    return {"table": "product_text_embedding", "eligible_products": eligible, "models": models}


def main() -> int:
    from db.connection import connect

    with connect() as conn:
        print(json.dumps(coverage(conn), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
