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

Kural tek yerde: salt okunur `product_aggregate_values(bigint[])` (migration 0090);
`refresh_product_aggregates(bigint[])` (0086) onu okuyup degisen satiri yazar. TypeScript
(`packages/core/src/product/refresh-aggregates.ts`, yonetim yazmalari ve cron) ayni
fonksiyonu cagirir; toplu yayin ozeti yayin UPDATE'inde yazar (karar 0135). Kopya SQL yoktur.

Yalnizca TRY teklifler sayilir: TRY disi (or. AliExpress USD) tutar kurus gibi
okunup `min_price`i kirletmesin (karar 0113/0121); yurt disi teklifler urun sayfasinda
kendi para birimiyle gosterilir. `foreign_offer_count` (0076, karar 0127) = fiyatli
aktif TRY DISI teklifi olan farkli magaza sayisi; arama uygunlugu
`offer_count > 0 OR foreign_offer_count > 0`dir.

Aktif teklifi kalmayan urun sifirlanir; degismeyen satir yazilmaz (tekrar
calistirmak 0 satir gunceller).
"""

from __future__ import annotations

from collections.abc import Iterable

import psycopg

#: Kural veritabaninda tek yerde (migration 0086); TypeScript de ayni fonksiyonu cagirir.
#: Donus: guncellenen satir sayisi. Kimlikler artan sirada kilitlenir.
REFRESH_PRODUCTS = "SELECT refresh_product_aggregates(%(product_ids)s::bigint[])"


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
    """Tum yayinlanmis katalog, cagiranin isleminde (bkz. `refresh_all_batched`)."""
    return refresh_all_batched(conn)


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
        row = cur.fetchone()
    return int(row[0]) if row else 0
