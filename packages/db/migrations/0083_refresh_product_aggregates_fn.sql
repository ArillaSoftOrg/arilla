-- kind: schema
-- 0083 — urun fiyat ozetinin TEK kaynagi: refresh_product_aggregates(bigint[])
--
-- Ayni UPDATE iki dilde birebir kopyaydi (`packages/core/src/product/refresh-aggregates.ts`,
-- `services/ingest/db/product_aggregates.py`); karar 0127 bile iki yerde birlikte
-- degistirmek zorunda kaldi. Kural artik yalnizca burada: TypeScript ve Python bu
-- fonksiyonu cagirir. Anlam degismez (0076 / karar 0127):
--   min_price, max_price, offer_count, in_stock_count: aktif magazanin fiyatli aktif
--   TRY teklifi; foreign_offer_count: fiyatli aktif TRY DISI teklifi olan farkli magaza.
-- Degismeyen satir yazilmaz; donus degeri guncellenen satir sayisidir. Kilit sirasi
-- urun kimligine gore artandir: es zamanli iki yazici ayni urunleri kilitlenmeden
-- gunceller. Kapsam yalnizca verilen kimlikler; tam onarim partiler halinde cagirir.
--
-- GERIYE UYUMLU / YALNIZCA EKLEME: eski kod fonksiyonu cagirmaz, davranis degismez.

CREATE FUNCTION refresh_product_aggregates(product_ids bigint[]) RETURNS integer
LANGUAGE sql
SET search_path = public, pg_temp
AS $$
    WITH agg AS (
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
         WHERE p2.id = ANY(product_ids)
         GROUP BY p2.id
    ), target AS (
        SELECT p.id, agg.*
          FROM product p JOIN agg ON agg.product_id = p.id
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
