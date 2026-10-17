-- kind: concurrent
-- 0082 — urun basina en ucuz TRY teklifi icin kismi indeks (islem disi, karar 0125)
--
-- Arama, gorsel arama, alternatifler ve link aramasi kart fiyatini urun basina
-- LATERAL ile okur (`bestOfferJoin`): `WHERE product_id = $1 AND is_active AND
-- currency = 'TRY' ORDER BY current_price LIMIT 1`. Bu indeks o okumayi urun
-- basina birkac sayfaya indirir ve yurt disi teklif hacminden (karar 0121)
-- bagimsiz tutar. Ad ve tanim acik bir daldaki tasarimla aynidir; IF NOT EXISTS
-- iki yolun da guvenle uygulanmasini saglar. Yalnizca ekleme.
CREATE INDEX CONCURRENTLY IF NOT EXISTS offer_try_product_idx ON offer (product_id, current_price)
    WHERE product_id IS NOT NULL AND is_active AND currency = 'TRY';
