-- kind: schema
-- 0074 — kaynak ilanindan urun (source listing) ve yayin durumu (karar 0121)
--
-- Katalog aktarimi (offer'dan taslak urun uretimi) ile kullaniciya yayin
-- (kalite kapisi + acik yayin karari) AYRILIR:
--
--   draft  -> aktarimdan cikti, hic kontrol edilmedi
--   ready  -> otomatik kalite kapisini gecti, yayin karari bekliyor
--   held   -> kapidan dustu; `hold_reason` nedeni tasir
--   published -> kullaniciya acik (mevcut tum urunler)
--
-- Kaynak kimligi `(source_merchant_id, source_external_id)` urunun ustunde DURUR ve
-- benzersizdir: ayni kaynak ilani icin ikinci urun DB duzeyinde olusamaz. Hepsiburada
-- kesif defteri (0073, #154) ayni anahtari kullanabilir: offer'i olmayan kesif satiri
-- `source_offer_id` olmadan urun olur.
--
-- GERIYE UYUMLU / YALNIZCA EKLEME:
--   * Yeni kolonlar sabit varsayilanli ya da NULL (PG 11+: tablo yeniden yazilmaz);
--     mevcut tum urunler `published` kalir, davranis degismez.
--   * `offer` satirina DOKUNULMAZ. Taslak urun offer'a `offer.product_id` ile
--     BAGLANMAZ; bag yayin aninda kurulur. Boylece 2,8M AliExpress teklifi
--     /teklifler (yurt disi) listesinde ve eslesmemis sayimlarinda aynen kalir.
--
-- Iki GIN trigram indeksi (baslik) artik YALNIZCA yayinlanmis urunleri kapsar:
-- yuz binlerce/milyonlarca taslak aramada gorunmez, indeksi sismesin. Sorgular ayni
-- yuklemi tasir (`publication_state = 'published'`). Urun tablosu yeni; bu iki indeks
-- kisa bir kilitle yeniden kurulur (uretimde `product` bos iken uygulanmalidir).

ALTER TABLE product
    ADD COLUMN publication_state TEXT NOT NULL DEFAULT 'published'
        CHECK (publication_state IN ('draft', 'ready', 'held', 'published')),
    ADD COLUMN hold_reason TEXT
        CHECK (hold_reason IS NULL OR hold_reason ~ '^[a-z0-9_]{2,60}$'),
    ADD COLUMN published_at TIMESTAMPTZ,
    ADD COLUMN source_merchant_id BIGINT REFERENCES merchant(id),
    ADD COLUMN source_external_id TEXT
        CHECK (source_external_id IS NULL OR char_length(source_external_id) BETWEEN 1 AND 200),
    ADD COLUMN source_offer_id BIGINT REFERENCES offer(id),
    ADD CONSTRAINT product_source_pair
        CHECK ((source_merchant_id IS NULL) = (source_external_id IS NULL)),
    ADD CONSTRAINT product_source_offer_has_key
        CHECK (source_offer_id IS NULL OR source_merchant_id IS NOT NULL),
    ADD CONSTRAINT product_hold_reason_matches_state
        CHECK ((publication_state = 'held') = (hold_reason IS NOT NULL)),
    -- Yayinlanmamis urun YALNIZCA kaynak ilanindan gelebilir: mevcut yazicilar
    -- (cozumleyici, Shopify) yanlislikla taslak uretemez.
    ADD CONSTRAINT product_unpublished_is_source_listing
        CHECK (publication_state = 'published' OR source_merchant_id IS NOT NULL);

COMMENT ON COLUMN product.publication_state IS
    'draft/ready/held: aktarilmis ama kullaniciya kapali; published: acik. Karar 0121.';
COMMENT ON COLUMN product.source_external_id IS
    'Kaynak ilan kimligi (or. AliExpress urun kimligi), source_merchant_id kapsaminda benzersiz.';

-- Kaynak kimligi ONDE: yonetim aramasi yalniz kimlikle sorar (mağaza bilinmez).
CREATE UNIQUE INDEX product_source_key_uniq ON product (source_external_id, source_merchant_id)
    WHERE source_merchant_id IS NOT NULL;
CREATE UNIQUE INDEX product_source_offer_uniq ON product (source_offer_id)
    WHERE source_offer_id IS NOT NULL;
-- Kapi/yayin taramalari: durum + anahtar sirali, yayinlanmislari disarida birakir.
CREATE INDEX product_unpublished_idx ON product (publication_state, id)
    WHERE publication_state <> 'published';

-- Baslik aramasi yalnizca yayinlanmis urunlerde.
DROP INDEX product_title_trgm;
CREATE INDEX product_title_trgm ON product USING gin (title gin_trgm_ops)
    WHERE publication_state = 'published';
DROP INDEX product_title_fold_trgm;
CREATE INDEX product_title_fold_trgm ON product
    USING gin (lower(translate(title, 'ıİIŞşÇçĞğÖöÜüÂâÎîÛû', 'iiissccggoouuaaiiuu')) gin_trgm_ops)
    WHERE publication_state = 'published';

-- Kaynak basina aktarim kontrol noktasi. Her parti ve kontrol noktasi AYNI islemde
-- yazilir: cokme sonrasi parti ya tamamen vardir ya hic. Atlanan teklifler tek tek
-- degil, neden bazinda sayilir (`skipped`); yeniden tarama (`--rescan`) idempotenttir.
CREATE TABLE catalog_build_state (
    merchant_id    BIGINT      PRIMARY KEY REFERENCES merchant(id),
    last_offer_id  BIGINT      NOT NULL DEFAULT 0 CHECK (last_offer_id >= 0),
    scanned        BIGINT      NOT NULL DEFAULT 0 CHECK (scanned >= 0),
    created        BIGINT      NOT NULL DEFAULT 0 CHECK (created >= 0),
    existing       BIGINT      NOT NULL DEFAULT 0 CHECK (existing >= 0),
    skipped        JSONB       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(skipped) = 'object'),
    started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at   TIMESTAMPTZ
);
