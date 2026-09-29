-- 0033 — pazarlama e-postasi rizasi, abonelik iptali ve IYS senkron durumu
-- (docs/decisions/0046)
--
-- Iki e-posta turu kesin ayridir: islemsel ileti (giris, alarm, hesap
-- bildirimi) rizaya bakmaz; ticari ileti yalnizca bu migration'in
-- tablolarindan gecen tek bir sunucu kapisindan (packages/core/src/marketing)
-- gonderilir.
--
-- 1. `user_consent` denetim kolonlari. Tablo 0009'dan beri gecmis tablosudur
--    (son satir = guncel durum). Bu migration onu VERITABANINDA da append-only
--    yapar: arilla_app yalnizca SELECT + INSERT. Hesap silinince satirlar
--    ON DELETE CASCADE ile gider; referans aksiyonu sahip rolun yetkisiyle
--    yurur (0010 notu), dogrudan DELETE engellenir.
--
--    Pazarlama rizasi yalnizca `text_version`, `source` ve `email` DOLU bir
--    `granted = true` satiriyla gecerlidir. Bu kolonlardan once yazilmis
--    eski satirlar (text_version NULL) gosterilebilir riza sayilmaz: mevcut
--    hicbir kullanici sessizce aboneye donusmez. Veri tasinmaz.
--
--    `granted_at` rizanin VERILDIGI an (admin_import'ta gecmis bir tarih
--    olabilir), `recorded_at` satirin yazildigi an. Guncel durum `granted_at`
--    sirasiyla belirlenir; boylece geriye tarihli bir ice aktarim sonraki bir
--    ret kararini ezemez.
--
-- 2. `email_suppression` (append-only): abonelik iptal bagi ile gelen adres
--    duzeyinde bastirma. Adres duz metin tutulmaz; normalize edilmis adresin
--    SHA-256 ozeti tutulur (hesap silinse de iptal kalici olsun diye
--    user_id ON DELETE SET NULL). Bastirma, kendisinden SONRA verilmis gecerli
--    bir riza satiri olmadikca gonderimi engeller.
--
-- 3. `marketing_email_send`: kampanya basina alici basina tek satir
--    (UNIQUE campaign_key + email_hash) — yeniden deneme ikinci e-posta
--    uretmez. Abonelik iptal token'i yalnizca SHA-256 ozetiyle burada durur.
--
-- 4. `consent_external_sync`: riza olaylarinin dis sistemle (IYS) senkron
--    durumu. IYS entegrasyonu HENUZ YOK; satirlar 'pending' kalir ve canli
--    gonderim kapisi 'synced' olmayan rizayi kabul etmez.
--
-- Geriye uyumlu: yalnizca nullable kolon, yeni tablo, indeks ve yetki
-- daraltmasi. Mevcut kod `user_consent`'e yalnizca INSERT yapar.
-- `source`/`text_version` NOT NULL kisiti kod dagitildiktan sonra ayri bir
-- migration'la eklenecek (CLAUDE.md kural 14).

-- ---------------------------------------------------------------------------
-- 1. user_consent
-- ---------------------------------------------------------------------------
ALTER TABLE user_consent
    ADD COLUMN IF NOT EXISTS source       TEXT,
    ADD COLUMN IF NOT EXISTS text_version TEXT,
    ADD COLUMN IF NOT EXISTS email        TEXT,
    ADD COLUMN IF NOT EXISTS recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE user_consent DROP CONSTRAINT IF EXISTS user_consent_source_check;
ALTER TABLE user_consent ADD CONSTRAINT user_consent_source_check
    CHECK (source IS NULL OR source IN (
        'signup', 'early_access', 'account_settings', 'feedback',
        'admin_import', 'unsubscribe_link', 'iys'
    ));

ALTER TABLE user_consent DROP CONSTRAINT IF EXISTS user_consent_text_version_check;
ALTER TABLE user_consent ADD CONSTRAINT user_consent_text_version_check
    CHECK (text_version IS NULL OR length(text_version) BETWEEN 1 AND 64);

-- Eski satirlar etkilenmez (NULL). Riza zamani kayit zamanindan sonra olamaz.
ALTER TABLE user_consent DROP CONSTRAINT IF EXISTS user_consent_granted_before_recorded;
ALTER TABLE user_consent ADD CONSTRAINT user_consent_granted_before_recorded
    CHECK (granted_at <= recorded_at);

CREATE INDEX IF NOT EXISTS user_consent_current_idx
    ON user_consent (user_id, kind, granted_at DESC, id DESC);

REVOKE UPDATE, DELETE, TRUNCATE ON user_consent FROM arilla_app;

-- ---------------------------------------------------------------------------
-- 2. email_suppression
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_suppression (
    id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email_hash  TEXT        NOT NULL CHECK (email_hash ~ '^[0-9a-f]{64}$'),
    channel     TEXT        NOT NULL DEFAULT 'marketing' CHECK (channel IN ('marketing')),
    reason      TEXT        NOT NULL
                CHECK (reason IN ('unsubscribe_link', 'admin', 'bounce', 'complaint')),
    user_id     BIGINT      REFERENCES app_user(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_suppression_lookup_idx
    ON email_suppression (email_hash, channel, created_at DESC);

REVOKE UPDATE, DELETE, TRUNCATE ON email_suppression FROM arilla_app;

-- ---------------------------------------------------------------------------
-- 3. marketing_email_send
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS marketing_email_send (
    id                      BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    campaign_key            TEXT        NOT NULL CHECK (campaign_key ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
    user_id                 BIGINT      REFERENCES app_user(id) ON DELETE SET NULL,
    email_hash              TEXT        NOT NULL CHECK (email_hash ~ '^[0-9a-f]{64}$'),
    consent_id              BIGINT      REFERENCES user_consent(id) ON DELETE SET NULL,
    unsubscribe_token_hash  TEXT        NOT NULL UNIQUE CHECK (unsubscribe_token_hash ~ '^[0-9a-f]{64}$'),
    status                  TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'sent', 'failed')),
    error_code              TEXT        CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_]{1,32}$'),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at                 TIMESTAMPTZ,
    CONSTRAINT marketing_email_send_once UNIQUE (campaign_key, email_hash)
);
CREATE INDEX IF NOT EXISTS marketing_email_send_user_idx
    ON marketing_email_send (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 4. consent_external_sync
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS consent_external_sync (
    consent_id       BIGINT      NOT NULL REFERENCES user_consent(id) ON DELETE CASCADE,
    provider         TEXT        NOT NULL CHECK (provider IN ('iys')),
    status           TEXT        NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'synced', 'failed')),
    attempts         INTEGER     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error_code  TEXT        CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_]{1,32}$'),
    external_ref     TEXT        CHECK (external_ref IS NULL OR length(external_ref) <= 128),
    synced_at        TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (consent_id, provider)
);
CREATE INDEX IF NOT EXISTS consent_external_sync_open_idx
    ON consent_external_sync (provider, created_at)
    WHERE status IN ('pending', 'failed');
