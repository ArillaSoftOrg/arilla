-- 0030 — suresi dolmus giris kayitlarinin temizligi icin indeksler
--
-- `cleanupExpiredAuthRecords` (packages/core/src/auth/cleanup.ts) her gun
-- `expires_at < esik` kosuluyla `auth_token`, `phone_login_code` ve `session`
-- satirlarini siler. `session_expiry_idx` zaten var. `auth_token`'daki
-- `auth_token_cleanup_idx` kismidir (`consumed_at IS NULL`) ve tuketilmis
-- satirlari kapsamaz; `phone_login_code`'da `expires_at` indeksi yoktu.
--
-- Migration'lar islem icinde calisir (scripts/migrate.ts), CONCURRENTLY
-- kullanilamaz. Tablolar kucuk (satirlar en fazla bir gun yasar); buyumusse
-- indeks once elle `CREATE INDEX CONCURRENTLY` ile olusturulur, migration
-- `IF NOT EXISTS` sayesinde bos gecer. Temizlik kodu bu indeksler olmadan da
-- dogru calisir, yalnizca daha yavas.
-- Geriye uyumlu: yalnizca indeks eklenir.

CREATE INDEX IF NOT EXISTS auth_token_expires_idx ON auth_token (expires_at);
CREATE INDEX IF NOT EXISTS phone_login_code_expires_idx ON phone_login_code (expires_at);
