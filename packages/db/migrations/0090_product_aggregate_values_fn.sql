-- kind: schema
-- 0090 — fiyat ozeti kuralini OKUNABILIR yapar: product_aggregate_values(bigint[]) (karar 0135)
--
-- 0086 kurali `refresh_product_aggregates` icinde tutuyordu; fonksiyon hem hesaplar hem
-- `product` satirini gunceller. Toplu yayin (catalog_build publish) ayni satiri once
-- `published` yapip hemen ardindan ozet icin IKINCI kez yaziyordu: ayni islemde iki surum,
-- ikincisi de HOT olmadigindan butun indekslere yeniden giris. Laboratuvarda (1M AliExpress
-- taslagi) yayin WAL'inin %42'si bu ikinci yazimdi.
--
-- Kural artik tek yerde ve SALT OKUNUR bir fonksiyonda: `product_aggregate_values` urun basina
-- ozet degerlerini dondurur. `refresh_product_aggregates` ayni fonksiyonu okuyup degisen
-- satiri yazar (anlam, donus degeri ve kilit sirasi 0086 ile birebir ayni); yayin da ayni
-- degerleri `published` yazdigi TEK UPDATE icinde kullanir. Kopya SQL yoktur.
--
-- GERIYE UYUMLU / YALNIZCA EKLEME: yeni fonksiyon eklenir, `refresh_product_aggregates` imzasi
-- degismez (OR REPLACE). Eski kod yeni fonksiyonu cagirmaz.

CREATE OR REPLACE FUNCTION product_aggregate_values(product_ids bigint[])
RETURNS TABLE (
    product_id          bigint,
    min_price           bigint,
    max_price           bigint,
    offer_count         integer,
    in_stock_count      integer,
    foreign_offer_count integer
)
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
    SELECT p2.id,
           min(o.current_price) FILTER (WHERE o.currency = 'TRY'),
           max(o.current_price) FILTER (WHERE o.currency = 'TRY'),
           count(DISTINCT o.merchant_id) FILTER (WHERE o.currency = 'TRY')::int,
           count(DISTINCT o.merchant_id) FILTER (WHERE o.currency = 'TRY' AND o.in_stock)::int,
           count(DISTINCT o.merchant_id) FILTER (WHERE o.currency <> 'TRY')::int
      FROM product p2
      LEFT JOIN (offer o JOIN merchant m ON m.id = o.merchant_id AND m.is_active)
        ON o.product_id = p2.id AND o.is_active AND o.current_price IS NOT NULL
     WHERE p2.id = ANY(product_ids)
     GROUP BY p2.id
$$;

REVOKE ALL ON FUNCTION product_aggregate_values(bigint[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION product_aggregate_values(bigint[]) TO arilla_app;

CREATE OR REPLACE FUNCTION refresh_product_aggregates(product_ids bigint[]) RETURNS integer
LANGUAGE sql
SET search_path = public, pg_temp
AS $$
    WITH target AS (
        SELECT p.id, agg.*
          FROM product p JOIN product_aggregate_values(product_ids) agg ON agg.product_id = p.id
         WHERE (p.min_price, p.max_price, p.offer_count, p.in_stock_count, p.foreign_offer_count)
               IS DISTINCT FROM (agg.min_price, agg.max_price, agg.offer_count,
                                 agg.in_stock_count, agg.foreign_offer_count)
         ORDER BY p.id
           FOR UPDATE OF p
    ), changed AS (
        UPDATE product p SET
            min_price           = t.min_price,
            max_price           = t.max_price,
            offer_count         = t.offer_count,
            in_stock_count      = t.in_stock_count,
            foreign_offer_count = t.foreign_offer_count,
            price_updated_at    = now(),
            updated_at          = now()
          FROM target t
         WHERE p.id = t.id
        RETURNING 1
    )
    SELECT count(*)::int FROM changed
$$;

REVOKE ALL ON FUNCTION refresh_product_aggregates(bigint[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_product_aggregates(bigint[]) TO arilla_app;
