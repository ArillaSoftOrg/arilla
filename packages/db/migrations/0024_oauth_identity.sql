-- 0023 — Google OAuth kimlik baglantilari
-- Mevcut app_user + session modeli korunur; saglayici kimligi kullaniciya
-- baglanir, OAuth access/refresh token'lari saklanmaz.

CREATE TABLE user_identity (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id          BIGINT      NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    provider         TEXT        NOT NULL CHECK (provider IN ('google')),
    provider_subject TEXT        NOT NULL,
    email            TEXT,
    email_verified   BOOLEAN     NOT NULL DEFAULT FALSE,
    display_name     TEXT,
    avatar_url       TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT user_identity_provider_subject_unique UNIQUE (provider, provider_subject)
);

CREATE INDEX user_identity_user_idx ON user_identity (user_id);
CREATE INDEX user_identity_email_idx ON user_identity (email) WHERE email IS NOT NULL;
