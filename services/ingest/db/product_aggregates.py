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

Yalnizca TRY teklifler sayilir: TRY disi (or. AliExpress USD) tutar kurus gibi
okunup `min_price`i kirletmesin (karar 0113/0121); yurt disi teklifler urun sayfasinda
kendi para birimiyle gosterilir. `foreign_offer_count` (0076, karar 0127) = fiyatli
aktif TRY DISI teklifi olan farkli magaza sayisi; yonetim paneli "fiyatsiz/magazasiz"
sayaclari bunu da okur. Arama uygunlugu henuz yalnizca `offer_count`tur.

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
    foreign_offer_count = agg.foreign_offer_count,
    price_updated_at = now(),
    updated_at       = now()
FROM (
    SELECT p2.id AS product_id,
           min(o.current_price) FILTER (WHERE o.currency = 'TRY') AS min_price,
           max(o.current_price) FILTER (WHERE o.currency = 'TRY') AS max_price,
           count(DISTINCT o.merchant_id) FILTER (WHERE o.currency = 'TRY')::int AS offer_count,
           count(DISTINCT o.merchant_id)
               FILTER (WHERE o.currency = 'TRY' AND o.in_stock)::int AS in_stock_count,
           count(DISTINCT o.merchant_id)
               FILTER (WHERE o.currency <> 'TRY')::int AS foreign_offer_count
      FROM product p2
      LEFT JOIN (offer o JOIN merchant m ON m.id = o.merchant_id AND m.is_active)
        ON o.product_id = p2.id AND o.is_active AND o.current_price IS NOT NULL
     WHERE {scope}
     GROUP BY p2.id
) agg
WHERE p.id = agg.product_id
  AND (p.min_price, p.max_price, p.offer_count, p.in_stock_count, p.foreign_offer_count)
      IS DISTINCT FROM (agg.min_price, agg.max_price, agg.offer_count, agg.in_stock_count,
                        agg.foreign_offer_count)
"""

#: Tum YAYINLANMIS katalog (onarim yolu). Yayinlanmamis kaynak ilanlari (milyonlarca taslak,
#: karar 0121) teklife bagli degildir; her gece taranmalari bos is olurdu.
REFRESH_ALL = _REFRESH_TEMPLATE.format(scope="p2.publication_state = 'published'")

#: Yalnizca verilen urunler; digerleri okunmaz ve yazilmaz.
REFRESH_PRODUCTS = _REFRESH_TEMPLATE.format(scope="p2.id = ANY(%(product_ids)s)")


#: Tam onarimin parti buyuklugu: her parti kendi isleminde kisa surer, degisen
#: `product` satirlari yalnizca parti boyunca kilitli kalir (ingest yazicilari beklemez).
REFRESH_BATCH_SIZE = 1000

_NEXT_PUBLISHED = """
SELECT id FROM product
 WHERE publication_state = 'published' AND id > %(after)s
 ORDER BY id
 LIMIT %(limit)s
"""


def refresh_all(conn: psycopg.Connection) -> int:
    with conn.cursor() as cur:
        cur.execute(REFRESH_ALL)
        return cur.rowcount


def refresh_all_batched(
    conn: psycopg.Connection, *, commit: bool = False, batch_size: int = REFRESH_BATCH_SIZE
) -> int:
    """`refresh_all` ile ayni sonuc, yayinlanmis urunler artan kimlikle partiler halinde.

    Tek dev UPDATE butun degisen satirlari islem sonuna kadar kilitler; ayni anda
    calisan toplama/eslestirme `refresh_products` bu satirlarda bekler. `commit=True`
    her partiyi kaydeder; varsayilan cagiranin islemidir (sonuc yine dogru, kilit
    suresi kisalmaz).
    """
    updated = 0
    after = 0
    while True:
        with conn.cursor() as cur:
            cur.execute(_NEXT_PUBLISHED, {"after": after, "limit": batch_size})
            ids = [int(row[0]) for row in cur.fetchall()]
        if not ids:
            break
        updated += refresh_products(conn, ids)
        if commit:
            conn.commit()
        after = ids[-1]
        if len(ids) < batch_size:
            break
    return updated


def refresh_products(conn: psycopg.Connection, product_ids: Iterable[int]) -> int:
    ids = sorted({int(product_id) for product_id in product_ids})
    if not ids:
        return 0
    with conn.cursor() as cur:
        cur.execute(REFRESH_PRODUCTS, {"product_ids": ids})
        return cur.rowcount
