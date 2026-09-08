-- 0004 — anlam katmani
-- docs/schema.sql referans belgesinden bire bir tasindi.

-- ---------------------------------------------------------------------------
-- ANLAM KATMANI
-- ---------------------------------------------------------------------------

-- Embedding offer üzerinden üretilir (her merchant'ın kendi fotoğrafı var),
-- benzerlik product üzerinden hesaplanır.
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
