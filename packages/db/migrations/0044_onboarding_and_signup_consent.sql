-- 0044 — ilk giris karsilamasi ve yeni hesap rizasi varsayilanlari
-- (docs/decisions/0059)
--
-- 1. `app_user.onboarded_at`: karsilama akisi tamamlandi mi / atlandi mi.
--    NULL = karsilama henuz gosterilmedi. Yeni hesaplar NULL ile acilir;
--    MEVCUT hesaplar bu migration'da `created_at` ile doldurulur, yani
--    karsilamayi gormez (geriye donuk akis degisikligi yok).
-- 2. `user_consent.source` CHECK'ine 'signup_default' eklenir: yeni hesap
--    acilirken yazilan varsayilan kararlar (kisisellestirme/gecmis, anonim
--    kesif) ve karsilamadaki bulten karari ayri izlenir. Mevcut kullanicilarin
--    satirlarina dokunulmaz; geriye donuk riza uretilmez (kvkk.md).
--
-- Geriye uyumlu: nullable kolon + CHECK genisletme. Eski kod kolonu yazmadan
-- calisir.

ALTER TABLE app_user ADD COLUMN IF NOT EXISTS onboarded_at TIMESTAMPTZ;

UPDATE app_user SET onboarded_at = created_at WHERE onboarded_at IS NULL;

ALTER TABLE user_consent DROP CONSTRAINT IF EXISTS user_consent_source_check;
ALTER TABLE user_consent ADD CONSTRAINT user_consent_source_check
    CHECK (source IS NULL OR source IN (
        'account_settings', 'cookie_banner', 'cookie_sync', 'sign_in', 'unsubscribe_link',
        'signup_default', 'onboarding'
    ));
