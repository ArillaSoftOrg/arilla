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
    -- 0022 (docs/decisions/0036): bu ticari varyantın barkodu. Yalnızca GS1
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

-- Varyant FİYAT değişimi olayları (0026, docs/decisions/0037). price_point
-- teklif düzeyindedir (en ucuz varyant); çok boyutlu teklifte boyut bazlı
-- geçmiş buradan kurulur. Yalnızca değişimde + ilk görülmede yazılır.
-- APPEND-ONLY: arilla_app yalnızca SELECT + INSERT.
CREATE TABLE variant_price_event (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    variant_id  BIGINT      NOT NULL REFERENCES offer_variant(id) ON DELETE CASCADE,
    price       BIGINT      NOT NULL,          -- etkin fiyat: price_override ya da teklif fiyatı
    observed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX variant_price_event_idx ON variant_price_event (variant_id, observed_at DESC);

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
    reviewed_by  BIGINT      REFERENCES app_user(id) ON DELETE SET NULL, -- 0028 FK, 0039 SET NULL
    reviewed_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- 0028 (docs/decisions/0041): red nedeni; NULL = belirtilmedi.
    -- 'superseded' = ayni teklifin baska adayi onaylandi.
    review_reason TEXT
                 CHECK (review_reason IN ('not_same_product','different_color','different_size',
                                          'bad_data','other','superseded')),
    -- 0028: resolver'in skor aciklamasi (yontem, metin benzerligi, inceleme
    -- nedeni, otomatik kabul uygunlugu). Eski satirlarda NULL.
    explain      JSONB,
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
    -- 0021 (docs/decisions/0035): link araması. `normalized_url` izleme
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
-- 0029: /yonetim/arama/link en yeniden eskiye okur (created_at ile baslayan tek indeks).
CREATE INDEX link_resolution_request_created_idx ON link_resolution_request (created_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- KULLANICI VE CREATOR
-- ---------------------------------------------------------------------------

CREATE TABLE app_user (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id     UUID        NOT NULL DEFAULT uuid_generate_v4() UNIQUE,
    email         TEXT        UNIQUE,               -- giriş e-posta bağlantısıyla; telefon/Apple girişinde NULL olabilir (0025)
    email_verified_at TIMESTAMPTZ,
    display_name  TEXT,
    avatar_url    TEXT,
    role          TEXT        NOT NULL DEFAULT 'user'
                  CHECK (role IN ('user','creator','moderator','admin')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at  TIMESTAMPTZ,
    -- 0034 (0047): davet kodu, ilk istendiginde uretilir.
    referral_code TEXT CHECK (referral_code IS NULL OR referral_code ~ '^[A-HJ-NP-Z2-9]{8}$')
);
CREATE INDEX app_user_role_idx ON app_user (role) WHERE role <> 'user';
CREATE UNIQUE INDEX app_user_referral_code_unique ON app_user (referral_code) WHERE referral_code IS NOT NULL;

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
-- 0030: temizlik isi tuketilmis satirlari da siler; kismi indeks onlari kapsamaz.
CREATE INDEX auth_token_expires_idx ON auth_token (expires_at);

CREATE TABLE session (
    id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id       BIGINT      NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    token_hash    TEXT        NOT NULL UNIQUE,
    user_agent    TEXT,
    ip            INET,
    expires_at    TIMESTAMPTZ NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- 0036 (docs/decisions/0049): kaba istek baglami; yalnizca yeni oturumlarda.
    device_class   TEXT CHECK (device_class IS NULL OR device_class IN ('mobile','tablet','desktop','other')),
    browser_family TEXT CHECK (browser_family IS NULL OR browser_family IN
                               ('chrome','safari','firefox','edge','samsung','opera','other')),
    country_code   TEXT CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$')
);
CREATE INDEX session_user_idx ON session (user_id);
CREATE INDEX session_expiry_idx ON session (expires_at);

CREATE TABLE user_identity (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id          BIGINT      NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    provider         TEXT        NOT NULL CHECK (provider IN ('google', 'apple', 'phone')),  -- 0025: apple=sub, phone=E.164
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

-- Telefonla giriş kodu (0025). Kod düz metin saklanmaz: HMAC(SESSION_SECRET,
-- telefon + kod). Tek kullanımlık, süreli, yanlış deneme sayılı.
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
CREATE INDEX phone_login_code_expires_idx ON phone_login_code (expires_at);  -- 0030: temizlik isi

-- Erken erişim listesi (0031). Kullanıcı başına tek satır (PK = user_id):
-- her başarılı girişte idempotent oluşur (ON CONFLICT DO NOTHING). Ürün
-- kapısı bu tabloya değil `PRODUCT_ACCESS` bayrağına ve role bakar; satır
-- yalnızca "listeye katıldı" kaydıdır. Durum şimdilik yalnızca 'pending';
-- onay akışı gerekirse CHECK geriye uyumlu genişletilir.
CREATE TABLE early_access (
    user_id     BIGINT      PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
    status      TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX early_access_created_idx ON early_access (created_at DESC);

-- Kullanıcı geri bildirimi (0032, karar 0045). `/geri-bildirim` formu;
-- girişli kullanıcı da anonim ziyaretçi de yazar, yalnızca sunucu üzerinden.
-- Uygulama `status` olarak yalnızca 'new' yazar; diğer değerler ileride
-- yönetim paneli içindir. Hesap silinince satır da silinir.
CREATE TABLE feedback (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT      REFERENCES app_user(id) ON DELETE CASCADE,
    email       TEXT        CHECK (email IS NULL OR char_length(email) BETWEEN 3 AND 254),
    category    TEXT        NOT NULL CHECK (category IN
                    ('suggestion','bug','feature_request','ux','product_store','other')),
    title       TEXT        NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
    message     TEXT        NOT NULL CHECK (char_length(btrim(message)) BETWEEN 1 AND 10000),
    priority    TEXT        CHECK (priority IN ('low','medium','high')),
    status      TEXT        NOT NULL DEFAULT 'new' CHECK (status IN
                    ('new','reviewing','planned','resolved','rejected')),
    source      TEXT        NOT NULL CHECK (source IN ('public','early_access')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT feedback_source_matches_user CHECK (
        (user_id IS NULL AND source = 'public') OR (user_id IS NOT NULL AND source = 'early_access')
    )
);
CREATE INDEX feedback_created_idx ON feedback (created_at DESC);
CREATE INDEX feedback_user_idx ON feedback (user_id) WHERE user_id IS NOT NULL;

-- 0043 (karar 0058): form / anket merkezi. Geri bildirimden ayrıdır.
CREATE TABLE form (
    id                        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    slug                      TEXT NOT NULL UNIQUE CHECK (char_length(slug) BETWEEN 3 AND 80 AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    title                     TEXT NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
    description               TEXT CHECK (description IS NULL OR char_length(description) <= 2000),
    status                    TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','closed')),
    audience                  TEXT NOT NULL DEFAULT 'public' CHECK (audience IN ('public','authenticated','early_access')),
    kind                      TEXT NOT NULL DEFAULT 'survey' CHECK (kind IN ('survey','onboarding')),
    allow_skip                BOOLEAN NOT NULL DEFAULT false,
    allow_multiple_responses  BOOLEAN NOT NULL DEFAULT false,
    starts_at                 TIMESTAMPTZ,
    ends_at                   TIMESTAMPTZ,
    created_by                BIGINT REFERENCES app_user(id) ON DELETE SET NULL,
    updated_by                BIGINT REFERENCES app_user(id) ON DELETE SET NULL,
    published_at              TIMESTAMPTZ,
    closed_at                 TIMESTAMPTZ,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT form_window_order CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at),
    CONSTRAINT form_onboarding_needs_user CHECK (kind <> 'onboarding' OR audience <> 'public')
);
-- Aynı anda en fazla bir yayında onboarding formu.
CREATE UNIQUE INDEX form_one_published_onboarding ON form (kind) WHERE kind = 'onboarding' AND status = 'published';

CREATE TABLE form_question (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    form_id      BIGINT NOT NULL REFERENCES form(id) ON DELETE CASCADE,
    label        TEXT NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 300),
    description  TEXT CHECK (description IS NULL OR char_length(description) <= 1000),
    type         TEXT NOT NULL CHECK (type IN ('single_choice','multiple_choice','short_text','long_text')),
    required     BOOLEAN NOT NULL DEFAULT false,
    sort_order   INTEGER NOT NULL CHECK (sort_order >= 0),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (form_id, sort_order)
);

CREATE TABLE form_question_option (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    question_id  BIGINT NOT NULL REFERENCES form_question(id) ON DELETE CASCADE,
    label        TEXT NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 200),
    sort_order   INTEGER NOT NULL CHECK (sort_order >= 0),
    UNIQUE (question_id, sort_order)
);

CREATE TABLE form_response (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    form_id          BIGINT NOT NULL REFERENCES form(id) ON DELETE CASCADE,
    user_id          BIGINT REFERENCES app_user(id) ON DELETE CASCADE,
    single_response  BOOLEAN NOT NULL,   -- yanıt anındaki NOT allow_multiple_responses
    source           TEXT CHECK (source IS NULL OR source IN ('link','onboarding','account')),
    submitted_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Tek yanıtlı formda girişli kullanıcı en fazla bir yanıt verir (motor zorlar).
CREATE UNIQUE INDEX form_response_single_user ON form_response (form_id, user_id) WHERE single_response AND user_id IS NOT NULL;

CREATE TABLE form_answer (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    response_id  BIGINT NOT NULL REFERENCES form_response(id) ON DELETE CASCADE,
    question_id  BIGINT NOT NULL REFERENCES form_question(id) ON DELETE CASCADE,
    option_id    BIGINT REFERENCES form_question_option(id) ON DELETE CASCADE,
    text_value   TEXT CHECK (text_value IS NULL OR char_length(text_value) BETWEEN 1 AND 5000),
    CONSTRAINT form_answer_one_value CHECK ((option_id IS NULL) <> (text_value IS NULL))
);

-- "Şimdilik geç": tamamlandı SAYILMAZ, yalnızca hatırlatma kaydı.
CREATE TABLE form_skip (
    form_id     BIGINT NOT NULL REFERENCES form(id) ON DELETE CASCADE,
    user_id     BIGINT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    skipped_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (form_id, user_id)
);

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
-- ARAMA HAKKI — 0034 (docs/decisions/0047)
-- Fotograf ve link aramasi buradan harcar; metin aramasi dokunmaz.
-- `api_usage` saglayici maliyetinin defteridir, bu tablolar hak defteridir.
-- `bonus_ledger` APPEND-ONLY: arilla_app yalnizca SELECT + INSERT.
-- ---------------------------------------------------------------------------

CREATE TABLE ai_quota_day (
    user_id      BIGINT      NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    day          DATE        NOT NULL,
    -- Satir acildigi andaki limit; ortam degiskeni gun icinde degisirse o
    -- gunun hakki geriye donuk degismez.
    daily_limit  INTEGER     NOT NULL CHECK (daily_limit >= 0),
    used         INTEGER     NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, day),
    CONSTRAINT ai_quota_day_used_within_limit CHECK (used >= 0 AND used <= daily_limit)
);

CREATE TABLE bonus_account (
    user_id     BIGINT      PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
    balance     INTEGER     NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT bonus_account_balance_non_negative CHECK (balance >= 0)
);

-- Pahali aramanin hak kaydi. `id` sunucuda uretilen arama kimligidir.
-- Durum makinesi: reserved -> settled | refunded; geri donus yok (uygulama
-- kosullu UPDATE ... WHERE state = 'reserved' kullanir).
CREATE TABLE ai_search_charge (
    id               UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id          BIGINT      NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    operation        TEXT        NOT NULL CHECK (operation IN ('visual_search','link_search')),
    -- Istemcinin form basina urettigi opak anahtar; yalnizca kullanici
    -- icinde tekillestirme icindir, hicbir deger tasimaz.
    request_key      TEXT        NOT NULL CHECK (char_length(request_key) BETWEEN 8 AND 100),
    cost             INTEGER     NOT NULL CHECK (cost > 0),
    day              DATE        NOT NULL,
    from_daily       INTEGER     NOT NULL CHECK (from_daily >= 0),
    from_bonus       INTEGER     NOT NULL CHECK (from_bonus >= 0),
    state            TEXT        NOT NULL DEFAULT 'reserved'
                     CHECK (state IN ('reserved','settled','refunded')),
    image_upload_id  BIGINT      REFERENCES image_upload(id) ON DELETE SET NULL,
    link_request_id  UUID        REFERENCES link_resolution_request(id) ON DELETE SET NULL,
    -- Kararli kod: 'provider_error','provider_unavailable','internal_error',
    -- 'link_failed','link_stale','queue_unavailable'
    refund_reason    TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    finalized_at     TIMESTAMPTZ,
    CONSTRAINT ai_search_charge_split CHECK (from_daily + from_bonus = cost),
    CONSTRAINT ai_search_charge_finalized CHECK ((state = 'reserved') = (finalized_at IS NULL)),
    CONSTRAINT ai_search_charge_refund_reason CHECK ((state = 'refunded') = (refund_reason IS NOT NULL)),
    CONSTRAINT ai_search_charge_ref_kind CHECK (
        (operation = 'visual_search' AND link_request_id IS NULL) OR
        (operation = 'link_search' AND image_upload_id IS NULL)
    ),
    CONSTRAINT ai_search_charge_request_key_unique UNIQUE (user_id, request_key)
);
-- Kullanici basina ayni anda tek pahali arama.
CREATE UNIQUE INDEX ai_search_charge_one_active
    ON ai_search_charge (user_id) WHERE state = 'reserved';
CREATE INDEX ai_search_charge_user_idx
    ON ai_search_charge (user_id, created_at DESC);
-- Gunluk supurme: askida kalan ayirmalar.
CREATE INDEX ai_search_charge_reserved_idx
    ON ai_search_charge (created_at) WHERE state = 'reserved';
-- Link durum sorgusundan harcamaya.
CREATE INDEX ai_search_charge_link_request_idx
    ON ai_search_charge (link_request_id) WHERE link_request_id IS NOT NULL;

-- Davet. `inviter_user_id` davet edenin hesabi silinince NULL olur;
-- davet edilenin hesabi silinince satir gider.
CREATE TABLE referral (
    id                    BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    inviter_user_id       BIGINT      REFERENCES app_user(id) ON DELETE SET NULL,
    invitee_user_id       BIGINT      NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    status                TEXT        NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','qualified')),
    qualifying_charge_id  UUID        REFERENCES ai_search_charge(id) ON DELETE SET NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    qualified_at          TIMESTAMPTZ,
    CONSTRAINT referral_invitee_unique UNIQUE (invitee_user_id),
    CONSTRAINT referral_not_self CHECK (inviter_user_id IS DISTINCT FROM invitee_user_id),
    CONSTRAINT referral_qualified_at CHECK ((status = 'qualified') = (qualified_at IS NOT NULL))
);
CREATE INDEX referral_inviter_idx
    ON referral (inviter_user_id, created_at DESC) WHERE inviter_user_id IS NOT NULL;

-- Bonus defteri (append-only). Her bakiye degisikligi tam bir satir;
-- `idempotency_key` ayni odulun/iadenin ikinci kez yazilmasini engeller:
-- 'charge:<id>', 'refund:<id>', 'referral:<id>:inviter',
-- 'referral:<id>:invitee', 'feedback_first:<user_id>'.
CREATE TABLE bonus_ledger (
    id               BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id          BIGINT      NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    delta            INTEGER     NOT NULL CHECK (delta <> 0),
    -- Tavan kirpmasindan onceki tutar (odullerde); iade/harcamada delta ile ayni.
    requested        INTEGER     NOT NULL CHECK (requested <> 0),
    balance_after    INTEGER     NOT NULL CHECK (balance_after >= 0),
    reason           TEXT        NOT NULL CHECK (reason IN (
                         'search_charge','search_refund','referral_inviter',
                         'referral_invitee','feedback_first','admin_grant','campaign')),
    idempotency_key  TEXT        NOT NULL,
    charge_id        UUID        REFERENCES ai_search_charge(id) ON DELETE CASCADE,
    referral_id      BIGINT      REFERENCES referral(id) ON DELETE SET NULL,
    actor_user_id    BIGINT      REFERENCES app_user(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT bonus_ledger_idempotency_key_unique UNIQUE (idempotency_key),
    CONSTRAINT bonus_ledger_sign CHECK ((reason = 'search_charge') = (delta < 0))
);
CREATE INDEX bonus_ledger_user_idx ON bonus_ledger (user_id, created_at DESC, id DESC);


-- ---------------------------------------------------------------------------
-- PAZARLAMA E-POSTASI KAMPANYALARI — 0035 (docs/decisions/0048)
-- ---------------------------------------------------------------------------
-- Rıza tek kaynaktır: `user_consent` (`marketing_email`, en son satır). Alıcı
-- adresi saklanmaz; gönderim anında `app_user.email`'den okunur ve rıza
-- yeniden denetlenir. UNIQUE (campaign_id, user_id) çift gönderimi motorda
-- engeller.

CREATE TABLE marketing_campaign (
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
CREATE INDEX marketing_campaign_created_idx
    ON marketing_campaign (created_at DESC, id DESC);
-- Toplu islemcinin taradigi tek kume.
CREATE INDEX marketing_campaign_sending_idx
    ON marketing_campaign (id) WHERE status = 'sending';

-- Alici basina teslim. Durum makinesi:
--   pending -> sending -> sent
--                      -> pending (gecici hata, attempt_count < sinir)
--                      -> failed  (kalici hata, deneme siniri, belirsiz sonuc)
--   pending -> skipped (gonderim aninda artik uygun degil, iptal)
-- `sending` satiri yalnizca bir islemcide; askida kalan `sending` YENIDEN
-- DENENMEZ (saglayici almis olabilir) ve `unknown_outcome` ile kapanir.
CREATE TABLE marketing_campaign_delivery (
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
CREATE INDEX marketing_campaign_delivery_pending_idx
    ON marketing_campaign_delivery (campaign_id, id) WHERE state = 'pending';
-- Askida kalan gonderim taramasi.
CREATE INDEX marketing_campaign_delivery_sending_idx
    ON marketing_campaign_delivery (claimed_at) WHERE state = 'sending';
-- Durum sayimlari (yonetim ekrani).
CREATE INDEX marketing_campaign_delivery_state_idx
    ON marketing_campaign_delivery (campaign_id, state);
-- Hesap disa aktarimi ve kullanici bazli sorgu.
CREATE INDEX marketing_campaign_delivery_user_idx
    ON marketing_campaign_delivery (user_id) WHERE user_id IS NOT NULL;

-- Uygunluk sorgusu `marketing_email` rizasinin en son satirini kullanici
-- basina okur; esit `granted_at`'te `id` karar verir.
CREATE INDEX user_consent_marketing_latest_idx
    ON user_consent (user_id, granted_at DESC, id DESC) WHERE kind = 'marketing_email';

-- Ayni adresi (buyuk/kucuk harf farkiyla) tasiyan iki hesap ayni kampanyayi
-- iki kez almaz: uygunluk sorgusu en kucuk `id`'yi secer ve bunu bu
-- indeksle arar. `app_user.email` UNIQUE kisiti harfe duyarlidir.
CREATE INDEX app_user_email_lower_idx
    ON app_user (lower(email)) WHERE email IS NOT NULL;


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

-- 0041 (docs/decisions/0052): is kosusu gecmisi (collect, resolve, enrich,
-- similarity, cron uclari). Isletim sinyali; denetim/analitik/log DEGIL.
-- 180 gun saklanir. Yeniden deneme / simdi calistir yok.
CREATE TABLE job_run (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job           TEXT        NOT NULL CHECK (job ~ '^[a-z][a-z0-9_]{1,39}$'),
    trigger       TEXT        NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual','cron','worker')),
    status        TEXT        NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running','success','partial','failed')),
    started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at   TIMESTAMPTZ,
    detail        JSONB       NOT NULL DEFAULT '{}'::jsonb
                  CHECK (jsonb_typeof(detail) = 'object' AND pg_column_size(detail) <= 4096),
    error_summary TEXT        CHECK (error_summary IS NULL OR char_length(error_summary) <= 500),
    CONSTRAINT job_run_finished CHECK ((status = 'running') = (finished_at IS NULL))
);
CREATE INDEX job_run_job_idx ON job_run (job, started_at DESC);

-- ---------------------------------------------------------------------------
-- YÖNETİM DENETİM KAYDI (0027, docs/decisions/0039)
-- /yonetim mutasyonları mutasyonla AYNI işlemde buraya yazılır. Yalnızca
-- güvenlik/denetim olayları: işletim (ingest_run), hata ve analitik değil.
-- Parola, token, çerez, IP, user agent YAZILMAZ; before/after yalnızca
-- kodda izin listesine alınmış hassas olmayan alanlardır.
-- APPEND-ONLY: arilla_app yalnızca SELECT + INSERT.
-- ---------------------------------------------------------------------------

CREATE TABLE admin_audit_event (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_user_id BIGINT      REFERENCES app_user(id) ON DELETE SET NULL, -- 0039: silinen aktor NULL, satir kalir
    actor_role    TEXT        NOT NULL,          -- işlem anındaki rol
    action        TEXT        NOT NULL,          -- 'matching.approve', 'lexicon.update'
    target_type   TEXT        NOT NULL,          -- 'match_candidate', 'lexicon'
    target_id     TEXT        NOT NULL,
    before        JSONB,
    after         JSONB,
    reason        TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_event_time_idx   ON admin_audit_event (created_at DESC);
CREATE INDEX admin_audit_event_target_idx ON admin_audit_event (target_type, target_id, created_at DESC);
CREATE INDEX admin_audit_event_actor_idx  ON admin_audit_event (actor_user_id, created_at DESC);

-- 0039: rol degisikligi motorda denetlenir (docs/decisions/0050). Her
-- `app_user.role` degisikligi (ve 'user' disi rolle acilan hesap) ayni
-- islemde `users.role_change` satiri yazar; aktor istege bagli
-- `arilla.audit_actor_*` oturum ayarlarindan, baglanan rol `after.dbRole`.
CREATE TRIGGER app_user_role_change_audit
    AFTER INSERT OR UPDATE OF role ON app_user
    FOR EACH ROW EXECUTE FUNCTION audit_app_user_role_change();

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

-- 0040 (docs/decisions/0052): arama kalitesi gunluk ozeti. OLAY tablosu degil;
-- (gun, normalize sorgu) basina tek satir, kimlik YOK, 90 gun saklanir.
-- E-posta/telefon/adres/uzun rakam iceren sorgular hic yazilmaz (core).
CREATE TABLE search_query_day (
    day                DATE        NOT NULL,
    query_norm         TEXT        NOT NULL CHECK (char_length(query_norm) BETWEEN 1 AND 200),
    searches           INTEGER     NOT NULL DEFAULT 0 CHECK (searches >= 0),
    zero_results       INTEGER     NOT NULL DEFAULT 0 CHECK (zero_results >= 0),
    fallbacks          INTEGER     NOT NULL DEFAULT 0 CHECK (fallbacks >= 0),
    clarifications     INTEGER     NOT NULL DEFAULT 0 CHECK (clarifications >= 0),
    last_result_count  INTEGER     CHECK (last_result_count IS NULL OR last_result_count >= 0),
    parser_tier        SMALLINT    CHECK (parser_tier IS NULL OR parser_tier BETWEEN 1 AND 3),
    unrecognized_terms TEXT[]      NOT NULL DEFAULT '{}' CHECK (cardinality(unrecognized_terms) <= 8),
    last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (day, query_norm)
);

-- 0044 (docs/decisions/0059): cevrimdisi model sorgu yorumu onbellegi. Toplu is
-- yazar, istek yolu yalnizca okur. Kimlik (sorgu, taksonomi ozeti, model);
-- kullanici/oturum/IP YOK, ham model yaniti YOK. Saglayici hatasi satir uretmez.
CREATE TABLE query_interpretation (
    id              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    query_norm      TEXT        NOT NULL CHECK (char_length(query_norm) BETWEEN 1 AND 200),
    taxonomy_hash   TEXT        NOT NULL CHECK (taxonomy_hash ~ '^[0-9a-f]{64}$'),
    model_version   TEXT        NOT NULL CHECK (char_length(model_version) BETWEEN 1 AND 100),
    status          TEXT        NOT NULL CHECK (status IN ('accepted', 'empty', 'invalid')),
    interpretation  JSONB,                     -- dogrulanmis yorum, yalnizca accepted
    rejected        JSONB       NOT NULL DEFAULT '[]'::jsonb  -- [{path, reason}] sabit kodlar
                    CHECK (jsonb_typeof(rejected) = 'array' AND pg_column_size(rejected) <= 2048),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT query_interpretation_identity UNIQUE (query_norm, taxonomy_hash, model_version),
    CONSTRAINT query_interpretation_accepted_value CHECK ((status = 'accepted') = (interpretation IS NOT NULL)),
    CONSTRAINT query_interpretation_value_shape CHECK (interpretation IS NULL OR jsonb_typeof(interpretation) = 'object')
);

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

-- KVKK rıza kayıtları. Neye, ne zaman rıza verildi. Geçmiş tablosu: kod
-- yalnızca INSERT yapar; güncel durum tür başına en son satır
-- (granted_at DESC, id DESC). 0037: çerez kategorileri ve aydınlatma kaydı
-- (`privacy_notice` RIZA DEĞİLDİR; gösterilen gizlilik metninin sürümü).
CREATE TABLE user_consent (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT      NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    kind        TEXT        NOT NULL
                CONSTRAINT user_consent_kind_check CHECK (kind IN (
                    'browsing_history','marketing_email','personalization','public_discovery',
                    'cookie_functional','cookie_analytics','cookie_marketing',
                    'privacy_notice')),
    granted     BOOLEAN     NOT NULL,
    granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    ip          INET,        -- yalnızca hesap izinleri; 1 yıl sonra NULL (0049)
    -- 0037 (docs/decisions/0049): kaynak ve metin sürümü. 0037 öncesi
    -- satırlarda NULL ("sürümsüz kayıt"); bu satırlar geçerlidir.
    source       TEXT        CHECK (source IS NULL OR source IN (
                     'account_settings','cookie_banner','cookie_sync','sign_in','unsubscribe_link')),
    text_version TEXT        CHECK (text_version IS NULL OR char_length(text_version) BETWEEN 1 AND 64)
);
CREATE INDEX user_consent_idx ON user_consent (user_id, kind, granted_at DESC);
CREATE INDEX user_consent_latest_idx ON user_consent (user_id, kind, granted_at DESC, id DESC); -- 0037

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
-- KULLANICI AKTİVİTESİ — 0036 (docs/decisions/0049)
-- ---------------------------------------------------------------------------
-- Üç sınıf karıştırılmaz: auth_event (güvenlik, rıza gerekmez),
-- user_activity_event (davranışsal analitik, YALNIZCA analitik rızasıyla,
-- tek core kapısından), user_activity_summary (liste ekranı COUNT yapmasın
-- diye kullanıcı başına tek satır). IP, ham user agent, token, istek
-- başlığı/gövdesi ve serbest JSON YOK. Geçmiş uydurulmaz: backfill yok,
-- NULL sayaç = bilinmiyor.

CREATE TABLE auth_event (
    id              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         BIGINT      NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    kind            TEXT        NOT NULL
                    CHECK (kind IN ('sign_up','sign_in','sign_out','session_revoked')),
    provider        TEXT        CHECK (provider IS NULL OR provider IN ('email','google','apple','phone')),
    session_id      UUID,       -- FK yok: oturum satırı çıkışta/sürede silinir
    device_class    TEXT        CHECK (device_class IS NULL OR device_class IN ('mobile','tablet','desktop','other')),
    browser_family  TEXT        CHECK (browser_family IS NULL OR browser_family IN
                                       ('chrome','safari','firefox','edge','samsung','opera','other')),
    country_code    TEXT        CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$'),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT auth_event_provider_required
        CHECK (kind NOT IN ('sign_up','sign_in') OR provider IS NOT NULL)
);
CREATE INDEX auth_event_user_idx ON auth_event (user_id, created_at DESC, id DESC);
CREATE INDEX auth_event_created_idx ON auth_event (created_at);
CREATE UNIQUE INDEX auth_event_one_sign_up ON auth_event (user_id) WHERE kind = 'sign_up';

CREATE TABLE user_activity_event (
    id            BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id       BIGINT      NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    kind          TEXT        NOT NULL
                  CHECK (kind IN ('search_submitted','product_viewed','merchant_exit')),
    channel       TEXT        NOT NULL DEFAULT 'web' CHECK (channel IN ('web','mcp','extension','api')),
    product_id    BIGINT      REFERENCES product(id) ON DELETE CASCADE,
    offer_id      BIGINT      REFERENCES offer(id) ON DELETE CASCADE,
    click_id      UUID        REFERENCES click(id) ON DELETE CASCADE,  -- referans; tıklama kopyalanmaz
    search_mode   TEXT        CHECK (search_mode IS NULL OR search_mode IN ('text')),
    query_norm    TEXT        CHECK (query_norm IS NULL OR char_length(query_norm) BETWEEN 1 AND 200),
    result_count  INTEGER     CHECK (result_count IS NULL OR result_count >= 0),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT user_activity_event_shape CHECK (
        (kind = 'search_submitted' AND search_mode IS NOT NULL
            AND product_id IS NULL AND offer_id IS NULL AND click_id IS NULL)
        OR (kind = 'product_viewed' AND product_id IS NOT NULL
            AND offer_id IS NULL AND click_id IS NULL
            AND search_mode IS NULL AND query_norm IS NULL AND result_count IS NULL)
        OR (kind = 'merchant_exit' AND offer_id IS NOT NULL AND click_id IS NOT NULL
            AND search_mode IS NULL AND query_norm IS NULL AND result_count IS NULL)
    )
);
CREATE INDEX user_activity_event_user_idx ON user_activity_event (user_id, created_at DESC, id DESC);
CREATE INDEX user_activity_event_user_kind_idx ON user_activity_event (user_id, kind, created_at DESC);
CREATE INDEX user_activity_event_created_idx ON user_activity_event (created_at);

CREATE TABLE user_activity_summary (
    user_id                   BIGINT      PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
    first_sign_in_at          TIMESTAMPTZ,      -- = app_user.created_at
    last_sign_in_at           TIMESTAMPTZ,
    last_active_at            TIMESTAMPTZ,      -- 15 dakikalık eşikle
    sign_in_count             INTEGER     CHECK (sign_in_count IS NULL OR sign_in_count >= 0),
    service_counters_since    TIMESTAMPTZ,
    last_device_class         TEXT,             -- CHECK'ler migration'da
    last_browser_family       TEXT,
    last_country_code         TEXT,
    search_count              INTEGER,          -- analitik: rızayla artar, geri almada NULL
    last_search_at            TIMESTAMPTZ,
    product_view_count        INTEGER,
    merchant_exit_count       INTEGER,
    analytics_counters_since  TIMESTAMPTZ,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT user_activity_summary_service_counters
        CHECK ((sign_in_count IS NULL) = (service_counters_since IS NULL)),
    CONSTRAINT user_activity_summary_analytics_counters CHECK (
        (analytics_counters_since IS NULL AND search_count IS NULL AND product_view_count IS NULL
            AND merchant_exit_count IS NULL AND last_search_at IS NULL)
        OR (analytics_counters_since IS NOT NULL AND search_count IS NOT NULL
            AND product_view_count IS NOT NULL AND merchant_exit_count IS NOT NULL)
    )
);
CREATE INDEX user_activity_summary_last_active_idx
    ON user_activity_summary (last_active_at DESC, user_id DESC) WHERE last_active_at IS NOT NULL;

CREATE INDEX app_user_created_idx ON app_user (created_at DESC, id DESC);   -- 0036

-- 0038: yönetim kullanıcı araması (katlanmış ad/e-posta içinde LIKE). İfade
-- `foldedTextExpr` ile birebir aynı olmalı (0019 ile aynı katlama).
CREATE INDEX app_user_display_name_fold_trgm ON app_user
    USING gin (lower(translate(display_name, 'ıİIŞşÇçĞğÖöÜüÂâÎîÛû', 'iiissccggoouuaaiiuu')) gin_trgm_ops);
CREATE INDEX app_user_email_fold_trgm ON app_user
    USING gin (lower(translate(email, 'ıİIŞşÇçĞğÖöÜüÂâÎîÛû', 'iiissccggoouuaaiiuu')) gin_trgm_ops);
CREATE INDEX user_identity_email_fold_trgm ON user_identity
    USING gin (lower(translate(email, 'ıİIŞşÇçĞğÖöÜüÂâÎîÛû', 'iiissccggoouuaaiiuu')) gin_trgm_ops);
CREATE INDEX user_identity_display_name_fold_trgm ON user_identity
    USING gin (lower(translate(display_name, 'ıİIŞşÇçĞğÖöÜüÂâÎîÛû', 'iiissccggoouuaaiiuu')) gin_trgm_ops);

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

-- CLAUDE.md 4. kural ve architecture.md: bu tablolar yalnızca INSERT alır.
-- Düzeltme gerekiyorsa yeni satır eklenir.
REVOKE UPDATE, DELETE, TRUNCATE ON price_point         FROM arilla_app;
REVOKE UPDATE, DELETE, TRUNCATE ON variant_stock_event FROM arilla_app;
REVOKE UPDATE, DELETE, TRUNCATE ON variant_price_event FROM arilla_app;   -- 0026
REVOKE UPDATE, DELETE, TRUNCATE ON admin_audit_event   FROM arilla_app;   -- 0027
REVOKE UPDATE, DELETE, TRUNCATE ON bonus_ledger        FROM arilla_app;   -- 0034
-- 0035: kampanya geçmişi silinmez (güncellenebilir, silinemez).
REVOKE DELETE, TRUNCATE ON marketing_campaign          FROM arilla_app;   -- 0035
REVOKE DELETE, TRUNCATE ON marketing_campaign_delivery FROM arilla_app;   -- 0035
-- 0036: değiştirilemez ama saklama süresi ve rıza geri alma için silinebilir.
REVOKE UPDATE, TRUNCATE ON auth_event          FROM arilla_app;           -- 0036
REVOKE UPDATE, TRUNCATE ON user_activity_event FROM arilla_app;           -- 0036
GRANT  UPDATE (query_norm) ON user_activity_event TO arilla_app;          -- 0036: 90 günde NULL

-- 0042 (karar 0057): Supabase'in `anon` / `authenticated` rolleri (yalnızca
-- Supabase'de vardır) `public` şemada hiçbir tablo, sequence ve kendi
-- fonksiyonumuzda yetki taşımaz; migration rolünün varsayılan yetkileri de
-- bu rollere vermez. Data API (PostgREST / pg_graphql) bu yüzden erişemez.
--   REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
--   REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;

-- price_point partition'larına doğrudan erişim yoktur. Partitioned tabloya
-- INSERT'te yetki ebeveyn üzerinde denetlenir; yönlendirme etkilenmez.
-- Yeni partition'lar için aynı REVOKE'u `scripts/partitions.ts` uygular.
