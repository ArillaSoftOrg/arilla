-- kind: schema
-- 0114 — 1024 boyutlu urun metin vektoru depolamasi (karar 0195; BGE-M3 icin).
--
-- `product_text_embedding_d1024`: `product_text_embedding` (0105) ve `_d384` (0110) ile AYNI
-- sozlesme; yalniz `embedding halfvec(1024)`. Farkli boyutlar ayni kolona KARISAMAZ; her boyut kendi
-- tablosunda, kendi HNSW indeksiyle durur. Anahtar `(product_id, model_version)`: ayni urun icin
-- farkli modeller (ve model revizyonlari: `model_version` revizyonu tasir, or. `bge-m3-5617a9f6`)
-- yan yana yasar, birbirinin yerine gecmez.
--
-- STORAGE PLAIN: 1024 x 2 bayt = 2 KiB vektor satir icinde kalir, TOAST'a gitmez (E3-d olcumu:
-- TOAST'lu halfvec'te sirali okuma ve HNSW yeniden okuma maliyeti belirgin artiyordu).
--
-- BU MIGRATION YALNIZ TABLOYU KURAR. Bos tablo, HNSW indeksi ve `embedding_index` satiri yok: anlamsal
-- sunum (karar 0190) HAZIR indeks bulamadigi surece bu tabloyu HIC sorgulamaz. HNSW, vektorler
-- yuklendikten sonra AYRI `concurrent` migration'da kurulur (yukleme sirasinda indeks bakimi WAL ve
-- sure maliyetini katlar; karar 0195 §3). Geri alma: tabloyu DROP (hicbir sey buna FK ile bagli
-- degil) ve iki kisitin onceki tanimini geri yukle.
--
-- Mevcut Jina (768) ve e5 (384) verisine dokunulmaz.
CREATE TABLE IF NOT EXISTS product_text_embedding_d1024 (
    product_id    BIGINT        NOT NULL REFERENCES product(id) ON DELETE CASCADE,
    model_version TEXT          NOT NULL CHECK (model_version ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
    text_version  SMALLINT      NOT NULL CHECK (text_version > 0),
    content_hash  BYTEA         NOT NULL CHECK (octet_length(content_hash) = 16),
    source_hash   BYTEA         NOT NULL CHECK (octet_length(source_hash) = 16),
    embedding     halfvec(1024) NOT NULL,
    embedded_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
    PRIMARY KEY (product_id, model_version)
);

ALTER TABLE product_text_embedding_d1024 ALTER COLUMN embedding SET STORAGE PLAIN;

CREATE INDEX IF NOT EXISTS product_text_embedding_d1024_hash_idx
    ON product_text_embedding_d1024 (model_version, content_hash);

COMMENT ON TABLE product_text_embedding_d1024 IS
    'Urun metin vektoru, 1024 boyutlu modeller (karar 0195; sozlesme 0105 ile ayni; STORAGE PLAIN). '
    'Yazan: services/ingest enrich.vector_import / enrich.products. Benzerlik urun kimligi KANITI degildir.';

-- `embedding_index` kisitlari yeni tabloyu ve 1024 boyutu kabul eder. Kisit adlari: satir ici CHECK'in
-- otomatik adi (`<tablo>_<kolon>_check`) ve 0110'daki acik ad; temiz bir veritabaninda dogrulandi.
ALTER TABLE embedding_index DROP CONSTRAINT IF EXISTS embedding_index_storage_table_check;
ALTER TABLE embedding_index ADD CONSTRAINT embedding_index_storage_table_check CHECK (
    storage_table IN ('product_text_embedding', 'product_text_embedding_d384',
                      'product_text_embedding_d1024')
);

ALTER TABLE embedding_index DROP CONSTRAINT IF EXISTS embedding_index_table_dims;
ALTER TABLE embedding_index ADD CONSTRAINT embedding_index_table_dims CHECK (
    (storage_table = 'product_text_embedding' AND dimensions = 768)
    OR (storage_table = 'product_text_embedding_d384' AND dimensions = 384)
    OR (storage_table = 'product_text_embedding_d1024' AND dimensions = 1024)
);
