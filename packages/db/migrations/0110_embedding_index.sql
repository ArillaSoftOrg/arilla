-- kind: schema
-- 0110 — embedding indeks yasam dongusu ve boyuta gore ayri depolama (karar 0181).
--
-- `embedding_index`: bir hedefin (simdilik yalniz `product_text`) hangi model/tablo ciftiyle
-- aranacagini tutar. Model kimligi, boyut ve aile Python kayit defterindedir
-- (`services/ingest/enrich/model_registry.json`); burada yalniz DURUM vardir:
--   building -> shadow -> active -> retired  (rollback: en son retired yeniden active).
-- Hedef basina en fazla BIR `active` satir: kismi unique indeks motor duzeyinde zorlar. Gecis tek
-- islemde (eskiyi retired, yeniyi active) yapilir; okuyan taraf (TS anlamsal arama) her an ya
-- eskiyi ya yeniyi gorur.
--
-- `product_text_embedding_d384`: 384 boyutlu modeller icin `product_text_embedding` (0105) ile
-- AYNI sozlesme. Farkli boyutlar ayni kolona KARISAMAZ (halfvec(768) kolonu 384'u kabul etmez);
-- her boyut kendi tablosunda, kendi HNSW indeksiyle (yukleme sonrasi ayri `concurrent` migration).
--
-- Mevcut davranis korunur: tohum satir bugunku tek uretim indeksini (`jina-embeddings-v3`,
-- `product_text_embedding`) `active` olarak kaydeder. Yalniz yeni tablolar; mevcut tablo/kod
-- etkilenmez. Geri alma: iki tabloyu DROP (hicbir sey bunlara FK ile bagli degil).
CREATE TABLE IF NOT EXISTS embedding_index (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    target        TEXT        NOT NULL CHECK (target IN ('product_text')),
    model_version TEXT        NOT NULL CHECK (model_version ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
    index_family  TEXT        NOT NULL CHECK (index_family ~ '^[a-z][a-z0-9_]{1,63}$'),
    dimensions    INTEGER     NOT NULL CHECK (dimensions BETWEEN 1 AND 4000),
    storage_table TEXT        NOT NULL
                  CHECK (storage_table IN ('product_text_embedding', 'product_text_embedding_d384')),
    state         TEXT        NOT NULL DEFAULT 'building'
                  CHECK (state IN ('building', 'shadow', 'active', 'retired')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    activated_at  TIMESTAMPTZ,
    retired_at    TIMESTAMPTZ,
    CONSTRAINT embedding_index_target_model UNIQUE (target, model_version),
    CONSTRAINT embedding_index_table_dims CHECK (
        (storage_table = 'product_text_embedding' AND dimensions = 768)
        OR (storage_table = 'product_text_embedding_d384' AND dimensions = 384)
    ),
    CONSTRAINT embedding_index_active_stamped CHECK (state <> 'active' OR activated_at IS NOT NULL),
    CONSTRAINT embedding_index_retired_stamped CHECK (state <> 'retired' OR retired_at IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS embedding_index_one_active
    ON embedding_index (target) WHERE state = 'active';

-- Durum gecmisi kaybolmasin: satir silinmez, `retired` olur (rollback onu yeniden kullanir).
REVOKE DELETE, TRUNCATE ON embedding_index FROM arilla_app;

INSERT INTO embedding_index
       (target, model_version, index_family, dimensions, storage_table, state, activated_at)
VALUES ('product_text', 'jina-embeddings-v3', 'product_text_halfvec768', 768,
        'product_text_embedding', 'active', now())
ON CONFLICT (target, model_version) DO NOTHING;

COMMENT ON TABLE embedding_index IS
    'Embedding indeks durumu (karar 0181). Hedef basina tek active; gecis/rollback: '
    'services/ingest enrich.index. Okuyan: packages/core search/semantic/active-index.ts.';

CREATE TABLE IF NOT EXISTS product_text_embedding_d384 (
    product_id    BIGINT       NOT NULL REFERENCES product(id) ON DELETE CASCADE,
    model_version TEXT         NOT NULL CHECK (model_version ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
    text_version  SMALLINT     NOT NULL CHECK (text_version > 0),
    content_hash  BYTEA        NOT NULL CHECK (octet_length(content_hash) = 16),
    source_hash   BYTEA        NOT NULL CHECK (octet_length(source_hash) = 16),
    embedding     halfvec(384) NOT NULL,
    embedded_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    PRIMARY KEY (product_id, model_version)
);

CREATE INDEX IF NOT EXISTS product_text_embedding_d384_hash_idx
    ON product_text_embedding_d384 (model_version, content_hash);

COMMENT ON TABLE product_text_embedding_d384 IS
    'Urun metin vektoru, 384 boyutlu modeller (karar 0181; sozlesme 0105 ile ayni). '
    'Yazan: services/ingest enrich.products. Benzerlik urun kimligi KANITI degildir.';
