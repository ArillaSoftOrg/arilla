-- 0005 — kullanici ve kimlik dogrulama
-- docs/schema.sql referans belgesinden bire bir tasindi.

-- ---------------------------------------------------------------------------
-- KULLANICI VE CREATOR
-- ---------------------------------------------------------------------------

CREATE TABLE app_user (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id     UUID        NOT NULL DEFAULT uuid_generate_v4() UNIQUE,
    email         TEXT        NOT NULL UNIQUE,      -- giriş e-posta bağlantısıyla
    email_verified_at TIMESTAMPTZ,
    display_name  TEXT,
    avatar_url    TEXT,
    role          TEXT        NOT NULL DEFAULT 'user'
                  CHECK (role IN ('user','creator','moderator','admin')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at  TIMESTAMPTZ
);
CREATE INDEX app_user_role_idx ON app_user (role) WHERE role <> 'user';

-- ---------------------------------------------------------------------------
-- KİMLİK DOĞRULAMA — e-posta bağlantısı ile giriş
-- Token asla düz metin saklanmaz, asla log'a yazılmaz.
-- ---------------------------------------------------------------------------

CREATE TABLE auth_token (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email       TEXT        NOT NULL,
    token_hash  TEXT        NOT NULL UNIQUE,   -- SHA-256, düz metin değil
    expires_at  TIMESTAMPTZ NOT NULL,          -- oluşturulma + 15 dakika
    consumed_at TIMESTAMPTZ,                   -- tek kullanımlık
    request_ip  INET,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX auth_token_email_idx ON auth_token (email, created_at DESC);
CREATE INDEX auth_token_cleanup_idx ON auth_token (expires_at) WHERE consumed_at IS NULL;

CREATE TABLE session (
    id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id       BIGINT      NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    token_hash    TEXT        NOT NULL UNIQUE,
    user_agent    TEXT,
    ip            INET,
    expires_at    TIMESTAMPTZ NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX session_user_idx ON session (user_id);
CREATE INDEX session_expiry_idx ON session (expires_at);
