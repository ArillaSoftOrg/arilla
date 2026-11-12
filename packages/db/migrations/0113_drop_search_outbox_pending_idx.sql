-- kind: concurrent
-- 0113 — tuketicisi olmayan arama olay kuyrugunun bekleyen dizini kaldirilir (karar 0185, B4)
--
-- `search_outbox_pending_idx` (0065) `processed_at IS NULL` satirlarini tasir. Tuketici yok
-- (karar 0136): hicbir kod `processed_at` yazmaz, yani dizin TUM satirlari tasir ve yalniz
-- yazim maliyeti uretir (uretimde 647 MB, 30 M satir; 12 Kasim 2026). Okuyan tek yer
-- `pnpm db:health` idi: dizin yoksa tam sayim yerine tahmin raporlar (db-health-lib.ts).
--
-- SATIR SILINMEZ, `processed_at` isaretlenmez (kullanici karari; karar 0136 korunur). Dizin
-- turetilmis veridir: tuketici karariyla birlikte yeniden kurulur (asagida), veri kaybi yok.
--
-- GERI ALMA / TUKETICI GELINCE (islem disi, yazimlari kilitlemez):
--   CREATE INDEX CONCURRENTLY search_outbox_pending_idx ON search_outbox (id) WHERE processed_at IS NULL;

DROP INDEX CONCURRENTLY IF EXISTS search_outbox_pending_idx;
