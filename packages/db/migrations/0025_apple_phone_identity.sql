-- 0025 — Apple ve telefonla giris
--
-- Mevcut app_user + session modeli korunur (0024 ile ayni ilke): saglayici
-- kimligi `user_identity`'ye baglanir, OAuth access/refresh token'lari
-- saklanmaz.
--   apple -> provider_subject = Apple `sub`
--   phone -> provider_subject = E.164 numara (+905321234567)
--
-- `app_user.email` NULL olabilir hale gelir: telefonla gelen kullanicinin
-- e-postasi yoktur, Apple da e-postayi paylasmamayi secen kullanici icin
-- donmeyebilir. UNIQUE kisit kalir (NULL'lar cakismaz). Geriye uyumlu
-- (CLAUDE.md kural 14): kolon silinmez, yalnizca kisit gevsetilir.

ALTER TABLE app_user ALTER COLUMN email DROP NOT NULL;

ALTER TABLE user_identity DROP CONSTRAINT IF EXISTS user_identity_provider_check;
ALTER TABLE user_identity ADD CONSTRAINT user_identity_provider_check
    CHECK (provider IN ('google', 'apple', 'phone'));

-- Telefon dogrulama kodu. Kod duz metin saklanmaz: `code_hash` =
-- HMAC-SHA256(SESSION_SECRET, telefon + kod) — 6 haneli kod duz SHA-256 ile
-- saklansa bir milyon denemeyle geri cozulurdu. Tek kullanimlik
-- (`consumed_at`), sureli (`expires_at`), yanlis deneme sayili (`attempts`).
CREATE TABLE phone_login_code (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    phone       TEXT        NOT NULL,          -- E.164
    code_hash   TEXT        NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    attempts    SMALLINT    NOT NULL DEFAULT 0,
    request_ip  INET,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX phone_login_code_phone_idx ON phone_login_code (phone, created_at DESC);
