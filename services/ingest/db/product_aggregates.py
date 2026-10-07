"""`product` uzerindeki denormalize fiyat ozeti (docs/schema.sql).

Arama kartlari `min_price`/`offer_count`, butce suzgeci `min_price`,
alternatifler ve gorsel/link arama `offer_count > 0`, kesfet `in_stock_count`,
site haritasi `offer_count` okur. Ozet, teklifi yazan islemin ICINDE yenilenir
(toplama, link, eslestirme; yonetimde eslestirme onayi ve magaza ac/kapat).
Tam katalog onarimi `python -m similarity --prices` ve gunluk cron'dur.

Anlam, aramanin `best_offer` kuraliyla aynidir: yalnizca aktif MAGAZANIN
fiyatli aktif teklifi sayilir. `offer_count` = boyle teklifi olan farkli magaza
sayisi ("N magaza"); `in_stock_count` = bunlardan stokta olan magaza sayisi.
Kolon adlari migration gerektirmesin diye korunur.

Ayni SQL TypeScript tarafinda `packages/core/src/product/refresh-aggregates.ts`
icinde durur (yonetim yazmalari ve cron Python'u cagiramaz); ikisi birlikte
degisir.

Aktif teklifi kalmayan urun sifirlanir; degismeyen satir yazilmaz (tekrar
calistirmak 0 satir gunceller).
"""

from __future__ import annotations

from collections.abc import Iterable

import psycopg

_REFRESH_TEMPLATE = """
UPDATE product p SET
    min_price        = agg.min_price,
    max_price        = agg.max_price,
    offer_count      = agg.offer_count,
    in_stock_count   = agg.in_stock_count,
    price_updated_at = now(),
    updated_at       = now()
FROM (
    SELECT p2.id AS product_id,
           min(o.current_price)                                         AS min_price,
           max(o.current_price)                                         AS max_price,
           count(DISTINCT o.merchant_id)::int                           AS offer_count,
           count(DISTINCT o.merchant_id) FILTER (WHERE o.in_stock)::int AS in_stock_count
      FROM product p2
      LEFT JOIN (offer o JOIN merchant m ON m.id = o.merchant_id AND m.is_active)
        ON o.product_id = p2.id AND o.is_active AND o.current_price IS NOT NULL
     WHERE {scope}
     GROUP BY p2.id
) agg
WHERE p.id = agg.product_id
  AND (p.min_price, p.max_price, p.offer_count, p.in_stock_count)
      IS DISTINCT FROM (agg.min_price, agg.max_price, agg.offer_count, agg.in_stock_count)
"""

#: Tum katalog (onarim yolu).
REFRESH_ALL = _REFRESH_TEMPLATE.format(scope="TRUE")

#: Yalnizca verilen urunler; digerleri okunmaz ve yazilmaz.
REFRESH_PRODUCTS = _REFRESH_TEMPLATE.format(scope="p2.id = ANY(%(product_ids)s)")


def refresh_all(conn: psycopg.Connection) -> int:
    with conn.cursor() as cur:
        cur.execute(REFRESH_ALL)
        return cur.rowcount


def refresh_products(conn: psycopg.Connection, product_ids: Iterable[int]) -> int:
    ids = sorted({int(product_id) for product_id in product_ids})
    if not ids:
        return 0
    with conn.cursor() as cur:
        cur.execute(REFRESH_PRODUCTS, {"product_ids": ids})
        return cur.rowcount
