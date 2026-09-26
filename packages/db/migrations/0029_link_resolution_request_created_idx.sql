-- 0029 — link cozumleme gunlugu icin zaman indeksi (docs/decisions/0041)
--
-- `/yonetim/arama/link` en yeni istekleri `ORDER BY created_at DESC, id DESC
-- LIMIT n` ile okur. Mevcut indekslerin hicbiri `created_at` ile baslamiyor
-- (`(session_id, created_at)`, `(normalized_url, created_at)`), bu yuzden her
-- sayfa acilisi tum tabloyu tarayip siraliyordu.
--
-- Kanit (yerel, 200.000 sentetik satir, islem geri alindi):
--   indekssiz: Parallel Seq Scan + top-N heapsort, 24,6 ms (satir sayisiyla dogrusal)
--   indeksli : Index Scan, 0,43 ms
-- 7 gunluk ozet sorgusu bu indeksten fayda gormez (pencere tablonun cogu);
-- onun icin ayrica indeks eklenmedi.
--
-- Migration'lar islem icinde calisir (scripts/migrate.ts), CONCURRENTLY
-- kullanilamaz. Tablo bugun kucuk; buyuk bir tabloda bu indeks elle
-- `CREATE INDEX CONCURRENTLY` ile once olusturulur, sonra migration
-- `IF NOT EXISTS` sayesinde bos gecer.
-- Geriye uyumlu: yalnizca indeks eklenir.

CREATE INDEX IF NOT EXISTS link_resolution_request_created_idx
    ON link_resolution_request (created_at DESC, id DESC);
