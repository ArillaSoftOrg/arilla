-- 0008 — arama
-- docs/schema.sql referans belgesinden bire bir tasindi.

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

-- Sözlükler. Veritabanında tutulur ki yeni eşanlamlı için sürüm çıkmasın.
CREATE TABLE lexicon (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind        TEXT   NOT NULL
                CHECK (kind IN ('color','category','brand','size','material','style')),
    surface     TEXT   NOT NULL,              -- 'spor ayakkabı'
    normalized  TEXT   NOT NULL,              -- 'ayakkabi/sneaker'
    weight      REAL   NOT NULL DEFAULT 1.0,
    CONSTRAINT lexicon_uniq UNIQUE (kind, surface)
);
CREATE INDEX lexicon_surface_idx ON lexicon (surface);
