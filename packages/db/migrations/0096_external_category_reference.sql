-- kind: schema
-- 0096 — dis kaynak kategori referans agaci (karar 0143): Trendyol urun kategorileri
--
-- ManiCepte `category` agacindan AYRI, yalnizca-okunur referanstir. Kaynak kimligi
-- (`external_id`) dahili `category.id` ile KARISMAZ; hicbir sutun `category` ya da `product`
-- tablosuna baglanmaz, siniflandirici (`services/ingest/classify`) bu tablolari OKUMAZ.
-- Yeni kategoriler urunsuz da bulunur; eslesme (`external_category_map`) bos acilir ve elle/
-- ayri dogrulamayla doldurulur.
--
-- Yalnizca yeni tablolar: var olan tabloya kolon eklenmez, buyuk tabloya dokunulmaz.
-- Geri alma: karar 0143 §6.

-- Bir ice aktarimin kaydi: hangi ham dosya (sha256), kac kategori. Ayni dosya ikinci kez
-- ice aktarilamaz (UNIQUE); satirlar `import_id` ile geri alinabilir.
CREATE TABLE IF NOT EXISTS external_category_import (
    id              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source          TEXT        NOT NULL CHECK (source ~ '^[a-z][a-z0-9_]{1,30}$'),
    source_sha256   TEXT        NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
    category_count  INTEGER     NOT NULL CHECK (category_count > 0),
    root_count      INTEGER     NOT NULL CHECK (root_count > 0),
    max_depth       SMALLINT    NOT NULL CHECK (max_depth > 0),
    imported_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source, source_sha256)
);

-- Kaynak kategorisi. Hiyerarsi kaynak kimligiyle korunur: (source, parent_external_id) ayni
-- tablodaki (source, external_id) satirini gosterir (kendi kendine bilesik yabanci anahtar;
-- tek INSERT icinde, ebeveyn ve cocuk birlikte eklenebilir). `retired_at`: sonraki bir
-- ice aktarimda kaynaktan kalkan kategori silinmez, isaretlenir.
CREATE TABLE IF NOT EXISTS external_category (
    source              TEXT        NOT NULL CHECK (source ~ '^[a-z][a-z0-9_]{1,30}$'),
    external_id         BIGINT      NOT NULL CHECK (external_id > 0),
    parent_external_id  BIGINT,
    name                TEXT        NOT NULL CHECK (btrim(name) <> ''),
    depth               SMALLINT    NOT NULL CHECK (depth > 0),
    is_leaf             BOOLEAN     NOT NULL,
    path_ids            BIGINT[]    NOT NULL CHECK (cardinality(path_ids) = depth),
    path_text           TEXT        NOT NULL,
    import_id           BIGINT      NOT NULL REFERENCES external_category_import(id),
    retired_at          TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (source, external_id),
    FOREIGN KEY (source, parent_external_id) REFERENCES external_category (source, external_id),
    CHECK ((depth = 1) = (parent_external_id IS NULL))
);
CREATE INDEX IF NOT EXISTS external_category_parent_idx
    ON external_category (source, parent_external_id);
CREATE INDEX IF NOT EXISTS external_category_import_idx ON external_category (import_id);

-- Kaynak kategori -> ManiCepte kategorisi. BOS acilir; siniflandirici okumaz. 'suggested'
-- bir oneridir, 'confirmed' insan onayidir (category_source_map ile ayni durum anlami).
CREATE TABLE IF NOT EXISTS external_category_map (
    source          TEXT        NOT NULL,
    external_id     BIGINT      NOT NULL,
    category_id     BIGINT      NOT NULL REFERENCES category(id),
    status          TEXT        NOT NULL DEFAULT 'suggested'
                    CHECK (status IN ('suggested', 'confirmed', 'rejected')),
    decided_by      TEXT,
    note            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (source, external_id),
    FOREIGN KEY (source, external_id) REFERENCES external_category (source, external_id)
        ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS external_category_map_category_idx ON external_category_map (category_id);

-- Kullanilmayan kategori raporu (salt okunur). 'unmapped': eslesme yok; 'mapped_empty':
-- eslesen ManiCepte kategorisinde urun yok; 'in_use': urun var; 'rejected': elenmis.
-- Urun sayimi yalnizca eslesen (az sayida) kategori icin `product_category_idx` uzerinden
-- EXISTS ile yapilir; tum katalog taranmaz.
CREATE OR REPLACE VIEW external_category_usage AS
SELECT ec.source,
       ec.external_id,
       ec.depth,
       ec.is_leaf,
       ec.path_text,
       ec.retired_at,
       m.category_id,
       m.status AS map_status,
       CASE
           WHEN m.external_id IS NULL THEN 'unmapped'
           WHEN m.status = 'rejected' THEN 'rejected'
           WHEN EXISTS (SELECT 1 FROM product p WHERE p.category_id = m.category_id) THEN 'in_use'
           ELSE 'mapped_empty'
       END AS usage
  FROM external_category ec
  LEFT JOIN external_category_map m
    ON m.source = ec.source AND m.external_id = ec.external_id;
