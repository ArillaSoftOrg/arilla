-- kind: schema
-- 0105 — urun duzeyinde metin embedding'i (karar 0177; pilot karar 0170'in uretim tablosu).
--
-- Neden `embedding` tablosu degil:
--   * Yasam dongusu ayri: teklif/gorsel vektorleri (`embedding`, jina-clip-v2, float32) degismez.
--   * Boyut: 12,3 M urunde float32 `vector(768)` ~102 GB tutar (uretimde 99 GB bos); `halfvec(768)`
--     ~44 GB. Pilotta halfvec ile siralama kaybi olculmedi (ilk-10 ortusme 0,999).
--   * Gercek FK + ON DELETE CASCADE: polimorfik tablodaki yetim satir riski (karar 0020) yok.
--
-- Kolonlar:
--   * `content_hash`  = sha256(model, metin surumu, kanonik metin) ilk 16 bayt. Ayni kanonik metin
--     ayni vektor demektir: baska urunde varsa API cagrilmadan kopyalanir.
--   * `source_hash`   = md5(baslik, U+001F, marka adi). SQL'de hesaplanir; degisen urunu toplu is
--     metni Python'a tasimadan bulur (degismeyen urun icin hicbir satir okunmaz/yazilmaz).
--   * `text_version`  kanonik metin kurali (`services/ingest/enrich/product_text.py`) degisince artar;
--     eski surumlu satirlar bir sonraki kosuda yeniden uretilir.
--
-- HNSW indeksi BU DOSYADA YOK: toplu yukleme sirasinda indeks bakimi yazimi ve WAL'i buyutur.
-- Yukleme bittikten sonra ayri `kind: concurrent` migration ile kurulur (karar 0177, "Indeks").
--
-- Yalnizca yeni tablo; mevcut tablo/kod etkilenmez. Python toplu isi (`python -m enrich.products`)
-- yazar; TypeScript ileride yalnizca okur. Geri alma: DROP TABLE product_text_embedding.
CREATE TABLE IF NOT EXISTS product_text_embedding (
    product_id    BIGINT       NOT NULL REFERENCES product(id) ON DELETE CASCADE,
    model_version TEXT         NOT NULL CHECK (model_version ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
    text_version  SMALLINT     NOT NULL CHECK (text_version > 0),
    content_hash  BYTEA        NOT NULL CHECK (octet_length(content_hash) = 16),
    source_hash   BYTEA        NOT NULL CHECK (octet_length(source_hash) = 16),
    embedding     halfvec(768) NOT NULL,
    embedded_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    PRIMARY KEY (product_id, model_version)
);

-- Ayni kanonik metnin vektorunu API'siz bulmak icin. Tablo bos olusturuldugu icin islem icinde
-- kurulur (CONCURRENTLY gerekmez).
CREATE INDEX IF NOT EXISTS product_text_embedding_hash_idx
    ON product_text_embedding (model_version, content_hash);

COMMENT ON TABLE product_text_embedding IS
    'Urun metin vektoru (karar 0177). Yazan: services/ingest enrich.products. '
    'Benzerlik urun kimligi KANITI degildir; eslestirme yalnizca resolve + vetolarla yapilir.';
