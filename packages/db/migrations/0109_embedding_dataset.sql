-- kind: schema
-- 0109 — kalici embedding veri seti (karar 0179): saglayicidan alinan her metin vektoru,
-- kanonik metniyle birlikte, urunden BAGIMSIZ saklanir.
--
-- `product_text_embedding` (0105) urunun guncel vektorudur: urun silinince FK ile gider, baslik
-- degisince ustune yazilir ve metni saklamaz. Bu tablo ise ileride kendi modelimizi egitmek /
-- damitmak icin (metin, vektor) ciftlerinin ARSIVIDIR:
--   * anahtar (model_version, content_hash): ayni kanonik metin tek satir (dogal tekillestirme);
--   * urune FK YOK: urun silinse de degisse de satir kalir (`first_product_id` yalniz iz);
--   * yalniz EKLEME (price_point gibi, kural 4 kalibi): arilla_app UPDATE/DELETE/TRUNCATE yapamaz;
--   * katalog metni kisisel veri degildir; kullanici sorgu metni bu tabloya YAZILMAZ (KVKK).
-- Uretim yedekleri (pgBackRest, karar 0110) bu tabloyu da kapsar.
--
-- Yalnizca yeni tablo. Geri alma: DROP TABLE embedding_dataset (hicbir sey buna bagli degil).
CREATE TABLE IF NOT EXISTS embedding_dataset (
    model_version    TEXT         NOT NULL CHECK (model_version ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
    content_hash     BYTEA        NOT NULL CHECK (octet_length(content_hash) = 16),
    text_version     SMALLINT     NOT NULL CHECK (text_version > 0),
    task             TEXT         NOT NULL CHECK (task ~ '^[a-z][a-z._]{1,39}$'),
    input_text       TEXT         NOT NULL CHECK (char_length(input_text) BETWEEN 1 AND 2000),
    embedding        halfvec(768) NOT NULL,
    source           TEXT         NOT NULL CHECK (source IN ('api', 'backfill')),
    first_product_id BIGINT,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    PRIMARY KEY (model_version, content_hash)
);

REVOKE UPDATE, DELETE, TRUNCATE ON embedding_dataset FROM arilla_app;

COMMENT ON TABLE embedding_dataset IS
    'Kalici (metin, vektor) arsivi (karar 0179). Yalniz ekleme; urune FK yok. '
    'Yazan: services/ingest enrich.products ve enrich.dataset.';
