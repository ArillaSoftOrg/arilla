"""Kalici embedding veri setini mevcut urun vektorlerinden doldurma (karar 0179). API CAGRISI YOK.

    python -m enrich.dataset                 # KURU CALISMA: yalniz sayar
    python -m enrich.dataset --execute       # `embedding_dataset`'e ekler (yalniz ekleme)

`embedding_dataset` (0109) 0179'dan once uretilmis vektorlerin metnini bilmez:
`product_text_embedding` metin saklamaz. Bu komut her urunun kanonik metnini GUNCEL
baslik/markadan yeniden kurar ve yalnizca ozeti saklanan `content_hash` ile ESLESIRSE
(metin vektor uretildiginden beri degismediyse) vektoru sunucu tarafinda kopyalayarak
arsive ekler. Eslesmeyen (sonradan degismis) urun atlanir: yanlis metin-vektor cifti arsive
girmez. Tekrar calistirmak guvenlidir (`ON CONFLICT DO NOTHING`).
"""

from __future__ import annotations

import argparse
import logging
import sys
from dataclasses import dataclass

import psycopg

from db.connection import connect
from enrich.product_text import TEXT_VERSION, build_product_text, content_hash
from enrich.products import MODEL, PASSAGE_TASK

logger = logging.getLogger(__name__)

DEFAULT_STEP = 5_000

SCAN_SQL = """
SELECT e.product_id, e.content_hash, p.title, b.name
  FROM product_text_embedding e
  JOIN product p ON p.id = e.product_id
  LEFT JOIN brand b ON b.id = p.brand_id
 WHERE e.model_version = %(model)s
   AND e.text_version = %(text_version)s
   AND e.product_id > %(after)s
   AND NOT EXISTS (SELECT 1 FROM embedding_dataset d
                    WHERE d.model_version = e.model_version AND d.content_hash = e.content_hash)
 ORDER BY e.product_id
 LIMIT %(n)s
"""

COPY_SQL = """
INSERT INTO embedding_dataset
       (model_version, content_hash, text_version, task, input_text, embedding, source,
        first_product_id)
SELECT e.model_version, e.content_hash, e.text_version, %(task)s, u.input_text, e.embedding,
       'backfill', e.product_id
  FROM unnest(%(ids)s::bigint[], %(texts)s::text[]) AS u(product_id, input_text)
  JOIN product_text_embedding e ON e.product_id = u.product_id AND e.model_version = %(model)s
ON CONFLICT (model_version, content_hash) DO NOTHING
"""

MAX_ID_SQL = "SELECT coalesce(max(product_id), 0) FROM product_text_embedding"


@dataclass
class DatasetCounts:
    scanned: int = 0
    matched: int = 0
    stale: int = 0
    inserted: int = 0
    last_id: int = 0


def backfill_dataset(
    conn: psycopg.Connection,
    *,
    model: str = MODEL,
    dry_run: bool = True,
    step: int = DEFAULT_STEP,
    after_id: int = 0,
) -> DatasetCounts:
    counts = DatasetCounts(last_id=after_id)
    while True:
        with conn.cursor() as cur:
            cur.execute(
                SCAN_SQL,
                {"model": model, "text_version": TEXT_VERSION, "after": counts.last_id, "n": step},
            )
            rows = cur.fetchall()
        conn.commit()
        if not rows:
            return counts
        counts.scanned += len(rows)
        counts.last_id = int(rows[-1][0])

        # Ayni ozet pencerede birden fazla urunde olabilir: tek satir yeter.
        chosen: dict[bytes, tuple[int, str]] = {}
        for product_id, stored, title, brand in rows:
            text = build_product_text(title, brand)
            if not text or content_hash(model, text) != bytes(stored):
                counts.stale += 1
                continue
            counts.matched += 1
            chosen.setdefault(bytes(stored), (int(product_id), text))
        if dry_run or not chosen:
            continue
        with conn.cursor() as cur:
            cur.execute(
                COPY_SQL,
                {
                    "model": model,
                    "task": PASSAGE_TASK,
                    "ids": [v[0] for v in chosen.values()],
                    "texts": [v[1] for v in chosen.values()],
                },
            )
            counts.inserted += max(cur.rowcount, 0)
        conn.commit()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="enrich.dataset", description="Kalici embedding veri setini doldur (karar 0179)"
    )
    parser.add_argument("--execute", action="store_true", help="yaz (varsayilan: kuru calisma)")
    parser.add_argument("--model", default=MODEL)
    parser.add_argument("--step", type=int, default=DEFAULT_STEP)
    parser.add_argument("--after-id", type=int, default=0)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    if args.step < 1 or args.after_id < 0:
        print("HATA: --step >= 1 ve --after-id >= 0 olmali", file=sys.stderr)
        return 2
    with connect() as conn:
        counts = backfill_dataset(
            conn, model=args.model, dry_run=not args.execute, step=args.step, after_id=args.after_id
        )
    suffix = "" if args.execute else " (KURU CALISMA: yazim yok)"
    print(f"--- embedding veri seti doldurma ({args.model}){suffix} ---")
    print(f"  arsivde olmayan vektor  {counts.scanned}")
    print(f"  metni eslesen           {counts.matched}")
    print(f"  metni degismis (atlandi){counts.stale:>6}")
    print(f"  eklenen satir           {counts.inserted}")
    print(f"  son urun kimligi        {counts.last_id}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
