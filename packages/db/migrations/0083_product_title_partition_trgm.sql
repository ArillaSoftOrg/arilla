-- kind: concurrent
-- 0083 — aday bolumlerinin baslik trigram indeksleri (karar 0129)
--
-- Metin aramasi adaylari iki bolumden ayri ayri ve sinirli toplar: TRY teklifli
-- urun (`offer_count > 0`) ve geri kalan yayindaki urun (`offer_count = 0`:
-- yurt disi kaynak ilanlari, ozeti gecikmis urun). Tek indeksle TRY bolumu, ayni
-- kelimeyi tasiyan yuz binlerce yurt disi ilanin yiginda filtrelenerek aranirdi.
-- Ifade ve yuklem `packages/core/src/search/text-match.ts` ile AYNI yazilir.
--
-- YALNIZCA EKLEME, ISLEM DISI (CONCURRENTLY): yazimlari kilitlemez. Bugun yalnizca
-- yayindaki urunleri kapsar (taslaklar girmez); yayinla buyur. Eski
-- `product_title_fold_trgm` yonetim katalog aramasi icin simdilik kalir.

CREATE INDEX CONCURRENTLY IF NOT EXISTS product_title_fold_try_trgm ON product
    USING gin (lower(translate(title, 'ıİIŞşÇçĞğÖöÜüÂâÎîÛû', 'iiissccggoouuaaiiuu')) gin_trgm_ops)
    WHERE publication_state = 'published' AND offer_count > 0;

CREATE INDEX CONCURRENTLY IF NOT EXISTS product_title_fold_foreign_trgm ON product
    USING gin (lower(translate(title, 'ıİIŞşÇçĞğÖöÜüÂâÎîÛû', 'iiissccggoouuaaiiuu')) gin_trgm_ops)
    WHERE publication_state = 'published' AND offer_count = 0;
