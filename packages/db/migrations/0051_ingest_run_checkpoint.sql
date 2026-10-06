-- 0051 — Toplama kosusu icin kalici checkpoint (docs/decisions/0065)
--
-- Buyuk Shopify katalogu tek islemde yazilirken uzak baglanti kopuyor (42 dk,
-- north-sails-turkiye) ve tum is geri aliniyordu. Toplama artik parca parca
-- commit eder; her commit ayni islemde bu satirdaki checkpoint'i ilerletir.
--
--   updated_at  son checkpoint/heartbeat; `running` ama bayat satir = olu surec.
--   checkpoint  JSONB, kucuk ve duz: { state, observed_at, chunks,
--               offers_committed, last_external_id, resumable, resumed_from }.
--               Ham Shopify yaniti ASLA buraya girmez.
--
-- Yalnizca ekleme; `status` CHECK'i degismez. Yarim kalan ama devam
-- ettirilebilir kosu `status = 'partial'` + `checkpoint.resumable = true`;
-- `success` yalnizca tum katalog bittiginde yazilir. Eski satirlar `checkpoint`
-- NULL kalir, kod NULL'u "devam ettirilemez" sayar. Geriye uyumludur.

ALTER TABLE ingest_run
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS checkpoint JSONB;

COMMENT ON COLUMN ingest_run.updated_at IS
    'Son checkpoint/heartbeat (0065). running + bayat = olu surec, devam ettirilebilir.';
COMMENT ON COLUMN ingest_run.checkpoint IS
    'Kucuk duz JSON (0065): state, observed_at, chunks, offers_committed, resumable. Ham payload yok.';
