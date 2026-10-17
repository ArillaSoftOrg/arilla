-- kind: schema
-- 0076 — yurt disi teklif sayisi (karar 0127; kolon tanimi yurt disi arama dalininkiyle ayni)
--
-- `offer_count`, `min_price`, `max_price`, `in_stock_count` yalnizca TRY teklif sayar
-- (karar 0121): USD tutar kurus gibi okunup fiyat ozetini kirletmesin. Bu yuzden
-- yalnizca yurt disi teklifi olan yayinlanmis urun (or. AliExpress kaynak ilani) ozette
-- "magazasiz, fiyatsiz" gorunuyordu ve ozet hic degismedigi icin `price_updated_at`
-- hic yazilmiyordu. `foreign_offer_count` = aktif magazanin fiyatli aktif TRY DISI
-- teklifi olan farkli magaza sayisi. Fiyat kolonlari TRY-only KALIR.
--
-- GERIYE UYUMLU / YALNIZCA EKLEME: sabit varsayilanli kolon (PG 11+: tablo yeniden
-- yazilmaz, 2,7 milyon satirda yalnizca katalog guncellemesi). Mevcut tum satirlar 0
-- baslar; dogru deger fiyat ozeti onarimiyla (gunluk `product_aggregates` cron'u,
-- `python -m similarity --prices`) yazilir. Eski kod kolonu okumaz, davranis degismez.
--
-- Numara 0076 bu kolon icin ayrilmisti (0078 notu). Yurt disi arama dalinin
-- `offer_try_product_idx` indeksi buraya alinmadi: buyuk `offer` tablosunda indeks
-- karar 0125 geregi ayri bir `kind: concurrent` migration'inda kurulur.

ALTER TABLE product
    ADD COLUMN foreign_offer_count INTEGER NOT NULL DEFAULT 0
        CONSTRAINT product_foreign_offer_count_nonneg CHECK (foreign_offer_count >= 0);
