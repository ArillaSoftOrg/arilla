-- 0002 — katalog
-- docs/schema.sql referans belgesinden bire bir tasindi.

-- ---------------------------------------------------------------------------
-- KATALOG
-- ---------------------------------------------------------------------------

CREATE TABLE merchant (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    slug            TEXT        NOT NULL UNIQUE,
    name            TEXT        NOT NULL,
    domain          TEXT        NOT NULL UNIQUE,
    logo_url        TEXT,
    -- veri erişimi
    source_type     TEXT        NOT NULL
                    CHECK (source_type IN ('xml_feed','api','affiliate_network','user_discovered')),
    feed_url        TEXT,
    feed_config     JSONB       NOT NULL DEFAULT '{}'::jsonb,
    refresh_minutes INTEGER     NOT NULL DEFAULT 360,
    -- ticari
    affiliate_network   TEXT,
    affiliate_status    TEXT    NOT NULL DEFAULT 'none'
                        CHECK (affiliate_status IN ('none','pending','active','suspended')),
    commission_rate_bp  INTEGER,          -- baz puan. 400 = %4
    deeplink_template   TEXT,
    -- durum
    is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
    trust_score     SMALLINT    NOT NULL DEFAULT 50 CHECK (trust_score BETWEEN 0 AND 100),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE brand (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    slug        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    name_norm   TEXT NOT NULL,            -- küçük harf, aksansız, boşluksuz
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX brand_name_norm_idx ON brand (name_norm);

CREATE TABLE category (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    slug        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    parent_id   BIGINT REFERENCES category(id),
    path        TEXT NOT NULL,            -- 'moda/canta/omuz-cantasi'
    -- Keşfet akışına girebilir mi. İç giyim, sağlık, mahrem ürünler FALSE.
    -- İsimsiz gösterim tek başına yeterli koruma değildir.
    is_discoverable BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX category_path_idx ON category (path text_pattern_ops);

-- Kanonik ürün. Birden fazla merchant'ın aynı ürünü buraya bağlanır.
CREATE TABLE product (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id       UUID        NOT NULL DEFAULT uuid_generate_v4() UNIQUE,
    slug            TEXT        NOT NULL UNIQUE,
    title           TEXT        NOT NULL,
    brand_id        BIGINT      REFERENCES brand(id),
    category_id     BIGINT      REFERENCES category(id),
    gtin            TEXT,                 -- barkod. Türkiye'de sıklıkla boş.
    mpn             TEXT,
    -- Aynı modelin farklı renkleri aynı model_key'i paylaşır.
    -- product renk düzeyinde kanoniktir: siyah ve bej ayrı üründür.
    model_key       TEXT,
    color           TEXT,
    attributes      JSONB       NOT NULL DEFAULT '{}'::jsonb,  -- renk, malzeme, beden
    primary_image_url TEXT,
    -- denormalize edilmiş, toplu işle güncellenir. İstek yolu bunları okur.
    min_price       BIGINT,
    max_price       BIGINT,
    offer_count     INTEGER     NOT NULL DEFAULT 0,
    in_stock_count  INTEGER     NOT NULL DEFAULT 0,
    price_updated_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX product_brand_idx    ON product (brand_id);
CREATE INDEX product_category_idx ON product (category_id);
CREATE INDEX product_gtin_idx     ON product (gtin) WHERE gtin IS NOT NULL;
CREATE INDEX product_title_trgm   ON product USING gin (title gin_trgm_ops);
CREATE INDEX product_min_price_idx ON product (min_price) WHERE min_price IS NOT NULL;
CREATE INDEX product_model_key_idx ON product (model_key) WHERE model_key IS NOT NULL;

-- Slug değişirse eski adres 301 ile yönlendirilir. Hiçbir URL ölmez.
CREATE TABLE product_slug_history (
    slug        TEXT   PRIMARY KEY,
    product_id  BIGINT NOT NULL REFERENCES product(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Bir merchant'ın bir ürün listesi. product_id NULL olabilir: henüz eşleşmemiş.
CREATE TABLE offer (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    merchant_id     BIGINT      NOT NULL REFERENCES merchant(id),
    product_id      BIGINT      REFERENCES product(id),          -- NULLABLE. Kasıtlı.
    external_id     TEXT        NOT NULL,                        -- merchant'ın kendi ID'si
    url             TEXT        NOT NULL,
    title_raw       TEXT        NOT NULL,
    brand_raw       TEXT,
    category_raw    TEXT,
    image_url       TEXT,
    image_hash      TEXT,                                        -- tekrarlı görsel tespiti
    attributes_raw  JSONB       NOT NULL DEFAULT '{}'::jsonb,
    -- güncel durum. Geçmiş price_point'te.
    current_price   BIGINT,
    list_price      BIGINT,
    currency        CHAR(3)     NOT NULL DEFAULT 'TRY',
    in_stock        BOOLEAN     NOT NULL DEFAULT TRUE,
    shipping_days   SMALLINT,
    shipping_cost   BIGINT,                  -- en ucuz görünen her zaman en ucuz değil
    free_shipping_threshold BIGINT,
    -- veri edinme yolu. Katalog talebe göre büyür.
    discovery_source TEXT       NOT NULL DEFAULT 'feed'
                     CHECK (discovery_source IN ('feed','api','user_link')),
    -- yaşam döngüsü
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT offer_merchant_external_uniq UNIQUE (merchant_id, external_id)
);
CREATE INDEX offer_product_idx    ON offer (product_id) WHERE product_id IS NOT NULL;
CREATE INDEX offer_unmatched_idx  ON offer (merchant_id) WHERE product_id IS NULL;
CREATE INDEX offer_image_hash_idx ON offer (image_hash) WHERE image_hash IS NOT NULL;
CREATE INDEX offer_active_price_idx ON offer (current_price) WHERE is_active AND in_stock;

-- Beden varyantları. Stok bedene göre değişir; "senin bedenin var mı" sorusu
-- moda kategorisinde satın alma kararının kendisidir.
-- Fiyat geçmişi burada DEĞİL, offer düzeyinde tutulur.
CREATE TABLE offer_variant (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    offer_id       BIGINT  NOT NULL REFERENCES offer(id) ON DELETE CASCADE,
    external_id    TEXT    NOT NULL,
    size_label     TEXT,                    -- '38', 'M', 'Tek ebat'
    size_norm      TEXT,                    -- normalize edilmiş karşılaştırma anahtarı
    in_stock       BOOLEAN NOT NULL DEFAULT TRUE,
    price_override BIGINT,                  -- nadir. NULL ise offer.current_price geçerli.
    last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT offer_variant_uniq UNIQUE (offer_id, external_id)
);
CREATE INDEX offer_variant_offer_idx ON offer_variant (offer_id) WHERE in_stock;

-- Stok DEĞİŞİMİ olayları. Anlık görüntü değil — sadece durum değiştiğinde satır
-- yazılır, yoksa tablo her toplama koşusunda şişer.
-- "38 beden 3 gündür yok" ve "yeniden stoğa girdi" bildirimleri buradan gelir.
CREATE TABLE variant_stock_event (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    variant_id  BIGINT      NOT NULL REFERENCES offer_variant(id) ON DELETE CASCADE,
    in_stock    BOOLEAN     NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX variant_stock_event_idx ON variant_stock_event (variant_id, observed_at DESC);
