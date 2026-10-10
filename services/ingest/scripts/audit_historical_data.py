"""Gecmisten kalan veri sorunlarinin SALT OKUNUR taramasi (AI denetimi, PR #86).

    python scripts/audit_historical_data.py [--limit 25]

Hicbir sey yazmaz: baglanti `READ ONLY` islemde acilir, veritabani yazmayi reddeder.
Cikti yalnizca sayilar ve teklif/urun kimlikleri + basliklaridir (kisisel veri yok).

Uc tarama:

1. **Yanlis birlesmis urunler.** Ayni `product_id`'ye bagli, farkli magazalardan teklif
   ciftleri YENI esleme kurallariyla (`resolve.score.combine`) puanlanir; veto edilenler
   (hacim 100/10 ml, model numarasi, kapasite, paket adedi, renk...) tarihsel yanlis
   birlesme adayidir. Duzeltme bu betigin isi DEGILDIR: `price_point` degismez,
   insan karari gerekir.
2. **TRY disi teklifler** (`offer.currency <> 'TRY'`): arama ve ozetler para birimine bakmaz.
3. **Dusuk guvenli link teklifleri** (`attributes_raw.low_confidence`): sezgisel katman fiyati.
"""

from __future__ import annotations

import argparse
import sys
from collections import defaultdict

import psycopg

from db.connection import database_url
from resolve.normalize import ProductKey
from resolve.score import combine

SAME_PRODUCT_PAIRS = """
SELECT a.product_id, a.id, a.title_raw, a.brand_raw, a.attributes_raw->>'color',
       b.id, b.title_raw, b.brand_raw, b.attributes_raw->>'color'
  FROM offer a
  JOIN offer b ON b.product_id = a.product_id AND b.id > a.id
 WHERE a.product_id IS NOT NULL AND a.is_active AND b.is_active
"""

NON_TRY = """
SELECT currency, count(*), count(*) FILTER (WHERE is_active) FROM offer
 WHERE currency <> 'TRY' GROUP BY currency ORDER BY 2 DESC
"""


def scan_merged_products(conn: psycopg.Connection, limit: int) -> int:
    with conn.cursor() as cur:
        cur.execute(SAME_PRODUCT_PAIRS)
        rows = cur.fetchall()
    suspects: dict[int, list[tuple[str, int, str, int, str]]] = defaultdict(list)
    for product_id, a_id, a_title, a_brand, a_color, b_id, b_title, b_brand, b_color in rows:
        left = ProductKey.build(a_title, a_brand, a_color)
        right = ProductKey.build(b_title, b_brand, b_color)
        result = combine(left, right)
        if result.vetoed:
            suspects[int(product_id)].append(
                (result.veto or "", int(a_id), a_title, int(b_id), b_title)
            )
    print(f"[1] ayni urune bagli teklif cifti: {len(rows)}; veto edilen urun: {len(suspects)}")
    for product_id, items in list(sorted(suspects.items()))[:limit]:
        reason, a_id, a_title, b_id, b_title = items[0]
        print(f"    urun {product_id}: {reason}")
        print(f"        offer {a_id}: {a_title[:80]}")
        print(f"        offer {b_id}: {b_title[:80]}")
    return len(suspects)


def scan_currency(conn: psycopg.Connection) -> int:
    with conn.cursor() as cur:
        cur.execute(NON_TRY)
        rows = cur.fetchall()
    total = sum(int(row[1]) for row in rows)
    print(f"[2] TRY disi teklif: {total}")
    for currency, count, active in rows:
        print(f"    {currency}: {count} (aktif {active})")
    return total


def scan_low_confidence(conn: psycopg.Connection) -> int:
    with conn.cursor() as cur:
        cur.execute(
            """SELECT count(*), count(*) FILTER (WHERE o.is_active)
                 FROM offer o WHERE o.attributes_raw->>'low_confidence' = 'true'"""
        )
        row = cur.fetchone()
    total, active = (int(row[0]), int(row[1])) if row else (0, 0)
    print(f"[3] dusuk guvenli (sezgisel katman) link teklifi: {total} (aktif {active})")
    return total


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--limit", type=int, default=25, help="listelenecek en fazla urun")
    args = parser.parse_args(argv)
    # Uygulama rolu yeterli (yalnizca SELECT); okuma-yazma ayrimi veritabaninca da zorlanir.
    url = database_url("DATABASE_URL")
    with psycopg.connect(url, options="-c default_transaction_read_only=on") as conn:
        conn.execute("SET TRANSACTION READ ONLY")
        scan_merged_products(conn, args.limit)
        scan_currency(conn)
        scan_low_confidence(conn)
        conn.rollback()
    return 0


if __name__ == "__main__":
    sys.exit(main())
