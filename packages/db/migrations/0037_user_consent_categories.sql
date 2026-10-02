-- 0037 — user_consent: cerez kategorileri, aydinlatma surumu kaydi, kaynak ve
-- metin surumu (docs/decisions/0049 §6)
--
-- Riza modelinin tek kaynagi DEGISMEZ: `user_consent` (0009; pazarlama da
-- ayni kaynagi okur, 0048). Guncel durum her tur icin en son satirdir
-- (`granted_at DESC, id DESC`); kod yalnizca INSERT yapar.
--
-- Bu migration yalnizca GENISLETIR:
--   * `kind` CHECK'ine cerez kategorileri ve `privacy_notice` eklenir.
--     `privacy_notice` bir riza DEGILDIR: kullaniciya hangi aydinlatma metni
--     surumunun gosterildiginin kaydidir; hicbir isleme ona dayanmaz.
--   * Iki nullable kolon: `source` (kayit nereden geldi) ve `text_version`
--     (karar aninda gecerli metin/kategori surumu).
--
-- MEVCUT SATIRLAR GECERLIDIR ve yeniden yazilmaz: `source`/`text_version`
-- NULL kalir, yonetim ekraninda yalnizca "surumsuz kayit" etiketi alir;
-- durumu degismez, izni kapatmaz (0048'in reddettigi 0033 modeli
-- uygulanmaz). Veri tasinmaz.
--
-- Yetkiler degismez (0010 varsayilanlari). Geriye uyumlu: CHECK genisletme +
-- nullable kolonlar. Mevcut kod bu kolonlari yazmadan calismaya devam eder.

ALTER TABLE user_consent DROP CONSTRAINT IF EXISTS user_consent_kind_check;
ALTER TABLE user_consent ADD CONSTRAINT user_consent_kind_check
    CHECK (kind IN (
        'browsing_history', 'marketing_email', 'personalization', 'public_discovery',
        'cookie_functional', 'cookie_analytics', 'cookie_marketing',
        'privacy_notice'
    ));

ALTER TABLE user_consent
    ADD COLUMN IF NOT EXISTS source       TEXT,
    ADD COLUMN IF NOT EXISTS text_version TEXT;

ALTER TABLE user_consent DROP CONSTRAINT IF EXISTS user_consent_source_check;
ALTER TABLE user_consent ADD CONSTRAINT user_consent_source_check
    CHECK (source IS NULL OR source IN (
        'account_settings', 'cookie_banner', 'cookie_sync', 'sign_in', 'unsubscribe_link'
    ));

ALTER TABLE user_consent DROP CONSTRAINT IF EXISTS user_consent_text_version_check;
ALTER TABLE user_consent ADD CONSTRAINT user_consent_text_version_check
    CHECK (text_version IS NULL OR char_length(text_version) BETWEEN 1 AND 64);

-- Kullanici basina tur bazli son satir (`granted_at DESC, id DESC`): mevcut
-- `user_consent_idx (user_id, kind, granted_at DESC)` esitlik bozucuyu
-- kapsamiyordu.
CREATE INDEX IF NOT EXISTS user_consent_latest_idx
    ON user_consent (user_id, kind, granted_at DESC, id DESC);
