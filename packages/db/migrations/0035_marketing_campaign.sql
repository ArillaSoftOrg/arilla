-- 0035 — pazarlama e-postasi kampanyalari ve alici basina teslim kaydi
-- (docs/decisions/0048)
--
-- Riza modeli DEGISMEZ: tek kaynak `user_consent` (0009), `marketing_email`
-- turunun en son satiri. Bu migration ikinci bir abonelik/opt-out bayragi
-- EKLEMEZ; abonelik iptali de `user_consent`'e ret satiri yazar.
--
-- Degismezler MOTOR tarafindan zorlanir:
-- - Bir kampanya bir kullaniciya en fazla bir teslim satiri acar
--   (UNIQUE (campaign_id, user_id)): cift tik, yeniden deneme ya da iki
--   yoneticinin ayni anda baslatmasi ikinci satir uretemez.
-- - `sent` satirinin `sent_at`'i dolu, `failed` satirinin hata kodu dolu,
--   `skipped` satirinin atlama nedeni dolu (CHECK).
-- - Durum gecisleri uygulamada kosullu UPDATE (`WHERE status = ...`) ile
--   yapilir; geri donus yok.
--
-- Gizlilik: alici ADRESI saklanmaz. Adres gonderim aninda `app_user.email`
-- uzerinden, riza yeniden denetlenerek okunur. Hesap silinirse teslim
-- satirinin `user_id`'si NULL olur (kisisel veri kalmaz) ve bekleyen
-- teslim atlanir. Abonelik iptal token'i yalnizca SHA-256 ozetiyle durur.
--
-- Silme yok: arilla_app bu iki tabloda DELETE/TRUNCATE yapamaz (kampanya
-- gecmisi denetim izidir). Hesap silmedeki ON DELETE SET NULL tablo sahibi
-- yetkisiyle calisir, REVOKE onu engellemez (0034 ile ayni not).
--
-- arilla_app yetkisi 0010'daki ALTER DEFAULT PRIVILEGES'ten gelir.
-- Geriye uyumlu: yalnizca yeni tablolar ve indeksler.

CREATE TABLE IF NOT EXISTS marketing_campaign (
    id                    BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id             UUID        NOT NULL DEFAULT uuid_generate_v4() UNIQUE,
    -- Yalnizca yonetimde gorunen ic ad.
    title                 TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
    subject               TEXT        NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 150),
    -- Duz metin: paragraflar bos satirla ayrilir, https baglantilari
    -- otomatik baglanir. HTML DEGILDIR; render sirasinda kacirilir.
    body                  TEXT        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 10000),
    status                TEXT        NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft','sending','completed','partially_failed',
                                            'failed','cancelled')),
    -- Her icerik degisikliginde artar. Gercek gonderim, yoneticinin onayladigi
    -- surumle ve o surumun test gonderimiyle eslesmek zorundadir.
    content_version       INTEGER     NOT NULL DEFAULT 1 CHECK (content_version >= 1),
    tested_version        INTEGER     CHECK (tested_version IS NULL OR tested_version >= 1),
    created_by            BIGINT      REFERENCES app_user(id) ON DELETE SET NULL,
    updated_by            BIGINT      REFERENCES app_user(id) ON DELETE SET NULL,
    send_requested_by     BIGINT      REFERENCES app_user(id) ON DELETE SET NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    send_started_at       TIMESTAMPTZ,
    completed_at          TIMESTAMPTZ,
    cancelled_at          TIMESTAMPTZ,
    -- Gonderim baslarken olusturulan teslim satiri sayisi (o anki uygun alici).
    recipient_count       INTEGER     CHECK (recipient_count IS NULL OR recipient_count >= 0),
    -- Son toplu islemin yapilandirma/islem hatasi (kod; deger ya da adres degil).
    last_error_code       TEXT        CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z_]{1,40}$'),
    last_error_at         TIMESTAMPTZ,
    CONSTRAINT marketing_campaign_send_started CHECK (
        (status IN ('draft') AND send_started_at IS NULL) OR
        (status IN ('sending','completed','partially_failed','failed') AND send_started_at IS NOT NULL) OR
        status = 'cancelled'
    ),
    CONSTRAINT marketing_campaign_completed CHECK (
        (status IN ('completed','partially_failed','failed')) = (completed_at IS NOT NULL)
    ),
    CONSTRAINT marketing_campaign_cancelled CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS marketing_campaign_created_idx
    ON marketing_campaign (created_at DESC, id DESC);
-- Toplu islemcinin taradigi tek kume.
CREATE INDEX IF NOT EXISTS marketing_campaign_sending_idx
    ON marketing_campaign (id) WHERE status = 'sending';

-- Alici basina teslim. Durum makinesi:
--   pending -> sending -> sent
--                      -> pending (gecici hata, attempt_count < sinir)
--                      -> failed  (kalici hata, deneme siniri, belirsiz sonuc)
--   pending -> skipped (gonderim aninda artik uygun degil, iptal)
-- `sending` satiri yalnizca bir islemcide; askida kalan `sending` YENIDEN
-- DENENMEZ (saglayici almis olabilir) ve `unknown_outcome` ile kapanir.
CREATE TABLE IF NOT EXISTS marketing_campaign_delivery (
    id                      BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    campaign_id             BIGINT      NOT NULL REFERENCES marketing_campaign(id) ON DELETE CASCADE,
    user_id                 BIGINT      REFERENCES app_user(id) ON DELETE SET NULL,
    state                   TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (state IN ('pending','sending','sent','failed','skipped')),
    attempt_count           SMALLINT    NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at         TIMESTAMPTZ,
    claimed_at              TIMESTAMPTZ,
    sent_at                 TIMESTAMPTZ,
    -- Bizim urettigimiz Message-ID basligi: ileride saglayici olaylariyla
    -- (bounce/complaint) eslestirmek icin. Adres icermez.
    provider_message_id     TEXT        CHECK (provider_message_id IS NULL OR char_length(provider_message_id) <= 255),
    failure_code            TEXT        CHECK (failure_code IS NULL OR failure_code IN (
                                'invalid_recipient','provider_rejected','temporary_error',
                                'configuration_error','unknown_outcome')),
    skip_reason             TEXT        CHECK (skip_reason IS NULL OR skip_reason IN (
                                'not_eligible','account_deleted','cancelled')),
    -- Saglayicinin dondurdugu kisa kod (EENVELOPE, 550 ...); ham mesaj DEGIL.
    provider_error_code     TEXT        CHECK (provider_error_code IS NULL OR provider_error_code ~ '^[A-Z0-9_]{1,32}$'),
    unsubscribe_token_hash  TEXT        UNIQUE CHECK (unsubscribe_token_hash IS NULL OR unsubscribe_token_hash ~ '^[0-9a-f]{64}$'),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT marketing_campaign_delivery_once UNIQUE (campaign_id, user_id),
    CONSTRAINT marketing_campaign_delivery_sent CHECK ((state = 'sent') = (sent_at IS NOT NULL)),
    CONSTRAINT marketing_campaign_delivery_failed CHECK ((state = 'failed') = (failure_code IS NOT NULL)),
    CONSTRAINT marketing_campaign_delivery_skipped CHECK ((state = 'skipped') = (skip_reason IS NOT NULL)),
    CONSTRAINT marketing_campaign_delivery_claimed CHECK (state <> 'sending' OR claimed_at IS NOT NULL)
);
-- Islemcinin siradaki isi: kampanya icinde bekleyen satirlar.
CREATE INDEX IF NOT EXISTS marketing_campaign_delivery_pending_idx
    ON marketing_campaign_delivery (campaign_id, id) WHERE state = 'pending';
-- Askida kalan gonderim taramasi.
CREATE INDEX IF NOT EXISTS marketing_campaign_delivery_sending_idx
    ON marketing_campaign_delivery (claimed_at) WHERE state = 'sending';
-- Durum sayimlari (yonetim ekrani).
CREATE INDEX IF NOT EXISTS marketing_campaign_delivery_state_idx
    ON marketing_campaign_delivery (campaign_id, state);
-- Hesap disa aktarimi ve kullanici bazli sorgu.
CREATE INDEX IF NOT EXISTS marketing_campaign_delivery_user_idx
    ON marketing_campaign_delivery (user_id) WHERE user_id IS NOT NULL;

-- Uygunluk sorgusu `marketing_email` rizasinin en son satirini kullanici
-- basina okur; esit `granted_at`'te `id` karar verir.
CREATE INDEX IF NOT EXISTS user_consent_marketing_latest_idx
    ON user_consent (user_id, granted_at DESC, id DESC) WHERE kind = 'marketing_email';

-- Ayni adresi (buyuk/kucuk harf farkiyla) tasiyan iki hesap ayni kampanyayi
-- iki kez almaz: uygunluk sorgusu en kucuk `id`'yi secer ve bunu bu
-- indeksle arar. `app_user.email` UNIQUE kisiti harfe duyarlidir.
CREATE INDEX IF NOT EXISTS app_user_email_lower_idx
    ON app_user (lower(email)) WHERE email IS NOT NULL;

REVOKE DELETE, TRUNCATE ON marketing_campaign FROM arilla_app;
REVOKE DELETE, TRUNCATE ON marketing_campaign_delivery FROM arilla_app;
