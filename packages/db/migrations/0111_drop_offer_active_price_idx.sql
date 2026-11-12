-- kind: concurrent
-- 0111 — fiyat degisimini HOT'tan alikoyan kullanilmayan dizin kaldirilir (karar 0185, B1)
--
-- `offer_active_price_idx` (0002) tum etkin/stokta teklifleri `current_price`'a gore siralar.
-- Uretimde ~4 haftada 0 tarama (pg_stat_user_indexes, 12 Kasim 2026). Koddaki
-- `ORDER BY o.current_price` sorgularinin hepsi TEK urunun teklifleri uzerindedir ve
-- `offer_product_idx` ile calisir. Dizin yalniz yazim maliyeti uretiyor: `current_price`
-- dizinli oldugu icin her fiyat degisimi HOT olamiyor (yeni surum + 13 dizine kayit).
--
-- GERI ALMA (islem disi, yazimlari kilitlemez; 13 M teklifte dakikalar):
--   CREATE INDEX CONCURRENTLY offer_active_price_idx ON offer (current_price) WHERE is_active AND in_stock;

DROP INDEX CONCURRENTLY IF EXISTS offer_active_price_idx;
