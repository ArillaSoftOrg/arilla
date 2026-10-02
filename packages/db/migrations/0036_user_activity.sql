-- 0036 — kullanici aktivitesi: giris/cikis gecmisi, rizali analitik olaylari,
-- kullanici ozeti (docs/decisions/0049)
--
-- Uc veri sinifi karistirilmaz (0049 §4):
--   * `auth_event`            hizmet/guvenlik. Riza gerektirmez.
--   * `user_activity_event`   davranissal analitik. YALNIZCA analitik
--                             rizasiyla, tek core kapisindan
--                             (`packages/core/src/activity/record.ts`) yazilir.
--   * `user_activity_summary` kullanici basina tek satir; liste ekrani olay
--                             tablolarinda COUNT yapmasin diye.
--
-- Kisisel veri en aza indirilir: yeni tablolarda IP, ham user agent, token,
-- istek basligi ya da govdesi YOK; serbest JSON alani YOK (tipli kolonlar +
-- CHECK). Cihaz/tarayici yalnizca kaba sinif; ulke yalnizca platformun
-- ekledigi iki harfli kod (`x-vercel-ip-country`), IP'den turetilmez.
--
-- Gecmis uydurulmaz: mevcut kullanicilar icin satir yazilmaz (backfill yok).
-- Ozet satiri ilk olayda acilir; okuyan taraf eski hesaplarda `app_user`
-- alanlarina duser ve sayaclari "bilinmiyor" (NULL) gosterir.
--
-- Yetki (0010 varsayilan GRANT'lerinin daraltilmasi):
--   * auth_event: UPDATE/TRUNCATE yok. DELETE kalir: saklama suresi (1 yil)
--     uygulama rolunun gunluk temizligiyle uygulanir, SECURITY DEFINER
--     istisnasi (0021) acilmaz.
--   * user_activity_event: UPDATE yalnizca `query_norm` kolonunda (90 gunde
--     NULL'a cekme). DELETE kalir: riza geri alininca ve 180 gunde silme.
-- Hesap silinince uc tablo da ON DELETE CASCADE ile gider.
--
-- Geriye uyumlu: yeni tablolar, `session`'a nullable kolonlar, yeni indeksler.
-- Geri alma: kod geri alinir, tablolar bosta kalir; DROP ayri migration ile.

-- ---------------------------------------------------------------------------
-- session: kaba istek baglami (yalnizca yeni oturumlarda dolar)
-- ---------------------------------------------------------------------------
ALTER TABLE session
    ADD COLUMN IF NOT EXISTS device_class   TEXT,
    ADD COLUMN IF NOT EXISTS browser_family TEXT,
    ADD COLUMN IF NOT EXISTS country_code   TEXT;

ALTER TABLE session DROP CONSTRAINT IF EXISTS session_device_class_check;
ALTER TABLE session ADD CONSTRAINT session_device_class_check
    CHECK (device_class IS NULL OR device_class IN ('mobile','tablet','desktop','other'));
ALTER TABLE session DROP CONSTRAINT IF EXISTS session_browser_family_check;
ALTER TABLE session ADD CONSTRAINT session_browser_family_check
    CHECK (browser_family IS NULL OR browser_family IN
           ('chrome','safari','firefox','edge','samsung','opera','other'));
ALTER TABLE session DROP CONSTRAINT IF EXISTS session_country_code_check;
ALTER TABLE session ADD CONSTRAINT session_country_code_check
    CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$');

-- ---------------------------------------------------------------------------
-- auth_event: giris/cikis gecmisi (guvenlik)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth_event (
    id              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         BIGINT      NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    kind            TEXT        NOT NULL
                    CHECK (kind IN ('sign_up','sign_in','sign_out','session_revoked')),
    -- 'email' = e-posta baglantisi; digerleri user_identity.provider ile ayni.
    provider        TEXT        CHECK (provider IS NULL OR provider IN ('email','google','apple','phone')),
    -- Hangi oturum; FK yok cunku oturum satiri cikista/surede silinir.
    session_id      UUID,
    device_class    TEXT        CHECK (device_class IS NULL OR device_class IN ('mobile','tablet','desktop','other')),
    browser_family  TEXT        CHECK (browser_family IS NULL OR browser_family IN
                                       ('chrome','safari','firefox','edge','samsung','opera','other')),
    country_code    TEXT        CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$'),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT auth_event_provider_required
        CHECK (kind NOT IN ('sign_up','sign_in') OR provider IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS auth_event_user_idx ON auth_event (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS auth_event_created_idx ON auth_event (created_at);
-- Hesap basina tek kayit olayi: esanli ilk giris yarisi ikinci satir yazamaz.
CREATE UNIQUE INDEX IF NOT EXISTS auth_event_one_sign_up ON auth_event (user_id) WHERE kind = 'sign_up';

REVOKE UPDATE, TRUNCATE ON auth_event FROM arilla_app;

-- ---------------------------------------------------------------------------
-- user_activity_event: rizali davranissal analitik
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_activity_event (
    id            BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id       BIGINT      NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    kind          TEXT        NOT NULL
                  CHECK (kind IN ('search_submitted','product_viewed','merchant_exit')),
    channel       TEXT        NOT NULL DEFAULT 'web' CHECK (channel IN ('web','mcp','extension','api')),
    product_id    BIGINT      REFERENCES product(id) ON DELETE CASCADE,
    offer_id      BIGINT      REFERENCES offer(id) ON DELETE CASCADE,
    -- Attribution kaydina referans; tiklama verisi buraya KOPYALANMAZ (0049 §5).
    click_id      UUID        REFERENCES click(id) ON DELETE CASCADE,
    search_mode   TEXT        CHECK (search_mode IS NULL OR search_mode IN ('text')),
    -- Normalize edilmis sorgu (ham metin degil). 90 gunde NULL'a cekilir.
    query_norm    TEXT        CHECK (query_norm IS NULL OR char_length(query_norm) BETWEEN 1 AND 200),
    result_count  INTEGER     CHECK (result_count IS NULL OR result_count >= 0),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT user_activity_event_shape CHECK (
        (kind = 'search_submitted'
            AND search_mode IS NOT NULL
            AND product_id IS NULL AND offer_id IS NULL AND click_id IS NULL)
        OR (kind = 'product_viewed'
            AND product_id IS NOT NULL
            AND offer_id IS NULL AND click_id IS NULL
            AND search_mode IS NULL AND query_norm IS NULL AND result_count IS NULL)
        OR (kind = 'merchant_exit'
            AND offer_id IS NOT NULL AND click_id IS NOT NULL
            AND search_mode IS NULL AND query_norm IS NULL AND result_count IS NULL)
    )
);
CREATE INDEX IF NOT EXISTS user_activity_event_user_idx
    ON user_activity_event (user_id, created_at DESC, id DESC);
-- Tekrar bastirma (ayni sorgu/urun kisa surede) ve tur bazli sekme listesi.
CREATE INDEX IF NOT EXISTS user_activity_event_user_kind_idx
    ON user_activity_event (user_id, kind, created_at DESC);
-- Saklama suresi temizligi.
CREATE INDEX IF NOT EXISTS user_activity_event_created_idx
    ON user_activity_event (created_at);

REVOKE UPDATE, TRUNCATE ON user_activity_event FROM arilla_app;
GRANT UPDATE (query_norm) ON user_activity_event TO arilla_app;

-- ---------------------------------------------------------------------------
-- user_activity_summary: kullanici basina tek satir
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_activity_summary (
    user_id                   BIGINT      PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
    -- Hizmet/guvenlik (riza gerektirmez)
    first_sign_in_at          TIMESTAMPTZ,
    last_sign_in_at           TIMESTAMPTZ,
    last_active_at            TIMESTAMPTZ,
    -- Bu migration'dan sonra sayilan girisler; `service_counters_since`'ten beri.
    sign_in_count             INTEGER     CHECK (sign_in_count IS NULL OR sign_in_count >= 0),
    service_counters_since    TIMESTAMPTZ,
    last_device_class         TEXT        CHECK (last_device_class IS NULL OR last_device_class IN
                                                 ('mobile','tablet','desktop','other')),
    last_browser_family       TEXT        CHECK (last_browser_family IS NULL OR last_browser_family IN
                                                 ('chrome','safari','firefox','edge','samsung','opera','other')),
    last_country_code         TEXT        CHECK (last_country_code IS NULL OR last_country_code ~ '^[A-Z]{2}$'),
    -- Davranissal analitik (yalnizca riza varken artar; geri almada NULL)
    search_count              INTEGER     CHECK (search_count IS NULL OR search_count >= 0),
    last_search_at            TIMESTAMPTZ,
    product_view_count        INTEGER     CHECK (product_view_count IS NULL OR product_view_count >= 0),
    merchant_exit_count       INTEGER     CHECK (merchant_exit_count IS NULL OR merchant_exit_count >= 0),
    analytics_counters_since  TIMESTAMPTZ,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT user_activity_summary_service_counters CHECK (
        (sign_in_count IS NULL) = (service_counters_since IS NULL)
    ),
    CONSTRAINT user_activity_summary_analytics_counters CHECK (
        (analytics_counters_since IS NULL
            AND search_count IS NULL AND product_view_count IS NULL
            AND merchant_exit_count IS NULL AND last_search_at IS NULL)
        OR (analytics_counters_since IS NOT NULL
            AND search_count IS NOT NULL AND product_view_count IS NOT NULL
            AND merchant_exit_count IS NOT NULL)
    )
);
-- Liste "son aktif" sirasi (keyset). Hic aktif gorunmemis hesaplar bu
-- siralamada yer almaz; varsayilan siralama kayit tarihidir.
CREATE INDEX IF NOT EXISTS user_activity_summary_last_active_idx
    ON user_activity_summary (last_active_at DESC, user_id DESC)
    WHERE last_active_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- app_user: kullanici listesi ve arama siralamasi (created_at DESC, id DESC)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS app_user_created_idx ON app_user (created_at DESC, id DESC);
