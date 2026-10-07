"""Backfill A (karar 0073): mevcut `offer.image_url` -> `offer_image` (display_rank=0).

    python -m collect.backfill_images            # DRY-RUN: yalniz sayar, yazmaz
    python -m collect.backfill_images --apply    # yazar (uretimde ELLE, karar 0073 plani)

Guvenlik:
- Varsayilan dry-run. `--apply` acikca verilmeden hicbir satir yazilmaz.
- YALNIZCA hic `offer_image` satiri olmayan offer'lara yazar: zengin galerisi
  olan bir offer'in gorselleri bu betikle `removed` olmaz, ezilmez.
- Anahtar kumeli (id ASC) kucuk gruplar; her grup tek ifade + tek commit.
  Yarida kesilirse yeniden calistirmak guvenlidir (islenenler anti-join ile
  atlanir): ayri checkpoint tablosu gerekmez.
- Ag yok, indirme yok; yalniz metadata.

Backfill B (kaynaktan ilk 6 gorsel) bu betik DEGILDIR: normal Shopify ingest'in
yeniden calistirilmasidir (idempotent upsert).
"""

from __future__ import annotations

import argparse
import logging
from dataclasses import dataclass

import psycopg

from collect.image_writer import write_offer_images
from collect.images import SourceImage, select_images

logger = logging.getLogger(__name__)

BATCH_SIZE = 500

NEXT_BATCH = """
SELECT o.id, o.image_url
  FROM offer o
 WHERE o.id > %(after)s
   AND o.image_url IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM offer_image oi WHERE oi.offer_id = o.id)
 ORDER BY o.id
 LIMIT %(limit)s
"""


@dataclass
class BackfillResult:
    offers_seen: int = 0
    offers_with_image: int = 0
    rows_written: int = 0
    batches: int = 0


def backfill(
    conn: psycopg.Connection, *, apply: bool = False, batch_size: int = BATCH_SIZE
) -> BackfillResult:
    result = BackfillResult()
    after = 0
    while True:
        with conn.cursor() as cur:
            cur.execute(NEXT_BATCH, {"after": after, "limit": batch_size})
            rows = cur.fetchall()
        if not rows:
            break
        after = int(rows[-1][0])
        items = []
        for offer_id, image_url in rows:
            result.offers_seen += 1
            images = select_images([SourceImage(image_url, position=0, primary=True)])
            if images:
                result.offers_with_image += 1
                items.append((int(offer_id), images))
        result.batches += 1
        if apply and items:
            result.rows_written += write_offer_images(conn, items).written
            conn.commit()
        elif not apply:
            conn.rollback()
    return result


def main() -> None:
    from db.connection import database_url

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--apply", action="store_true", help="yaz (varsayilan: dry-run)")
    parser.add_argument("--batch-size", type=int, default=BATCH_SIZE)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    with psycopg.connect(database_url("DATABASE_URL")) as conn:
        result = backfill(conn, apply=args.apply, batch_size=args.batch_size)
    mode = "APPLY" if args.apply else "DRY-RUN"
    print(
        f"[{mode}] offer={result.offers_seen} gorselli={result.offers_with_image} "
        f"yazilan={result.rows_written} grup={result.batches}"
    )


if __name__ == "__main__":
    main()
