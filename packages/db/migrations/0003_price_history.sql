-- 0003 — fiyat gecmisi
-- docs/schema.sql referans belgesinden bire bir tasindi.

-- ---------------------------------------------------------------------------
-- FİYAT GEÇMİŞİ — sadece INSERT. Rakibin geriye dönük üretemeyeceği varlık.
-- Aya göre partition. İlk günden toplanmaya başlanmalı.
-- ---------------------------------------------------------------------------

CREATE TABLE price_point (
    offer_id    BIGINT      NOT NULL REFERENCES offer(id),
    observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    price       BIGINT      NOT NULL,
    list_price  BIGINT,
    in_stock    BOOLEAN     NOT NULL,
    PRIMARY KEY (offer_id, observed_at)
) PARTITION BY RANGE (observed_at);

-- Partition'lar aylık olarak önceden oluşturulur (cron veya pg_partman).
CREATE TABLE price_point_2026_09 PARTITION OF price_point
    FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE price_point_2026_10 PARTITION OF price_point
    FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');

-- Guvenlik agi. NORMAL DURUM: bos. Dolu ise aylik partition cron'u
-- calismamis demektir; kritik uyari uretir. Bkz. docs/ops.md.
CREATE TABLE price_point_default PARTITION OF price_point DEFAULT;

CREATE INDEX price_point_offer_time_idx ON price_point (offer_id, observed_at DESC);

-- Gece toplu işiyle doldurulur. İstek yolu fiyat geçmişini taramaz, burayı okur.
-- "Şu an iyi fiyat mı?" ve sahte indirim tespiti bu tablodan cevaplanır.
CREATE TABLE product_price_stats (
    product_id       BIGINT      PRIMARY KEY REFERENCES product(id),
    min_30d          BIGINT,
    min_90d          BIGINT,
    max_90d          BIGINT,
    median_90d       BIGINT,
    current_percentile SMALLINT,             -- 0 = son 90 günün en düşüğü
    drop_count_90d   SMALLINT,               -- kaç kez düştü
    last_drop_at     TIMESTAMPTZ,
    -- sahte indirim sinyali: liste fiyatı indirimden hemen önce yükseltilmiş mi
    list_price_inflated BOOLEAN  NOT NULL DEFAULT FALSE,
    list_price_raised_at TIMESTAMPTZ,
    computed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
