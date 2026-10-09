-- 0059 — api_usage: model cagrisinin girdi/cikti token ayrimi
--
-- Gemini girdi ve cikti tokenlari farkli fiyatlanir; `units` yalnizca toplami
-- tutuyordu, bu yuzden maliyet hesaplanamiyordu. Iki NULL'a izin veren kolon
-- eklenir:
--
-- input_tokens:  saglayicinin bildirdigi girdi tokeni (istem + gorsel).
-- output_tokens: faturalanan cikti tokeni (yanit + dusunme; Gemini dusunmeyi
--                cikti fiyatiyla ucretlendirir).
--
-- NULL = saglayici kullanim bildirmedi (zaman asimi, ag hatasi) ya da satir
-- token tabanli degil (embedding, eski satirlar). Uydurulmaz; 0 ile karismaz.
-- `units` aynen kalir (Gemini satirlarinda saglayicinin toplam tokeni).
--
-- Yalnizca ekleme, varsayilansiz NULL kolon: tablo yeniden yazilmaz, eski kod
-- (TypeScript ve Python yazarlari) degisiklik olmadan calisir. Yetkiler tablo
-- duzeyinde oldugu icin yeni kolonlari da kapsar. Geri alma: once kod geri
-- alinir; kolonlar zararsiz kalabilir.

ALTER TABLE api_usage
    ADD COLUMN IF NOT EXISTS input_tokens  INTEGER,
    ADD COLUMN IF NOT EXISTS output_tokens INTEGER;

ALTER TABLE api_usage
    DROP CONSTRAINT IF EXISTS api_usage_token_split_nonnegative;
ALTER TABLE api_usage
    ADD CONSTRAINT api_usage_token_split_nonnegative
    CHECK ((input_tokens IS NULL OR input_tokens >= 0)
       AND (output_tokens IS NULL OR output_tokens >= 0)) NOT VALID;
ALTER TABLE api_usage VALIDATE CONSTRAINT api_usage_token_split_nonnegative;
