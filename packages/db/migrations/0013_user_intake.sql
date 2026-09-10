-- 0013 — gorsel arama ve link oneki icin kullanici tetikli kesif tablolari
--
-- D4 (docs/backlog.md): fotograf yukleme + kok catch-all link cozumleme.
-- Iki tablo da CLAUDE.md 1. kural (istek yolunda tek istisna: yuklenen
-- gorselin embedding'i) ile docs/decisions/0014 (tekil link cozumleme
-- ingest_run yazmaz) tarafindan zaten cercevelenmisti; burada semaya
-- donusuyor. Detay ve gerekce: docs/schema.sql "GORSEL ARAMA VE LINK ONEKI"
-- basligi altindaki yorumlar.

CREATE TABLE image_upload (
    id               BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id          BIGINT      REFERENCES app_user(id),
    session_id       TEXT        NOT NULL,
    image_hash       TEXT        NOT NULL,
    object_key       TEXT,
    has_face         BOOLEAN     NOT NULL DEFAULT FALSE,
    status           TEXT        NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','embedded','rejected_not_product','rejected_moderation')),
    rejection_reason TEXT,
    embedding_id     BIGINT      REFERENCES embedding(id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    purge_after      TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '30 days'
);
CREATE INDEX image_upload_hash_idx    ON image_upload (image_hash) WHERE status = 'embedded';
CREATE INDEX image_upload_user_idx    ON image_upload (user_id, created_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX image_upload_session_idx ON image_upload (session_id, created_at DESC);
CREATE INDEX image_upload_purge_idx   ON image_upload (purge_after) WHERE object_key IS NOT NULL;

CREATE TABLE link_resolution_request (
    id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    url_raw      TEXT        NOT NULL,
    session_id   TEXT        NOT NULL,
    user_id      BIGINT      REFERENCES app_user(id),
    status       TEXT        NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued','processing','resolved','failed')),
    offer_id     BIGINT      REFERENCES offer(id),
    error_text   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at  TIMESTAMPTZ
);
CREATE INDEX link_resolution_request_session_idx ON link_resolution_request (session_id, created_at DESC);

-- Not: 0010 `ALTER DEFAULT PRIVILEGES` ile arilla_app'e yeni tablolarda
-- otomatik SELECT/INSERT/UPDATE/DELETE veriyor. Bu iki tablo append-only
-- DEGIL (status alanlari worker tarafindan guncellenir), o yuzden ek REVOKE
-- gerekmiyor.
