-- 0062 — sohbet gorsel eki icin acik riza turu (docs/decisions/0101)
--
-- `user_consent.kind` CHECK'ine `chat_image` ve `source` CHECK'ine `chat_image_prompt`
-- eklenir. Gorsel yukleme, kullanici bu rizayi verene kadar sunucuda reddedilir.
-- Yalnizca CHECK genisletme: mevcut satirlar ve kod degismeden calisir, veri tasinmaz,
-- yetkiler degismez. Geri alinmasi: bu iki CHECK'i 0045/0037 listesine dondurmek
-- (once `chat_image` satirlari silinmeli).

ALTER TABLE user_consent DROP CONSTRAINT IF EXISTS user_consent_kind_check;
ALTER TABLE user_consent ADD CONSTRAINT user_consent_kind_check
    CHECK (kind IN (
        'browsing_history', 'marketing_email', 'personalization', 'public_discovery',
        'cookie_functional', 'cookie_analytics', 'cookie_marketing',
        'privacy_notice', 'chat_image'
    ));

ALTER TABLE user_consent DROP CONSTRAINT IF EXISTS user_consent_source_check;
ALTER TABLE user_consent ADD CONSTRAINT user_consent_source_check
    CHECK (source IS NULL OR source IN (
        'account_settings', 'cookie_banner', 'cookie_sync', 'sign_in', 'unsubscribe_link',
        'signup_default', 'onboarding', 'chat_image_prompt'
    ));
