-- kind: schema
-- 0101 — e-posta ve sifre ile kayit/giris (docs/decisions/0150)
--
-- Iki yeni tablo; mevcut tablolara dokunulmaz (Google/Apple/telefon/e-posta
-- baglantisi girisleri ayni `app_user`/`session` modelini kullanmaya devam eder).
--
--   password_credential     kullanici basina en fazla bir sifre ozeti (PK = user_id).
--                           Satir YALNIZCA e-posta adresinin kontrolu kanitlandiktan
--                           sonra yazilir (kayit dogrulamasi ya da sifre sifirlama):
--                           dogrulanmamis adres ile normal erisim yoktur.
--   email_credential_token  amaca ozel tek kullanimlik baglanti: 'verify_email'
--                           (kayit dogrulama) ve 'reset_password'. Token duz metin
--                           saklanmaz (HMAC-SHA256 ozeti). Kayit dogrulamada kayit
--                           aninda secilen sifrenin Argon2id ozeti burada bekler;
--                           `app_user` satiri dogrulama tamamlaninca acilir, boylece
--                           dogrulanmamis kayit bir adresi isgal edemez.
--
-- Sifre ozeti PHC dizgisidir ($argon2id$v=19$m=...,t=...,p=...$salt$hash);
-- parametreler ozetin icinde tasinir, ileride artirilabilir. Duz metin sifre
-- hicbir yerde saklanmaz ya da loglanmaz.
--
-- Hesap silinince `password_credential` CASCADE ile gider; bekleyen token'lar
-- e-postaya gore `deleteAccount` icinde silinir. arilla_app yetkisi 0010'daki
-- ALTER DEFAULT PRIVILEGES'ten gelir. Yalnizca ekleme; geriye uyumlu.
-- Geri alma: DROP TABLE email_credential_token; DROP TABLE password_credential;
-- (once kod geri alinir).

CREATE TABLE IF NOT EXISTS password_credential (
    user_id       BIGINT      PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
    password_hash TEXT        NOT NULL CHECK (password_hash LIKE '$argon2id$%'),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_credential_token (
    id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    purpose               TEXT        NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
    email                 TEXT        NOT NULL,
    token_hash            TEXT        NOT NULL UNIQUE,
    -- Yalnizca 'verify_email': kayit aninda secilen sifrenin Argon2id ozeti.
    pending_password_hash TEXT,
    pending_display_name  TEXT,
    expires_at            TIMESTAMPTZ NOT NULL,
    consumed_at           TIMESTAMPTZ,
    request_ip            INET,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT email_credential_token_pending_only_verify
        CHECK (purpose = 'verify_email' OR (pending_password_hash IS NULL AND pending_display_name IS NULL)),
    CONSTRAINT email_credential_token_verify_has_hash
        CHECK (purpose <> 'verify_email' OR pending_password_hash IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS email_credential_token_email_idx
    ON email_credential_token (email, purpose, created_at DESC);
-- Gunluk temizlik (`cleanupExpiredAuthRecords`) suresi dolmus satirlari siler.
CREATE INDEX IF NOT EXISTS email_credential_token_expires_idx
    ON email_credential_token (expires_at);
