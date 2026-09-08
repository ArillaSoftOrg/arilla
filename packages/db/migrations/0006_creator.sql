-- 0006 — creator, koleksiyon, kaydetme, alarm
-- docs/schema.sql referans belgesinden bire bir tasindi.

CREATE TABLE creator (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         BIGINT      NOT NULL UNIQUE REFERENCES app_user(id),
    handle          TEXT        NOT NULL UNIQUE,   -- /@elif
    display_name    TEXT        NOT NULL,
    bio             TEXT,
    avatar_url      TEXT,
    tier            TEXT        NOT NULL DEFAULT 'starter'
                    CHECK (tier IN ('starter','rising','trusted','top')),
    affiliate_mode  TEXT        NOT NULL DEFAULT 'own'
                    CHECK (affiliate_mode IN ('own','platform')),
    is_verified     BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Creator'ın kendi affiliate hesapları (Model A). Komisyon doğrudan ona gider.
CREATE TABLE creator_affiliate_account (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    creator_id   BIGINT NOT NULL REFERENCES creator(id),
    merchant_id  BIGINT NOT NULL REFERENCES merchant(id),
    tracking_id  TEXT   NOT NULL,
    status       TEXT   NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','invalid','revoked')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT creator_affiliate_uniq UNIQUE (creator_id, merchant_id)
);

CREATE TABLE collection (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    creator_id  BIGINT      NOT NULL REFERENCES creator(id),
    slug        TEXT        NOT NULL,
    title       TEXT        NOT NULL,
    description TEXT,
    cover_url   TEXT,
    is_public   BOOLEAN     NOT NULL DEFAULT TRUE,
    position    INTEGER     NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT collection_slug_uniq UNIQUE (creator_id, slug)
);

CREATE TABLE collection_item (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    collection_id BIGINT  NOT NULL REFERENCES collection(id) ON DELETE CASCADE,
    product_id    BIGINT  NOT NULL REFERENCES product(id),
    preferred_offer_id BIGINT REFERENCES offer(id),
    note          TEXT,
    position      INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT collection_item_uniq UNIQUE (collection_id, product_id)
);

CREATE TABLE follow (
    user_id     BIGINT NOT NULL REFERENCES app_user(id),
    creator_id  BIGINT NOT NULL REFERENCES creator(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, creator_id)
);

CREATE TABLE saved_item (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES app_user(id),
    product_id  BIGINT NOT NULL REFERENCES product(id),
    source_creator_id BIGINT REFERENCES creator(id),   -- wishlist attribution
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT saved_item_uniq UNIQUE (user_id, product_id)
);

-- Fiyat, stok ve beden alarmları tek tabloda. Hepsi e-posta ile gider.
CREATE TABLE alert (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id       BIGINT  NOT NULL REFERENCES app_user(id),
    product_id    BIGINT  NOT NULL REFERENCES product(id),
    kind          TEXT    NOT NULL
                  CHECK (kind IN ('price_drop','any_drop','restock','size_restock')),
    target_price  BIGINT,                    -- price_drop için zorunlu
    size_norm     TEXT,                      -- size_restock için zorunlu
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    triggered_at  TIMESTAMPTZ,
    notified_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT alert_uniq UNIQUE (user_id, product_id, kind, size_norm),
    CONSTRAINT alert_price_target CHECK (kind <> 'price_drop' OR target_price IS NOT NULL),
    CONSTRAINT alert_size_target  CHECK (kind <> 'size_restock' OR size_norm IS NOT NULL)
);
CREATE INDEX alert_active_idx ON alert (product_id) WHERE is_active;
