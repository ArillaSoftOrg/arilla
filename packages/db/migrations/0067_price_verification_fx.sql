-- kind: schema
-- 0067 — bagimsiz fiyat dogrulama ve doviz kuru (karar 0113)
--
-- YALNIZCA EKLEME. Yeni tablolar; mevcut hicbir sey degismez.
--
-- fx_rate:               resmi kaynaktan (TCMB) tarihli kur. APPEND-ONLY.
-- price_verification:    beslemeden BAGIMSIZ dogrulama sonucu. APPEND-ONLY.
-- price_verification_request: dogrulama kuyrugu (durum kolonlari guncellenir).

-- Kur. Kaynagin kendi tarihiyle (`effective_date`) ve cekilme zamaniyla saklanir;
-- gosterim "yaklasik" etiketi, kaynak ve tarihle yapilir. Kur yoksa donusum YOK.
CREATE TABLE fx_rate (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source          TEXT        NOT NULL CHECK (source IN ('tcmb')),
    base            CHAR(3)     NOT NULL CHECK (base ~ '^[A-Z]{3}$'),
    quote           CHAR(3)     NOT NULL CHECK (quote ~ '^[A-Z]{3}$'),
    -- 1 birim `base` = `rate` birim `quote` (TCMB "Unit" bolunmus).
    rate            NUMERIC(20, 8) NOT NULL CHECK (rate > 0),
    rate_kind       TEXT        NOT NULL CHECK (rate_kind IN ('forex_selling', 'forex_buying')),
    effective_date  DATE        NOT NULL,
    -- Kaynagin bulten kimligi (or. TCMB "2026/194").
    bulletin        TEXT        CHECK (bulletin IS NULL OR char_length(bulletin) <= 40),
    fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fx_rate_uniq UNIQUE (source, base, quote, rate_kind, effective_date)
);
CREATE INDEX fx_rate_latest_idx ON fx_rate (base, quote, rate_kind, effective_date DESC);

-- Dogrulama sonucu. Besleme fiyatindan AYRI saklanir: kaynak, para birimi,
-- varyant ve satici, zaman, sonuc, kaynak guvenilirligi, kosullar.
-- Izinli dogrulama kaynagi yoksa satir YAZILMAZ (sahte sonuc yok).
CREATE TABLE price_verification (
    id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    offer_id              BIGINT      NOT NULL REFERENCES offer(id) ON DELETE CASCADE,
    offer_variant_id      BIGINT      REFERENCES offer_variant(id) ON DELETE CASCADE,
    seller_id             BIGINT      REFERENCES seller(id),
    -- Saglayici adi (or. 'shopify_product_js').
    provider              TEXT        NOT NULL CHECK (provider ~ '^[a-z0-9_]{2,40}$'),
    source_kind           TEXT        NOT NULL
                          CHECK (source_kind IN ('merchant_storefront', 'merchant_api', 'affiliate_api')),
    -- 0-100: kaynagin fiyat icin guvenilirligi (saglayici tanimlar).
    source_reliability    SMALLINT    NOT NULL CHECK (source_reliability BETWEEN 0 AND 100),
    verified_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- match: besleme fiyatiyla ayni; mismatch: farkli; unavailable: urun/varyant
    -- satista degil ya da bulunamadi; error: kaynak cevap vermedi.
    result                TEXT        NOT NULL CHECK (result IN ('match', 'mismatch', 'unavailable', 'error')),
    currency              CHAR(3)     CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
    observed_price_minor  BIGINT      CHECK (observed_price_minor IS NULL OR observed_price_minor > 0),
    list_price_minor      BIGINT      CHECK (list_price_minor IS NULL OR list_price_minor > 0),
    -- Dogrulama anindaki besleme fiyati (karsilastirma izi).
    feed_price_minor      BIGINT      CHECK (feed_price_minor IS NULL OR feed_price_minor > 0),
    in_stock              BOOLEAN,
    -- Kosullar: kaynak vermiyorsa NULL (bilinmiyor), uydurulmaz.
    shipping_minor        BIGINT      CHECK (shipping_minor IS NULL OR shipping_minor >= 0),
    tax_included          BOOLEAN,
    discount_conditions   JSONB       CHECK (discount_conditions IS NULL OR jsonb_typeof(discount_conditions) = 'object'),
    coupon_conditions     JSONB       CHECK (coupon_conditions IS NULL OR jsonb_typeof(coupon_conditions) = 'object'),
    error_code            TEXT        CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{2,60}$'),
    CONSTRAINT price_verification_observed CHECK (
        result NOT IN ('match', 'mismatch') OR (observed_price_minor IS NOT NULL AND currency IS NOT NULL)
    )
);
CREATE INDEX price_verification_offer_idx ON price_verification (offer_id, verified_at DESC);

-- Kuyruk. TS taraf yalnizca satir ekler (mimari sinir: Python'u cagirmaz);
-- Python iscisi SKIP LOCKED ile alir.
CREATE TABLE price_verification_request (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    offer_id         BIGINT      NOT NULL REFERENCES offer(id) ON DELETE CASCADE,
    reason           TEXT        NOT NULL CHECK (reason IN ('stale', 'viewed', 'manual', 'price_change')),
    priority         SMALLINT    NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 9),
    status           TEXT        NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'running', 'done', 'failed', 'unsupported')),
    attempts         SMALLINT    NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error       TEXT        CHECK (last_error IS NULL OR last_error ~ '^[a-z0-9_]{2,60}$'),
    verification_id  BIGINT      REFERENCES price_verification(id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Offer basina tek acik istek.
CREATE UNIQUE INDEX price_verification_request_open_uniq
    ON price_verification_request (offer_id) WHERE status IN ('pending', 'running');
CREATE INDEX price_verification_request_due_idx
    ON price_verification_request (priority DESC, next_attempt_at) WHERE status = 'pending';

REVOKE UPDATE, DELETE, TRUNCATE ON fx_rate            FROM arilla_app;
REVOKE UPDATE, DELETE, TRUNCATE ON price_verification FROM arilla_app;
