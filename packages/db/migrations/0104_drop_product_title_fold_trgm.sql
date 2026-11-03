-- kind: concurrent
-- 0104 — yayin yazimini yavaslatan yedek baslik GIN'i kaldirilir (karar 0169)
--
-- `product_title_fold_trgm` (yayindaki TUM urunler) ile `product_title_fold_try_trgm` +
-- `product_title_fold_foreign_trgm` (0083) ayni ifade uzerinde AYNI satirlari kapsar: iki
-- bolum (`offer_count > 0` / `= 0`) birlikte tum yayindaki urunlerdir. Yedek indeks yalnizca
-- yazim maliyeti uretiyordu: her yayinlanan urun uc yerine dort GIN'e girer; yerel olcumde
-- `UPDATE product` suresinin %41'i ve yayin WAL'inin %27'si bu indeksindir.
--
-- ONKOSUL (sirayla): yonetim katalog aramasi (`packages/core/src/admin/catalog.ts`
-- `queryCondition`) bolum kollarina tasindi ve DAGITILDI. Bu migration ondan ONCE
-- calisirsa yonetim basligi aramasi seq scan'e duser (yalniz yonetim; herkese acik arama
-- zaten bolum indekslerini kullanir). Bu yuzden kod PR'indan ayri, onun ardindan gelir.
--
-- GERI ALMA (islem disi, yazimlari kilitlemez; 10 M yayindaki urunde dakikalar-saatler):
--   CREATE INDEX CONCURRENTLY product_title_fold_trgm ON product
--       USING gin (lower(translate(title, 'ıİIŞşÇçĞğÖöÜüÂâÎîÛû', 'iiissccggoouuaaiiuu')) gin_trgm_ops)
--       WHERE publication_state = 'published';

DROP INDEX CONCURRENTLY IF EXISTS product_title_fold_trgm;
