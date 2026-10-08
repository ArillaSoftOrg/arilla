-- 0051 — okunabilir davet kodu (docs/decisions/0067)
--
-- `app_user.referral_public_code`: "YS-49577" biciminde, herkese gorunen davet
-- kodu. EKLEMELI ve geriye uyumludur: `referral_code` (0034, 8 karakter) ve
-- tum mevcut davet linkleri AYNEN calismaya devam eder; kod iki kolonda da
-- aranir. Backfill YOK - kod, kullanicinin /hesap sayfasini ilk acisinda
-- uygulama tarafindan uretilir ve bir daha degismez.
--
-- Tekrar calistirilabilir (IF NOT EXISTS). Kolon silinmez/degistirilmez.

ALTER TABLE app_user ADD COLUMN IF NOT EXISTS referral_public_code TEXT
    CHECK (referral_public_code IS NULL OR referral_public_code ~ '^[A-Z]{2}-[0-9]{5}$');
CREATE UNIQUE INDEX IF NOT EXISTS app_user_referral_public_code_unique
    ON app_user (referral_public_code) WHERE referral_public_code IS NOT NULL;
