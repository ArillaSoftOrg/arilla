-- kind: schema
-- 0065 — katalog ve besleme modeli (karar 0111)
--
-- YALNIZCA EKLEME. Mevcut tablo, kolon, kisit ve yetkilerin hicbiri silinmez,
-- yeniden adlandirilmaz, tipi degismez. Eklenen kolonlarin hepsi NULL olabilir
-- ya da sabit varsayilanlidir (PG 11+: tablo yeniden yazilmaz). Eski kod yeni
-- semayla aynen calisir (N-1 uyumu).
--
-- Kavram -> tablo:
--   canonical product / variant ... product (mevcut, renk duzeyi) / canonical_variant (yeni)
--   source product / SKU .......... offer / offer_variant (mevcut; yeni kolonlar)
--   merchant / marketplace seller . merchant (mevcut) / seller (yeni)
--   offer / current price ......... offer.current_price, offer_variant.price_override (mevcut)
--   price observation / history ... price_point, variant_price_event, variant_stock_event (mevcut)
--   category / brand / attributes . category, brand, product.attributes (mevcut) + category_source_map (yeni)
--   product identity / matching ... product_identity, identity_observation, match_decision_log (yeni)
--   feed source / snapshot / cursor feed_source, source_snapshot (yeni)
--   ingestion job / error / retry . ingest_run (mevcut; yeni kolonlar), ingest_chunk, ingest_error (yeni)
--   arama indeksi olaylari ........ search_outbox (yeni)
--
-- Kimlikler AD ALANLIDIR: kaynak kimligi her zaman bir kapsamla birlikte
-- benzersizdir ((merchant_id, external_id), (offer_id, external_id),
-- (network, external_id)); tek basina hicbir yerde anahtar degildir.

-- ---------------------------------------------------------------------------
-- PAZARYERI SATICISI
-- ---------------------------------------------------------------------------
-- Pazaryerindeki magaza (or. AliExpress store). Merchant kanal/program, seller
-- o kanalda satan magazadir. Ad kimlik degildir; degisebilir.
CREATE TABLE seller (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    merchant_id     BIGINT      NOT NULL REFERENCES merchant(id),
    external_id     TEXT        NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 200),
    name            TEXT        CHECK (name IS NULL OR char_length(name) <= 300),
    url             TEXT        CHECK (url IS NULL OR char_length(url) <= 2048),
    is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT seller_merchant_external_uniq UNIQUE (merchant_id, external_id)
);

-- ---------------------------------------------------------------------------
-- KANONIK VARYANT
-- ---------------------------------------------------------------------------
-- product renk duzeyinde kanoniktir (karar 0005). canonical_variant, ayni
-- urunun beden/kapasite/hacim gibi TICARI varyantidir; farkli saticilarin ayni
-- varyanti (ayni beden, ayni kapasite) burada bulusur.
-- option_key: normalize, anahtara gore sirali "eksen=deger" listesi
-- ("beden=42", "kapasite=256gb;renk=siyah"). Tek varyantli urun: ''.
CREATE TABLE canonical_variant (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id      BIGINT      NOT NULL REFERENCES product(id),
    option_key      TEXT        NOT NULL CHECK (char_length(option_key) <= 500),
    options         JSONB       NOT NULL DEFAULT '{}'::jsonb
                    CHECK (jsonb_typeof(options) = 'object'),
    -- GS1 kontrol basamagi dogrulanmis, 14 haneye tamamlanmis barkod.
    gtin            TEXT        CHECK (gtin IS NULL OR gtin ~ '^[0-9]{14}$'),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT canonical_variant_option_uniq UNIQUE (product_id, option_key)
);

-- ---------------------------------------------------------------------------
-- BESLEME KAYNAGI, SURUM, IMLEC
-- ---------------------------------------------------------------------------
-- Bir affiliate aginin (ya da dogrudan magazanin) tek bir beslemesi.
-- Kesifle OTOMATIK kaydedilir ama 'discovered' durumunda kalir: merchant'a
-- baglanip yonetici tarafindan etkinlestirilmeden senkronize edilmez.
-- Kimlik bilgisi (token, imzali URL parametresi) BURADA TUTULMAZ:
-- source_url_redacted yalnizca gosterim icindir, gercek indirme adresi
-- senkronizasyon aninda ag API'sinden yeniden cozulur.
CREATE TABLE feed_source (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    network              TEXT        NOT NULL CHECK (network ~ '^[a-z0-9_]{2,40}$'),
    -- Agin kendi besleme kimligi (or. "<program_id>:<feed_adi>"); (network, external_id) benzersiz.
    external_id          TEXT        NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 300),
    merchant_id          BIGINT      REFERENCES merchant(id),
    program_external_id  TEXT        CHECK (program_external_id IS NULL OR char_length(program_external_id) <= 100),
    program_name         TEXT        CHECK (program_name IS NULL OR char_length(program_name) <= 300),
    name                 TEXT        CHECK (name IS NULL OR char_length(name) <= 300),
    format               TEXT        CHECK (format IN ('xml', 'csv', 'json', 'ndjson')),
    compression          TEXT        CHECK (compression IN ('none', 'gzip', 'zip')),
    source_url_redacted  TEXT        CHECK (source_url_redacted IS NULL OR char_length(source_url_redacted) <= 2048),
    status               TEXT        NOT NULL DEFAULT 'discovered'
                         CHECK (status IN ('discovered', 'active', 'paused', 'disabled', 'gone')),
    -- 'snapshot': her kosu tam dosya, fark hesaplanir. 'delta': kaynak artimli veri/imlec destekliyor.
    sync_mode            TEXT        NOT NULL DEFAULT 'snapshot' CHECK (sync_mode IN ('snapshot', 'delta')),
    -- Kaynagin destekledigi artimli imlec (or. son degisim zamani). Kaynak desteklemiyorsa NULL.
    sync_cursor          JSONB       CHECK (sync_cursor IS NULL OR jsonb_typeof(sync_cursor) = 'object'),
    market               CHAR(2)     CHECK (market IS NULL OR market ~ '^[A-Z]{2}$'),
    currency             CHAR(3)     CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
    -- Alan esleme ve tasima ayarlari (feed_config.mapping ile ayni bicim). Sir icermez.
    config               JSONB       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
    -- Gozlenen alan kumesinin ozeti; degisirse sema degisikligi algilanir.
    schema_fingerprint   TEXT        CHECK (schema_fingerprint IS NULL OR schema_fingerprint ~ '^[0-9a-f]{64}$'),
    schema_fields        JSONB       CHECK (schema_fields IS NULL OR jsonb_typeof(schema_fields) = 'array'),
    schema_changed_at    TIMESTAMPTZ,
    -- Kaynagin ilan ettigi son guncelleme (varsa); gereksiz indirmeyi onler.
    source_updated_at    TIMESTAMPTZ,
    discovered_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_discovery_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_success_at      TIMESTAMPTZ,
    last_error_at        TIMESTAMPTZ,
    last_error_code      TEXT        CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]{2,60}$'),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT feed_source_network_external_uniq UNIQUE (network, external_id),
    -- Etkin besleme bir merchant'a bagli olmak zorunda.
    CONSTRAINT feed_source_active_has_merchant CHECK (status <> 'active' OR merchant_id IS NOT NULL)
);
CREATE INDEX feed_source_merchant_idx ON feed_source (merchant_id) WHERE merchant_id IS NOT NULL;
CREATE INDEX feed_source_status_idx ON feed_source (status, network);

-- Indirilen dosyanin surumu. Ayni icerik (sha256) ikinci kez islenmez.
CREATE TABLE source_snapshot (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    feed_source_id     BIGINT      NOT NULL REFERENCES feed_source(id),
    kind               TEXT        NOT NULL DEFAULT 'full' CHECK (kind IN ('full', 'delta')),
    status             TEXT        NOT NULL DEFAULT 'downloading'
                       CHECK (status IN ('downloading', 'downloaded', 'processing', 'complete',
                                         'duplicate', 'rejected', 'failed')),
    sha256             TEXT        CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
    bytes              BIGINT      CHECK (bytes IS NULL OR bytes >= 0),
    record_count       INTEGER     CHECK (record_count IS NULL OR record_count >= 0),
    rejected_count     INTEGER     NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
    schema_fingerprint TEXT        CHECK (schema_fingerprint IS NULL OR schema_fingerprint ~ '^[0-9a-f]{64}$'),
    -- Yerel ya da nesne deposundaki anahtar (kimlik bilgisi yok).
    storage_key        TEXT        CHECK (storage_key IS NULL OR char_length(storage_key) <= 1024),
    -- Tamlik kapisi gecmediyse neden (or. 'too_few_records', 'truncated', 'error_rate').
    reject_reason      TEXT        CHECK (reject_reason IS NULL OR reject_reason ~ '^[a-z0-9_]{2,60}$'),
    started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at       TIMESTAMPTZ
);
-- Ayni beslemenin ayni icerigi yalnizca bir kez TAMAMLANMIS olabilir (idempotent).
CREATE UNIQUE INDEX source_snapshot_complete_sha_uniq
    ON source_snapshot (feed_source_id, sha256) WHERE status = 'complete';
CREATE INDEX source_snapshot_feed_idx ON source_snapshot (feed_source_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- MEVCUT TABLOLARA EK KOLONLAR (hepsi NULL olabilir ya da sabit varsayilanli)
-- ---------------------------------------------------------------------------
ALTER TABLE offer ADD COLUMN seller_id BIGINT REFERENCES seller(id);
ALTER TABLE offer ADD COLUMN feed_source_id BIGINT REFERENCES feed_source(id);
-- Normalize alanlarin sha256'si; ayniysa satira yazilmaz (degisiklik tespiti).
ALTER TABLE offer ADD COLUMN fingerprint TEXT
    CHECK (fingerprint IS NULL OR fingerprint ~ '^[0-9a-f]{64}$');
ALTER TABLE offer ADD COLUMN last_changed_at TIMESTAMPTZ;
ALTER TABLE offer ADD COLUMN last_snapshot_id BIGINT REFERENCES source_snapshot(id);
-- Guvenli deaktivasyon izi. Silme YOK; is_active=false olur, neden yazilir.
ALTER TABLE offer ADD COLUMN deactivated_at TIMESTAMPTZ;
ALTER TABLE offer ADD COLUMN deactivation_reason TEXT
    CHECK (deactivation_reason IS NULL
           OR deactivation_reason IN ('missing_from_snapshot', 'source_removed', 'admin', 'expired'));
CREATE INDEX offer_seller_idx ON offer (seller_id) WHERE seller_id IS NOT NULL;
CREATE INDEX offer_feed_source_idx ON offer (feed_source_id) WHERE feed_source_id IS NOT NULL;

ALTER TABLE offer_variant ADD COLUMN canonical_variant_id BIGINT REFERENCES canonical_variant(id);
-- Kaynagin varyant eksenleri (renk/beden/kapasite...), normalize: {"beden":"42","renk":"siyah"}.
ALTER TABLE offer_variant ADD COLUMN option_values JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(option_values) = 'object');
CREATE INDEX offer_variant_canonical_idx ON offer_variant (canonical_variant_id)
    WHERE canonical_variant_id IS NOT NULL;

-- ingest_run: besleme/surum baglami, sayaclar, yeniden deneme ve kontrol noktasi.
ALTER TABLE ingest_run ADD COLUMN feed_source_id BIGINT REFERENCES feed_source(id);
ALTER TABLE ingest_run ADD COLUMN snapshot_id BIGINT REFERENCES source_snapshot(id);
ALTER TABLE ingest_run ADD COLUMN offers_unchanged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingest_run ADD COLUMN offers_deactivated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingest_run ADD COLUMN records_rejected INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingest_run ADD COLUMN attempt SMALLINT NOT NULL DEFAULT 1 CHECK (attempt >= 1);
ALTER TABLE ingest_run ADD COLUMN next_retry_at TIMESTAMPTZ;
ALTER TABLE ingest_run ADD COLUMN checkpoint JSONB
    CHECK (checkpoint IS NULL OR jsonb_typeof(checkpoint) = 'object');
ALTER TABLE ingest_run ADD COLUMN updated_at TIMESTAMPTZ;
CREATE INDEX ingest_run_feed_source_idx ON ingest_run (feed_source_id, started_at DESC)
    WHERE feed_source_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- PARCA KONTROL NOKTASI VE HATA KAYITLARI
-- ---------------------------------------------------------------------------
-- Snapshot'in bagimsiz parcalari. Birlestirme ile 'merged' isareti AYNI
-- islemde yazilir; cokme sonrasi ilk birlestirilmemis parcadan devam edilir.
CREATE TABLE ingest_chunk (
    snapshot_id   BIGINT      NOT NULL REFERENCES source_snapshot(id),
    seq           INTEGER     NOT NULL CHECK (seq >= 0),
    record_start  BIGINT      NOT NULL CHECK (record_start >= 0),
    record_count  INTEGER     NOT NULL CHECK (record_count >= 0),
    sha256        TEXT        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    status        TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'merged', 'failed')),
    attempts      SMALLINT    NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error    TEXT        CHECK (last_error IS NULL OR char_length(last_error) <= 500),
    merged_at     TIMESTAMPTZ,
    PRIMARY KEY (snapshot_id, seq)
);

-- Kayit duzeyi hata (dead-letter). Kosuyu durdurmaz; kaydedilir, sayilir.
-- payload ham urun verisidir (kisisel veri degil) ve boyutu sinirlidir.
CREATE TABLE ingest_error (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    feed_source_id  BIGINT      REFERENCES feed_source(id),
    snapshot_id     BIGINT      REFERENCES source_snapshot(id),
    run_id          BIGINT      REFERENCES ingest_run(id),
    record_ref      TEXT        CHECK (record_ref IS NULL OR char_length(record_ref) <= 200),
    external_id     TEXT        CHECK (external_id IS NULL OR char_length(external_id) <= 200),
    error_code      TEXT        NOT NULL CHECK (error_code ~ '^[a-z0-9_]{2,60}$'),
    detail          TEXT        CHECK (detail IS NULL OR char_length(detail) <= 1000),
    payload         JSONB       CHECK (payload IS NULL OR pg_column_size(payload) <= 8192),
    status          TEXT        NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'retrying', 'resolved', 'ignored')),
    attempts        SMALLINT    NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_retry_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at     TIMESTAMPTZ
);
CREATE INDEX ingest_error_feed_idx ON ingest_error (feed_source_id, created_at DESC);
CREATE INDEX ingest_error_open_idx ON ingest_error (next_retry_at) WHERE status IN ('open', 'retrying');

-- ---------------------------------------------------------------------------
-- URUN KIMLIGI VE ESLESTIRME KARARLARI
-- ---------------------------------------------------------------------------
-- Tanimlayicinin hangi DUZEYI tanimladigi turune baglidir (V4.1 §5.4):
--   gtin       -> canonical_variant (her ticari varyantin kendi barkodu)
--   mpn        -> product (marka zorunlu; marka cozulmeden MPN kimlik degildir)
--   model_hint -> yalnizca aday uretimi; BENZERSIZ DEGIL, otomatik birlestirmez
-- Celiski (ayni GTIN farkli marka/kategori/varyant) -> status='conflict':
-- otomatik birlestirme durur, mevcut baglar korunur, yeniler incelemeye duser.
CREATE TABLE product_identity (
    id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind                  TEXT        NOT NULL CHECK (kind IN ('gtin', 'mpn', 'model_hint')),
    value_norm            TEXT        NOT NULL CHECK (char_length(value_norm) BETWEEN 1 AND 100),
    brand_id              BIGINT      REFERENCES brand(id),
    target_level          TEXT        NOT NULL CHECK (target_level IN ('variant', 'product')),
    canonical_variant_id  BIGINT      REFERENCES canonical_variant(id),
    product_id            BIGINT      REFERENCES product(id),
    status                TEXT        NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'conflict', 'restricted', 'retired')),
    source_count          INTEGER     NOT NULL DEFAULT 1 CHECK (source_count >= 0),
    first_seen_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT product_identity_target CHECK (
        (target_level = 'variant' AND canonical_variant_id IS NOT NULL)
        OR (target_level = 'product' AND product_id IS NOT NULL)
    ),
    CONSTRAINT product_identity_gtin_shape CHECK (
        kind <> 'gtin' OR (target_level = 'variant' AND value_norm ~ '^[0-9]{14}$')
    ),
    CONSTRAINT product_identity_mpn_brand CHECK (kind <> 'mpn' OR brand_id IS NOT NULL)
);
CREATE UNIQUE INDEX product_identity_gtin_active_uniq
    ON product_identity (value_norm) WHERE kind = 'gtin' AND status = 'active';
CREATE UNIQUE INDEX product_identity_mpn_active_uniq
    ON product_identity (brand_id, value_norm) WHERE kind = 'mpn' AND status = 'active';
CREATE INDEX product_identity_lookup_idx ON product_identity (kind, value_norm);
CREATE INDEX product_identity_product_idx ON product_identity (product_id) WHERE product_id IS NOT NULL;

-- APPEND-ONLY kanit: bir kaynak kaydinda gorulen tanimlayici. Celiski tespiti
-- ve source_count buradan turetilir.
CREATE TABLE identity_observation (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    offer_id          BIGINT      NOT NULL REFERENCES offer(id) ON DELETE CASCADE,
    offer_variant_id  BIGINT      REFERENCES offer_variant(id) ON DELETE CASCADE,
    kind              TEXT        NOT NULL CHECK (kind IN ('gtin', 'mpn', 'model_hint')),
    value_raw         TEXT        NOT NULL CHECK (char_length(value_raw) BETWEEN 1 AND 200),
    -- Gecersizse (kontrol basamagi tutmadi, kisitli onek) NULL; kimlik olarak kullanilmaz.
    value_norm        TEXT        CHECK (value_norm IS NULL OR char_length(value_norm) <= 100),
    is_valid          BOOLEAN     NOT NULL,
    snapshot_id       BIGINT      REFERENCES source_snapshot(id),
    observed_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX identity_observation_value_idx ON identity_observation (kind, value_norm)
    WHERE value_norm IS NOT NULL;
CREATE INDEX identity_observation_offer_idx ON identity_observation (offer_id);

-- APPEND-ONLY: offer <-> product baglama/ayirma kararlarinin izi. Yanlis
-- birlestirme bu kayitla geri alinir (yeni satir: 'unlink').
CREATE TABLE match_decision_log (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    offer_id             BIGINT      NOT NULL REFERENCES offer(id) ON DELETE CASCADE,
    product_id           BIGINT      REFERENCES product(id),
    previous_product_id  BIGINT      REFERENCES product(id),
    decision             TEXT        NOT NULL CHECK (decision IN ('link', 'unlink', 'reject', 'hold')),
    -- Kim: otomatik cozumleyici, yonetici, toplu duzeltme.
    actor                TEXT        NOT NULL CHECK (actor IN ('resolver', 'admin', 'backfill')),
    actor_user_id        BIGINT      REFERENCES app_user(id) ON DELETE SET NULL,
    -- Hangi kanitla: 'gtin', 'mpn', 'manual', 'score' ...
    basis                TEXT        NOT NULL CHECK (basis ~ '^[a-z0-9_]{2,40}$'),
    evidence             JSONB       NOT NULL DEFAULT '{}'::jsonb
                         CHECK (jsonb_typeof(evidence) = 'object' AND pg_column_size(evidence) <= 4096),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT match_decision_link_has_product CHECK (decision <> 'link' OR product_id IS NOT NULL)
);
CREATE INDEX match_decision_log_offer_idx ON match_decision_log (offer_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- KATEGORI ESLEME VE ARAMA INDEKSI OLAYLARI
-- ---------------------------------------------------------------------------
-- Kaynagin kategori yolu -> bizim kategorimiz. Oneri otomatik, onay yonetici.
CREATE TABLE category_source_map (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    merchant_id   BIGINT      NOT NULL REFERENCES merchant(id),
    source_path   TEXT        NOT NULL CHECK (char_length(source_path) BETWEEN 1 AND 500),
    path_norm     TEXT        NOT NULL CHECK (char_length(path_norm) BETWEEN 1 AND 500),
    category_id   BIGINT      REFERENCES category(id),
    status        TEXT        NOT NULL DEFAULT 'unmapped'
                  CHECK (status IN ('unmapped', 'suggested', 'confirmed', 'rejected')),
    offer_count   INTEGER     NOT NULL DEFAULT 0 CHECK (offer_count >= 0),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT category_source_map_uniq UNIQUE (merchant_id, path_norm),
    CONSTRAINT category_source_map_confirmed CHECK (status <> 'confirmed' OR category_id IS NOT NULL)
);

-- Arama indeksi guncelleme olaylari (outbox). Katalog yazimiyla AYNI islemde
-- eklenir; indeksleyici islenmemisleri sirayla tuketir. Bugun arama PostgreSQL
-- uzerinde (indeks kendiliginden guncel); harici arama motoru gelince tuketici eklenir.
CREATE TABLE search_outbox (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entity        TEXT        NOT NULL CHECK (entity IN ('product', 'offer')),
    entity_id     BIGINT      NOT NULL,
    op            TEXT        NOT NULL CHECK (op IN ('upsert', 'delete')),
    reason        TEXT        NOT NULL CHECK (reason ~ '^[a-z0-9_]{2,40}$'),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at  TIMESTAMPTZ
);
CREATE INDEX search_outbox_pending_idx ON search_outbox (id) WHERE processed_at IS NULL;

-- ---------------------------------------------------------------------------
-- YETKILER
-- ---------------------------------------------------------------------------
-- Yeni tablolar 0010'daki varsayilan yetkilerle arilla_app'e acilir
-- (SELECT, INSERT, UPDATE, DELETE). Kanit tablolari degistirilemez:
REVOKE UPDATE, DELETE, TRUNCATE ON identity_observation FROM arilla_app;
REVOKE UPDATE, DELETE, TRUNCATE ON match_decision_log   FROM arilla_app;
