-- kind: schema
-- 0069 — eslesmemis teklif aramasi: trigram yerine kelime tabanli tam metin (karar 0114)
--
-- Olcum (gercek AliExpress verisi, 50 bin kayitlik ilk yukleme, pg_walinspect):
-- WAL'in %48'i `offer_unmatched_title_trgm` GIN indeksiydi (baslik basina ~100
-- trigram). 2,19 milyon kayitlik tam kosu 18 GB WAL uretti. Kelime tabanli
-- `tsvector` indeksi baslik basina ~15 giris tutar. `/teklifler` aramasi kelime/onek
-- eslesmesine gecer (packages/core/src/offers/list-feed-offers.ts).
--
-- Yalnizca kismi indeks degisir; veri ve kolon degismez. Indeks, 0067'de bu sayfa
-- icin eklenmisti; baska sorgu kullanmiyor.
CREATE INDEX offer_unmatched_title_fts ON offer USING gin (to_tsvector('simple', title_raw))
    WHERE product_id IS NULL AND is_active;
DROP INDEX IF EXISTS offer_unmatched_title_trgm;
