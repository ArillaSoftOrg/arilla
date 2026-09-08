-- 0007 — attribution, maliyet, is kuyrugu kaydi
-- docs/schema.sql referans belgesinden bire bir tasindi.

-- ---------------------------------------------------------------------------
-- ATTRIBUTION — merchant'a giden her çıkış buradan geçer
-- ---------------------------------------------------------------------------

CREATE TABLE click (
    id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),  -- click_id
    user_id       BIGINT      REFERENCES app_user(id),                 -- anonim olabilir
    session_id    TEXT        NOT NULL,
    creator_id    BIGINT      REFERENCES creator(id),
    offer_id      BIGINT      NOT NULL REFERENCES offer(id),
    product_id    BIGINT      REFERENCES product(id),
    channel       TEXT        NOT NULL
                  CHECK (channel IN ('web','mcp','extension','api','prefix_link')),
    surface       TEXT,                    -- 'search','collection','alert','compare'
    price_at_click BIGINT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX click_creator_time_idx ON click (creator_id, created_at DESC);
CREATE INDEX click_session_idx      ON click (session_id, created_at DESC);
CREATE INDEX click_offer_time_idx   ON click (offer_id, created_at DESC);

CREATE TABLE conversion (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    click_id     UUID        REFERENCES click(id),
    merchant_id  BIGINT      NOT NULL REFERENCES merchant(id),
    creator_id   BIGINT      REFERENCES creator(id),
    external_order_id TEXT,
    order_value  BIGINT      NOT NULL,
    commission   BIGINT,
    status       TEXT        NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','confirmed','cancelled','paid')),
    occurred_at  TIMESTAMPTZ NOT NULL,
    reconciled_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT conversion_external_uniq UNIQUE (merchant_id, external_order_id)
);
CREATE INDEX conversion_creator_idx ON conversion (creator_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- MALİYET ÖLÇÜMÜ — birim ekonomisi bu tablodan okunur
-- ---------------------------------------------------------------------------

CREATE TABLE api_usage (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id    TEXT,
    user_id       BIGINT REFERENCES app_user(id),
    b2b_client_id BIGINT,                  -- Faz 4
    operation     TEXT        NOT NULL,    -- 'visual_search','semantic_search','review_summary'
    model_version TEXT,
    units         INTEGER     NOT NULL DEFAULT 1,
    cost_micros   BIGINT      NOT NULL DEFAULT 0,   -- TRY milyonda bir
    cache_hit     BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX api_usage_session_idx ON api_usage (session_id, created_at DESC);
CREATE INDEX api_usage_daily_idx   ON api_usage (created_at, operation);

-- ---------------------------------------------------------------------------
-- İŞ KUYRUĞU KAYDI (Redis kuyruğunun kalıcı izi)
-- ---------------------------------------------------------------------------

CREATE TABLE ingest_run (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    merchant_id  BIGINT      NOT NULL REFERENCES merchant(id),
    started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at  TIMESTAMPTZ,
    status       TEXT        NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running','success','partial','failed')),
    offers_seen      INTEGER NOT NULL DEFAULT 0,
    offers_created   INTEGER NOT NULL DEFAULT 0,
    offers_updated   INTEGER NOT NULL DEFAULT 0,
    price_points_written INTEGER NOT NULL DEFAULT 0,
    error_text   TEXT
);
CREATE INDEX ingest_run_merchant_idx ON ingest_run (merchant_id, started_at DESC);
