-- kind: schema
-- 0076 — yurt disi teklif sayisi (karar 0124)
--
-- `offer_count` yalnizca TRY teklif sayar (karar 0121): USD tutar kurus gibi okunup
-- fiyat ozetini kirletmesin. Bu yuzden yalnizca yurt disi teklifi olan yayinlanmis
-- urun (or. AliExpress kaynak ilani) arama yuzeylerinin `offer_count > 0` on
-- filtresinden dusuyordu. `foreign_offer_count` = aktif magazanin fiyatli aktif
-- TRY DISI teklifi olan farkli magaza sayisi. Arama uygunlugu
-- `offer_count > 0 OR foreign_offer_count > 0` olur; `min_price`/`max_price`
-- TRY-only KALIR.
--
-- GERIYE UYUMLU / YALNIZCA EKLEME: sabit varsayilanli kolon (PG 11+: tablo yeniden
-- yazilmaz). Mevcut tum satirlar 0 baslar; dogru deger fiyat ozeti onarimiyla
-- (`refreshProductAggregates` / `python -m similarity --prices`) yazilir. Eski kod
-- kolonu okumaz, davranis degismez.

ALTER TABLE product
    ADD COLUMN foreign_offer_count INTEGER NOT NULL DEFAULT 0
        CONSTRAINT product_foreign_offer_count_nonneg CHECK (foreign_offer_count >= 0);

-- Arama `best_offer`'i aday kumesi sinirli DEGILKEN (metinsiz filtre sorgusu, karar 0124)
-- yalnizca TRY teklif tarar. Yayindan sonra `offer_product_idx` milyonlarca yurt disi
-- teklifi de kapsar; bu kismi indeks TRY yolunu yurt disi hacminden bagimsiz tutar
-- (yalnizca TRY bagli aktif teklifler; kucuk). YALNIZCA EKLEME.
CREATE INDEX offer_try_product_idx ON offer (product_id, current_price)
    WHERE product_id IS NOT NULL AND is_active AND currency = 'TRY';
