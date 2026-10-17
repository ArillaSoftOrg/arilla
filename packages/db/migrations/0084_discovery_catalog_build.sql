-- kind: schema
-- 0084 — kesif defterinden taslak urun aktarimi icin kontrol noktasi (karar 0130)
--
-- `catalog_build build-discovery` sitemap kesif defterini (`catalog_discovery`, 0073)
-- parti parti okuyup TASLAK urun uretir (`product.publication_state = 'draft'`,
-- `source_offer_id` NULL). Fiyat yoktur ve uydurulmaz: kalite kapisi bu urunleri
-- `held(source_offer_missing)` tutar; fiyatli kaynak teklif gelince bag kurulur.
--
-- `catalog_build_state` (0074) teklif kimligiyle (`last_offer_id BIGINT`) ilerler;
-- kesif defterinin anahtari metindir (`(source, external_id)`), bu yuzden ayri ve kucuk
-- bir kontrol noktasi tablosu. Parti ve kontrol noktasi AYNI islemde yazilir.
--
-- GERIYE UYUMLU / YALNIZCA EKLEME: yeni tablo; mevcut tablolara dokunulmaz.

CREATE TABLE catalog_discovery_build_state (
    source            TEXT        PRIMARY KEY REFERENCES collection_source(source),
    -- Anahtar sirali tarama: `external_id > last_external_id` (PK on eki).
    last_external_id  TEXT        NOT NULL DEFAULT ''
                      CHECK (char_length(last_external_id) <= 100),
    scanned           BIGINT      NOT NULL DEFAULT 0 CHECK (scanned >= 0),
    created           BIGINT      NOT NULL DEFAULT 0 CHECK (created >= 0),
    existing          BIGINT      NOT NULL DEFAULT 0 CHECK (existing >= 0),
    skipped           JSONB       NOT NULL DEFAULT '{}'::jsonb
                      CHECK (jsonb_typeof(skipped) = 'object'),
    started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at      TIMESTAMPTZ
);

COMMENT ON TABLE catalog_discovery_build_state IS
    'Kesif defterinden taslak urun aktarimi kontrol noktasi (kaynak basina). Karar 0130.';
