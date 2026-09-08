-- 0009 — kisisellestirme ve kesif
-- docs/schema.sql referans belgesinden bire bir tasindi.

-- ---------------------------------------------------------------------------
-- KİŞİSELLEŞTİRME VE KEŞİF
-- ---------------------------------------------------------------------------

-- Son gezilenler. Kullanıcı başına son 50 kayıtla sınırlı, eskisi silinir.
-- KVKK: kişisel veridir. Açık rıza gerekir, kullanıcı silebilmelidir.
CREATE TABLE product_view (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT      REFERENCES app_user(id) ON DELETE CASCADE,
    session_id  TEXT        NOT NULL,
    product_id  BIGINT      NOT NULL REFERENCES product(id),
    viewed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX product_view_user_idx ON product_view (user_id, viewed_at DESC)
    WHERE user_id IS NOT NULL;

-- Beden profili. Bir kez girilir, tüm sonuçlarda "senin bedenin var" filtresi
-- çalışır. Modada satın alma kararının kendisi budur.
CREATE TABLE user_size_profile (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    category_path TEXT  NOT NULL,        -- 'ayakkabi', 'ust-giyim'
    size_norm    TEXT   NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT user_size_uniq UNIQUE (user_id, category_path)
);

-- KVKK rıza kayıtları. Neye, ne zaman rıza verildi.
CREATE TABLE user_consent (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT      NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    kind        TEXT        NOT NULL
                CHECK (kind IN ('browsing_history','marketing_email','personalization','public_discovery')),
    granted     BOOLEAN     NOT NULL,
    granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    ip          INET
);
CREATE INDEX user_consent_idx ON user_consent (user_id, kind, granted_at DESC);

-- Trend listeleri. Haftalık toplu işle üretilir, sayfa statik servis edilir.
-- Arama, kaydetme ve tıklama sayılarından türetilir; editör gerekmez.
CREATE TABLE trend_snapshot (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    slug          TEXT        NOT NULL,        -- 'yaz-trend-parfumleri'
    title         TEXT        NOT NULL,
    description   TEXT,
    cover_url     TEXT,
    category_path TEXT,
    -- algorithmic: veriden otomatik üretilir, bakım gerektirmez
    -- editorial:   biri elle kürasyonlar, haftalık emek ister
    kind          TEXT        NOT NULL DEFAULT 'algorithmic'
                  CHECK (kind IN ('algorithmic','editorial')),
    -- Sponsorlu içerik HER ZAMAN etiketlenir. Organikten görsel olarak ayrılır.
    is_sponsored       BOOLEAN NOT NULL DEFAULT FALSE,
    sponsor_merchant_id BIGINT REFERENCES merchant(id),
    period_start  DATE        NOT NULL,
    period_end    DATE        NOT NULL,
    product_ids   BIGINT[]    NOT NULL,
    computed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    is_published  BOOLEAN     NOT NULL DEFAULT FALSE,
    CONSTRAINT trend_snapshot_uniq UNIQUE (slug, period_start),
    CONSTRAINT trend_sponsor_check CHECK (NOT is_sponsored OR sponsor_merchant_id IS NOT NULL)
);
CREATE INDEX trend_snapshot_live_idx ON trend_snapshot (slug, period_start DESC)
    WHERE is_published;

-- Keşfet akışı: "diğer kullanıcıların bulduları". İsimsizdir.
-- Toplu işle doldurulur, üç koruma kuralı orada uygulanır:
--   1. category.is_discoverable = TRUE olmalı
--   2. distinct_finder_count >= eşik (tek kişinin bulduğu ürün girmez)
--   3. found_label bulanıktır: "bu hafta", kesin zaman damgası değil
-- Ayrıca user_consent'te public_discovery reddedilmişse o kullanıcının
-- bulduğu ürünler hiç sayılmaz.
CREATE TABLE public_find (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id    BIGINT      NOT NULL REFERENCES product(id),
    -- curated: soğuk başlangıç için elle seçilmiş havuz
    -- organic:  gerçekten kullanıcılar tarafından bulunmuş
    -- Etiket ayrımı zorunludur: seçilmiş ürünler arayüzde ASLA
    -- "kullanıcıların bulduğu" diye gösterilmez.
    source        TEXT        NOT NULL DEFAULT 'organic'
                  CHECK (source IN ('curated','organic')),
    distinct_finder_count INTEGER,             -- curated için NULL
    found_label   TEXT,                        -- 'bu hafta'. curated için NULL.
    first_found_at DATE,                       -- gün hassasiyeti, saat değil
    rank_score    REAL        NOT NULL DEFAULT 0,
    computed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT public_find_uniq UNIQUE (product_id),
    -- organik kayıt eşiği geçmeden akışa giremez
    CONSTRAINT public_find_organic_check
        CHECK (source <> 'organic' OR distinct_finder_count IS NOT NULL)
);
CREATE INDEX public_find_rank_idx ON public_find (source, rank_score DESC);

-- Keşfet ızgarasının günlük rotasyonu. Tarihe göre deterministik üretilir,
-- böylece sayfa önbelleklenebilir ve aynı gün herkes aynısını görür.
-- Organik keşifler önce yerleştirilir, kalan boşluklar curated havuzdan dolar;
-- gerçek keşifler arttıkça curated payı kendiliğinden düşer.
CREATE TABLE discovery_slot (
    slot_date   DATE     NOT NULL,
    position    SMALLINT NOT NULL,
    product_id  BIGINT   NOT NULL REFERENCES product(id),
    source      TEXT     NOT NULL CHECK (source IN ('curated','organic')),
    PRIMARY KEY (slot_date, position)
);
CREATE INDEX discovery_slot_date_idx ON discovery_slot (slot_date);
