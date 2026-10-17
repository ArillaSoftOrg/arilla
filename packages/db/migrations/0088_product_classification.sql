-- kind: schema
-- 0088 — urun siniflandirmasi: marka/kategori kaniti, kontrol noktasi, kaynak kategori guveni (karar 0133)
--
-- AliExpress beslemesinde kategori agaci var (`offer.category_raw` = "Ust > Alt"), marka yok.
-- `catalog_build` taslak urunu yalniz baslik/gorselle acar; marka ve kategori hic yazilmaz.
-- Siniflandirma ayri bir toplu istir (`services/ingest/classify`): urunu YENIDEN OLUSTURMAZ,
-- yalniz bos `product.brand_id` / `product.category_id` alanlarini doldurur ve kendi yazdigini
-- sonraki kosuda duzeltebilir. Insanin ya da beslemenin yazdigi degere dokunmaz.
--
-- Yeni tablolar bos acilir; buyuk tabloya indeks/kolon eklenmez (urun tablosu degismez).

-- ---------------------------------------------------------------------------
-- Kaynak kategori esleme guveni. Kural onerisi 'suggested' + guven yazar; 'confirmed' /
-- 'rejected' yonetici kararidir ve kural kosusu bunlari degistirmez.
-- ---------------------------------------------------------------------------
ALTER TABLE category_source_map
    ADD COLUMN IF NOT EXISTS confidence SMALLINT
        CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 100),
    ADD COLUMN IF NOT EXISTS rule_version SMALLINT
        CHECK (rule_version IS NULL OR rule_version > 0);

-- ---------------------------------------------------------------------------
-- Urun basina siniflandirma kaniti (tek satir). `wrote_*`: bu is urune o degeri YAZDI;
-- sonraki kosu yalnizca kendi yazdigi (ve o gunden beri degismemis) degeri degistirir.
-- 'review' = kategori kararsiz (catisma / dusuk guven / kanit yok): urun kategorisiz
-- bekler, yanlis kategori yazilmaz. 'error' = kayit islenemedi (kosuyu durdurmaz).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_classification (
    product_id        BIGINT      PRIMARY KEY REFERENCES product(id) ON DELETE CASCADE,
    rule_version      SMALLINT    NOT NULL CHECK (rule_version > 0),
    state             TEXT        NOT NULL CHECK (state IN ('applied', 'review', 'error')),
    brand_id          BIGINT      REFERENCES brand(id),
    brand_basis       TEXT        NOT NULL
                      CHECK (brand_basis IN ('existing', 'source', 'title', 'none', 'ambiguous')),
    category_id       BIGINT      REFERENCES category(id),
    category_basis    TEXT        NOT NULL
                      CHECK (category_basis IN ('existing', 'source', 'source_title', 'title',
                                                'none', 'conflict', 'low_confidence')),
    confidence        SMALLINT    NOT NULL CHECK (confidence BETWEEN 0 AND 100),
    -- "iPhone ile uyumlu kilif": uyumluluk markasi (brand.name_norm), urunun markasi DEGIL.
    compatible_brands TEXT[]      CHECK (compatible_brands IS NULL OR cardinality(compatible_brands) <= 8),
    wrote_brand       BOOLEAN     NOT NULL DEFAULT FALSE,
    wrote_category    BOOLEAN     NOT NULL DEFAULT FALSE,
    detail            TEXT        CHECK (detail IS NULL OR detail ~ '^[a-z0-9_]{2,60}$'),
    classified_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT product_classification_wrote_brand CHECK (NOT wrote_brand OR brand_basis IN ('source', 'title')),
    CONSTRAINT product_classification_wrote_category
        CHECK (NOT wrote_category OR category_basis IN ('source', 'source_title', 'title'))
);
-- Inceleme kuyrugu ve hata sayimi; 'applied' satirlari (cogunluk) indekse girmez.
CREATE INDEX IF NOT EXISTS product_classification_open_idx
    ON product_classification (state, product_id) WHERE state <> 'applied';

-- Kural surumu + kapsam basina kontrol noktasi. Parti + kontrol noktasi ayni islemde
-- yazilir; yeni surum basa doner (yeni satir), eski surumun sayaclari kalir. 'all' tum
-- katalogdur (yonetim paneli bunu okur); 'merchant:<slug>' tek kaynagin urunleridir.
CREATE TABLE IF NOT EXISTS product_classification_state (
    rule_version     SMALLINT    NOT NULL CHECK (rule_version > 0),
    scope            TEXT        NOT NULL DEFAULT 'all'
                     CHECK (scope ~ '^(all|merchant:[a-z0-9-]{1,80})$'),
    last_product_id  BIGINT      NOT NULL DEFAULT 0 CHECK (last_product_id >= 0),
    scanned          BIGINT      NOT NULL DEFAULT 0 CHECK (scanned >= 0),
    brand_set        BIGINT      NOT NULL DEFAULT 0 CHECK (brand_set >= 0),
    category_set     BIGINT      NOT NULL DEFAULT 0 CHECK (category_set >= 0),
    review           BIGINT      NOT NULL DEFAULT 0 CHECK (review >= 0),
    errors           BIGINT      NOT NULL DEFAULT 0 CHECK (errors >= 0),
    started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at     TIMESTAMPTZ,
    PRIMARY KEY (rule_version, scope)
);
