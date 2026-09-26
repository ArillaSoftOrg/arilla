-- Creator-Led AI Shopping Platform — çekirdek şema
-- PostgreSQL 16 + pgvector
--
-- Tasarım prensipleri:
--   1. product (kanonik ürün) ile offer (merchant listesi) ayrıdır.
--   2. offer.product_id NULLABLE'dır. Eşleşmemiş offer sistemde yaşayabilir.
--   3. price_point sadece INSERT alır. Geriye dönük üretilemeyen tek varlık budur.
--   4. embedding satırları model_version taşır. Model değişimi katalogu çöpe atmaz.
--   5. Para kuruş cinsinden BIGINT. Asla float.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

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
                    CHECK (source_type IN ('xml_feed','api','affiliate_network','user_discovered','shopify')),
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
    -- min_price: aktif tekliflerin en düşüğü, TÜM varyantlar dahil (0033).
    -- "Başlangıç fiyatı"dır; farklı boyutlar (60/100 ml) karşılaştırılabilir
    -- "en ucuz" fiyat değildir. Varyant bazlı karşılaştırma ürün sayfasında.
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
-- Metin aramasinin aday kapisi (0029): katlanmis baslik. Ifade
-- packages/core/src/search/text-match.ts foldedTitleExpr ile birebir ayni.
CREATE INDEX product_title_fold_trgm ON product
    USING gin (lower(translate(title, 'ıİIŞşÇçĞğÖöÜüÂâÎîÛû', 'iiissccggoouuaaiiuu')) gin_trgm_ops);
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
    sku            TEXT,                    -- merchant'ın kendi SKU'su, varsa
    last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- 0022 (docs/decisions/0032): bu ticari varyantın barkodu. Yalnızca GS1
    -- kontrol basamağı doğru değer; kaynak 'feed' | 'products_js' | 'sku'.
    gtin           TEXT,
    gtin_source    TEXT,
    CONSTRAINT offer_variant_uniq UNIQUE (offer_id, external_id)
);
CREATE INDEX offer_variant_offer_idx ON offer_variant (offer_id) WHERE in_stock;
CREATE INDEX offer_variant_gtin_idx  ON offer_variant (gtin) WHERE gtin IS NOT NULL;

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

-- ---------------------------------------------------------------------------
-- FİYAT GEÇMİŞİ — sadece INSERT. Rakibin geriye dönük üretemeyeceği varlık.
-- Aya göre partition. İlk günden toplanmaya başlanmalı.
-- ---------------------------------------------------------------------------

CREATE TABLE price_point (
    offer_id    BIGINT      NOT NULL REFERENCES offer(id),
    observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    price       BIGINT      NOT NULL,
    list_price  BIGINT,
    in_stock    BOOLEAN     NOT NULL,
    PRIMARY KEY (offer_id, observed_at)
) PARTITION BY RANGE (observed_at);

-- Partition'lar aylık olarak önceden oluşturulur (cron veya pg_partman).
CREATE TABLE price_point_2026_09 PARTITION OF price_point
    FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE price_point_2026_10 PARTITION OF price_point
    FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');

-- Güvenlik ağı. NORMAL DURUM: boş. Dolu ise aylık partition üretimi
-- çalışmamış demektir; kritik uyarı üretir. Runbook: docs/ops.md.
CREATE TABLE price_point_default PARTITION OF price_point DEFAULT;

CREATE INDEX price_point_offer_time_idx ON price_point (offer_id, observed_at DESC);

-- Gece toplu işiyle doldurulur. İstek yolu fiyat geçmişini taramaz, burayı okur.
-- "Şu an iyi fiyat mı?" ve sahte indirim tespiti bu tablodan cevaplanır.
CREATE TABLE product_price_stats (
    product_id       BIGINT      PRIMARY KEY REFERENCES product(id),
    min_30d          BIGINT,
    min_90d          BIGINT,
    max_90d          BIGINT,
    median_90d       BIGINT,
    current_percentile SMALLINT,             -- 0 = son 90 günün en düşüğü
    drop_count_90d   SMALLINT,               -- kaç kez düştü
    last_drop_at     TIMESTAMPTZ,
    -- sahte indirim sinyali: liste fiyatı indirimden hemen önce yükseltilmiş mi
    list_price_inflated BOOLEAN  NOT NULL DEFAULT FALSE,
    list_price_raised_at TIMESTAMPTZ,
    computed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- ANLAM KATMANI
-- ---------------------------------------------------------------------------

-- Embedding offer üzerinden üretilir (her merchant'ın kendi fotoğrafı var),
-- benzerlik product üzerinden hesaplanır.
--
-- DİKKAT: `target_id` POLİMORFİKTİR — `target_type`'a göre offer, product ya
-- da query gösterir. Bir kolon üç tabloya birden referans veremeyeceği için
-- burada FOREIGN KEY YOKTUR; yani `CASCADE` bu tabloya değmez ve Postgres
-- referans bütünlüğünü kendiliğinden sağlamaz. Silme yönü migration `0014`
-- içindeki trigger'lara, yazma yönü `pnpm db:orphans` izlemesine bağlıdır.
-- Gerekçe ve bulunan arıza: `docs/decisions/0020-polimorfik-butunluk.md`.
CREATE TABLE embedding (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    target_type   TEXT        NOT NULL CHECK (target_type IN ('offer','product','query')),
    target_id     BIGINT      NOT NULL,
    kind          TEXT        NOT NULL CHECK (kind IN ('image','text')),
    model_version TEXT        NOT NULL,          -- 'siglip-so400m-v1' gibi
    vector        vector(768) NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT embedding_uniq UNIQUE (target_type, target_id, kind, model_version)
);
CREATE INDEX embedding_ann_idx ON embedding
    USING hnsw (vector vector_cosine_ops)
    WHERE target_type = 'offer';
CREATE INDEX embedding_target_idx ON embedding (target_type, target_id);

-- Eşleştirme kuyruğu. Eşiğin üstü otomatik kabul, altı insan onayına düşer.
CREATE TABLE match_candidate (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    offer_id     BIGINT      NOT NULL REFERENCES offer(id),
    product_id   BIGINT      NOT NULL REFERENCES product(id),
    score        REAL        NOT NULL,
    method       TEXT        NOT NULL
                 CHECK (method IN ('gtin','mpn','text','image','hybrid')),
    status       TEXT        NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','auto_accepted','accepted','rejected')),
    reviewed_by  BIGINT,
    reviewed_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT match_candidate_uniq UNIQUE (offer_id, product_id)
);
CREATE INDEX match_candidate_pending_idx ON match_candidate (score DESC)
    WHERE status = 'pending';

-- Önceden hesaplanmış alternatifler. İstek yolu SADECE burayı okur.
CREATE TABLE similarity_edge (
    product_a   BIGINT NOT NULL REFERENCES product(id),
    product_b   BIGINT NOT NULL REFERENCES product(id),
    kind        TEXT   NOT NULL
                CHECK (kind IN ('same','visual','semantic','substitute')),
    score       REAL   NOT NULL,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (product_a, product_b, kind),
    CONSTRAINT similarity_no_self CHECK (product_a <> product_b)
);
CREATE INDEX similarity_lookup_idx ON similarity_edge (product_a, kind, score DESC);

-- Üretilmiş ve saklanan AI çıktıları. Bir kez üretilir, bin kez okunur.
--
-- `embedding` ile aynı polimorfik kısıt geçerlidir: `target_id` bir foreign
-- key değildir, bütünlük `0014` trigger'ları + `pnpm db:orphans` iledir.
-- Ek olarak `target_type` burada SERBEST TEXT'tir (`embedding`'in aksine
-- CHECK yok), o yüzden yetim izlemesi tanınmayan türü de sayar.
CREATE TABLE generated_content (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    target_type   TEXT        NOT NULL,
    target_id     BIGINT      NOT NULL,
    kind          TEXT        NOT NULL
                  -- review_summary MVP'de yok, yorum özelliği ertelendi
                  CHECK (kind IN ('attribute_extract','description','comparison')),
    model_version TEXT        NOT NULL,
    content       JSONB       NOT NULL,
    input_hash    TEXT        NOT NULL,   -- girdi değişmediyse yeniden üretme
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT generated_content_uniq UNIQUE (target_type, target_id, kind, model_version)
);

-- ---------------------------------------------------------------------------
-- GÖRSEL ARAMA VE LİNK ÖNEKİ — kullanıcı tetikli keşif (D4)
-- routes.md: kök catch-all ve /ara/gorsel. İkisi de "bilinmeyen ürün akışı
-- ilk günden çalışmalıdır" kuralının somutlaşmış hali.
-- ---------------------------------------------------------------------------

-- Yüklenen görselin izi. CLAUDE.md kural 1'in tek istisnası burada geçer:
-- istek yolundaki tek model çağrısı, `EmbeddingService` arkasından ve
-- `image_hash` ile cache'lenerek yapılır (architecture.md §2). KVKK
-- (docs/kvkk.md): ham dosya en fazla 30 gün obje deposunda kalır,
-- `purge_after` geçince silinir ve `object_key` NULL'a çekilir — embedding
-- ve hash kalıcı kalabilir, ham dosya kalmaz.
CREATE TABLE image_upload (
    id               BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id          BIGINT      REFERENCES app_user(id),   -- anonim olabilir
    session_id       TEXT        NOT NULL,
    image_hash       TEXT        NOT NULL,                  -- sha256, embedding cache anahtarı
    object_key       TEXT,                                  -- purge sonrası NULL
    has_face         BOOLEAN     NOT NULL DEFAULT FALSE,
    status           TEXT        NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','embedded','rejected_not_product','rejected_moderation')),
    rejection_reason TEXT,
    embedding_id     BIGINT      REFERENCES embedding(id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    purge_after      TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '30 days'
);
-- Ayni gorsel iki kez islenmiyor: embed edilmis bir hash bulunursa yeniden
-- API'ye gidilmez, api_usage.cache_hit=true yazilir.
CREATE INDEX image_upload_hash_idx    ON image_upload (image_hash) WHERE status = 'embedded';
CREATE INDEX image_upload_user_idx    ON image_upload (user_id, created_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX image_upload_session_idx ON image_upload (session_id, created_at DESC);
CREATE INDEX image_upload_purge_idx   ON image_upload (purge_after) WHERE object_key IS NOT NULL;

-- Kök catch-all'ın tekil link çözümleme durumu. `docs/decisions/0014`: tek
-- çözümleme `ingest_run` yazmaz (o toplu iş kaydıdır); bekleme ekranı bu
-- satırı poll'lar. Worker aynı `collect.link.resolver.resolve_url`'i Redis
-- kuyruğundan tetikler (services/ingest/collect/link/__main__.py).
-- `offer_id` doluyken `offer.product_id` henüz NULL olabilir — B4'ün
-- gecelik eşleştirmesi ayrı çalışır; bu satır yalnızca offer'ın yazıldığını
-- doğrular, ürün sayfasının varlığını değil.
CREATE TABLE link_resolution_request (
    id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    url_raw      TEXT        NOT NULL,
    session_id   TEXT        NOT NULL,
    user_id      BIGINT      REFERENCES app_user(id),
    status       TEXT        NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued','processing','resolved','failed')),
    offer_id     BIGINT      REFERENCES offer(id),
    error_text   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at  TIMESTAMPTZ,
    -- 0021 (docs/decisions/0031): link araması. `normalized_url` izleme
    -- parametresiz, fragment'sız kanonik adres — oturumlar arası önbellek
    -- anahtarı (aynı ürün linki TTL içinde yeniden getirilmez).
    normalized_url     TEXT,
    -- Worker'ın sayfadan okuduğu arama sinyalleri; YALNIZCA sayfada gerçekten
    -- bulunan alanlar yazılır (title, brand, category, gtin, mpn, sku,
    -- image_url, price+currency, extraction_layer, site, image_status).
    -- Fiyat yalnızca yapılandırılmış katmandan ve para birimiyle birlikte gelir.
    source             JSONB,
    -- Kullanıcıya gösterilecek durumun kararlı kodu; `error_text` ayrıntıdır.
    -- 'invalid_url','blocked_destination','robots_disallowed','access_denied',
    -- 'not_found','rate_limited','upstream_error','http_error','timeout',
    -- 'fetch_failed','too_many_redirects','unsupported_content','too_large',
    -- 'no_product','queue_unavailable','unexpected'
    error_code         TEXT,
    -- Kaynak görselin vektörü (offer'ın `image` embedding'i). NULL: görsel yok,
    -- işlenemedi ya da sağlayıcı yapılandırılmamış — arama metinle yürür.
    image_embedding_id BIGINT      REFERENCES embedding(id)
);
CREATE INDEX link_resolution_request_session_idx ON link_resolution_request (session_id, created_at DESC);
CREATE INDEX link_resolution_request_url_idx     ON link_resolution_request (normalized_url, created_at DESC)
    WHERE normalized_url IS NOT NULL;

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

CREATE TABLE creator (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         BIGINT      NOT NULL UNIQUE REFERENCES app_user(id),
    handle          TEXT        NOT NULL UNIQUE,   -- /@elif
    display_name    TEXT        NOT NULL,
    bio             TEXT,
    avatar_url      TEXT,
    tier            TEXT        NOT NULL DEFAULT 'starter'
                    CHECK (tier IN ('starter','rising','trusted','top')),
    affiliate_mode  TEXT        NOT NULL DEFAULT 'own'
                    CHECK (affiliate_mode IN ('own','platform')),
    is_verified     BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Creator'ın kendi affiliate hesapları (Model A). Komisyon doğrudan ona gider.
CREATE TABLE creator_affiliate_account (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    creator_id   BIGINT NOT NULL REFERENCES creator(id),
    merchant_id  BIGINT NOT NULL REFERENCES merchant(id),
    tracking_id  TEXT   NOT NULL,
    status       TEXT   NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','invalid','revoked')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT creator_affiliate_uniq UNIQUE (creator_id, merchant_id)
);

CREATE TABLE collection (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    creator_id  BIGINT      NOT NULL REFERENCES creator(id),
    slug        TEXT        NOT NULL,
    title       TEXT        NOT NULL,
    description TEXT,
    cover_url   TEXT,
    is_public   BOOLEAN     NOT NULL DEFAULT TRUE,
    position    INTEGER     NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT collection_slug_uniq UNIQUE (creator_id, slug)
);

CREATE TABLE collection_item (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    collection_id BIGINT  NOT NULL REFERENCES collection(id) ON DELETE CASCADE,
    product_id    BIGINT  NOT NULL REFERENCES product(id),
    preferred_offer_id BIGINT REFERENCES offer(id),
    note          TEXT,
    position      INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT collection_item_uniq UNIQUE (collection_id, product_id)
);

CREATE TABLE follow (
    user_id     BIGINT NOT NULL REFERENCES app_user(id),
    creator_id  BIGINT NOT NULL REFERENCES creator(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, creator_id)
);

CREATE TABLE saved_item (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES app_user(id),
    product_id  BIGINT NOT NULL REFERENCES product(id),
    source_creator_id BIGINT REFERENCES creator(id),   -- wishlist attribution
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT saved_item_uniq UNIQUE (user_id, product_id)
);

-- Fiyat, stok ve beden alarmları tek tabloda. Hepsi e-posta ile gider.
CREATE TABLE alert (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id       BIGINT  NOT NULL REFERENCES app_user(id),
    product_id    BIGINT  NOT NULL REFERENCES product(id),
    kind          TEXT    NOT NULL
                  CHECK (kind IN ('price_drop','any_drop','restock','size_restock')),
    target_price  BIGINT,                    -- price_drop için zorunlu
    size_norm     TEXT,                      -- size_restock için zorunlu
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    triggered_at  TIMESTAMPTZ,
    notified_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT alert_uniq UNIQUE (user_id, product_id, kind, size_norm),
    CONSTRAINT alert_price_target CHECK (kind <> 'price_drop' OR target_price IS NOT NULL),
    CONSTRAINT alert_size_target  CHECK (kind <> 'size_restock' OR size_norm IS NOT NULL)
);
CREATE INDEX alert_active_idx ON alert (product_id) WHERE is_active;

-- ---------------------------------------------------------------------------
-- ATTRIBUTION — merchant'a giden her çıkış buradan geçer
-- ---------------------------------------------------------------------------

CREATE TABLE click (
    id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),  -- click_id
    user_id       BIGINT      REFERENCES app_user(id),                 -- anonim olabilir
    session_id    TEXT        NOT NULL,
    creator_id    BIGINT      REFERENCES creator(id),
    offer_id      BIGINT      NOT NULL REFERENCES offer(id),
    product_id    BIGINT      REFERENCES product(id),
    channel       TEXT        NOT NULL
                  CHECK (channel IN ('web','mcp','extension','api','prefix_link')),
    surface       TEXT,                    -- 'search','collection','alert','compare'
    price_at_click BIGINT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    source_similarity_kind TEXT
                  CHECK (source_similarity_kind IN ('same','visual','semantic','substitute')),
    result_position SMALLINT
);
CREATE INDEX click_creator_time_idx ON click (creator_id, created_at DESC);
CREATE INDEX click_session_idx      ON click (session_id, created_at DESC);
CREATE INDEX click_offer_time_idx   ON click (offer_id, created_at DESC);

CREATE TABLE conversion (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    click_id     UUID        REFERENCES click(id),
    merchant_id  BIGINT      NOT NULL REFERENCES merchant(id),
    creator_id   BIGINT      REFERENCES creator(id),
    external_order_id TEXT,
    order_value  BIGINT      NOT NULL,
    commission   BIGINT,
    status       TEXT        NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','confirmed','cancelled','paid')),
    occurred_at  TIMESTAMPTZ NOT NULL,
    reconciled_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT conversion_external_uniq UNIQUE (merchant_id, external_order_id)
);
CREATE INDEX conversion_creator_idx ON conversion (creator_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- MALİYET ÖLÇÜMÜ — birim ekonomisi bu tablodan okunur
-- ---------------------------------------------------------------------------

CREATE TABLE api_usage (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id    TEXT,
    user_id       BIGINT REFERENCES app_user(id),
    b2b_client_id BIGINT,                  -- Faz 4
    operation     TEXT        NOT NULL,    -- 'visual_search','semantic_search','review_summary'
    model_version TEXT,
    units         INTEGER     NOT NULL DEFAULT 1,
    cost_micros   BIGINT      NOT NULL DEFAULT 0,   -- TRY milyonda bir
    cache_hit     BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX api_usage_session_idx ON api_usage (session_id, created_at DESC);
CREATE INDEX api_usage_daily_idx   ON api_usage (created_at, operation);

-- ---------------------------------------------------------------------------
-- İŞ KUYRUĞU KAYDI (Redis kuyruğunun kalıcı izi)
-- ---------------------------------------------------------------------------

CREATE TABLE ingest_run (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    merchant_id  BIGINT      NOT NULL REFERENCES merchant(id),
    started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at  TIMESTAMPTZ,
    status       TEXT        NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running','success','partial','failed')),
    offers_seen      INTEGER NOT NULL DEFAULT 0,
    offers_created   INTEGER NOT NULL DEFAULT 0,
    offers_updated   INTEGER NOT NULL DEFAULT 0,
    price_points_written INTEGER NOT NULL DEFAULT 0,
    error_text   TEXT
);
CREATE INDEX ingest_run_merchant_idx ON ingest_run (merchant_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- ARAMA — detaylar docs/search.md
-- ---------------------------------------------------------------------------

-- Ayrıştırma sonucu cache'i. Aynı sorgu iki kez modele gitmez.
CREATE TABLE query_resolution (
    query_norm      TEXT        PRIMARY KEY,
    parsed          JSONB       NOT NULL,
    candidate_categories BIGINT[],
    needs_clarification  BOOLEAN NOT NULL DEFAULT FALSE,
    parser_tier     SMALLINT    NOT NULL,      -- 2 = sözlük, 3 = model
    hit_count       INTEGER     NOT NULL DEFAULT 1,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX query_resolution_popular_idx ON query_resolution (hit_count DESC);

-- Sözlükler. Veritabanında tutulur ki yeni eşanlamlı için sürüm çıkmasın.
CREATE TABLE lexicon (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind        TEXT   NOT NULL
                CHECK (kind IN ('color','category','brand','size','material','style','synonym')),
    surface     TEXT   NOT NULL,              -- 'spor ayakkabı'
    normalized  TEXT   NOT NULL,              -- 'ayakkabi/sneaker'
    weight      REAL   NOT NULL DEFAULT 1.0,
    CONSTRAINT lexicon_uniq UNIQUE (kind, surface)
);
CREATE INDEX lexicon_surface_idx ON lexicon (surface);

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

-- ---------------------------------------------------------------------------
-- ROLLER VE YETKİLER — append-only kuralı motorda
-- Gerçeği `packages/db/migrations/0010_append_only_grants.sql` oluşturur.
-- ---------------------------------------------------------------------------
--
-- İki rol vardır:
--   arilla      — şemanın sahibi. Migration'lar, partition üretimi, tohum
--                 verisi. Uygulama bu rolü ASLA kullanmaz.
--   arilla_app  — uygulama rolü. `apps/*` ve `services/ingest` bununla bağlanır.
--                 Superuser DEĞİLDİR; superuser olsaydı aşağıdaki REVOKE'lar
--                 atlanır ve kural sessizce etkisiz kalırdı.

CREATE ROLE arilla_app NOLOGIN;   -- parola depoya girmez, betikle verilir

GRANT USAGE ON SCHEMA public TO arilla_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO arilla_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO arilla_app;

-- CLAUDE.md 4. kural ve architecture.md: bu iki tablo yalnızca INSERT alır.
-- Düzeltme gerekiyorsa yeni satır eklenir.
REVOKE UPDATE, DELETE, TRUNCATE ON price_point         FROM arilla_app;
REVOKE UPDATE, DELETE, TRUNCATE ON variant_stock_event FROM arilla_app;

-- price_point partition'larına doğrudan erişim yoktur. Partitioned tabloya
-- INSERT'te yetki ebeveyn üzerinde denetlenir; yönlendirme etkilenmez.
-- Yeni partition'lar için aynı REVOKE'u `scripts/partitions.ts` uygular.
