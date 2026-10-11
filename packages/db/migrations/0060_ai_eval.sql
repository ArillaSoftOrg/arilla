-- 0060 — AI degerlendirme ve hata veri seti (docs/decisions/0096, Faz 1A-2)
--
-- Faz 1A-1'in cevrimdisi degerlendirme ciktisini (metrik, vaka sonucu) ve model
-- cagrisi hatalarini kalici tutar. YENIDEN KURULMAYANLAR:
--   * maliyet           -> `api_usage` (kaynak dogruluk; burada yalnizca ozet)
--   * is kosusu         -> `job_run` (opsiyonel FK)
--   * eslestirme reddi  -> `match_candidate.review_reason` (0028) zaten var
--   * dogru etiketler   -> depodaki fixture dosyalari (git surumlu); tabloya
--                          KOPYALANMAZ
--
-- KVKK / kural 10: ham sorgu, sohbet metni, gorsel, kullanici kimligi YOKTUR.
-- Vaka anahtari fixture metninin SHA-256 oneki (`case_key`); ayrintilar kisa,
-- sirsiz, boyut sinirli. Hata olayinda kullanici/oturum alani yoktur.
--
-- Yetkiler: dataset_snapshot, ai_eval_run, ai_eval_case degistirilemez
-- (duzeltme = yeni satir). ai_error_event: UPDATE yok, DELETE saklama suresi
-- (180 gun) icin acik.
-- Yalnizca ekleme; geri alma DROP TABLE (sirasiyla case, run, snapshot, error).

CREATE TABLE IF NOT EXISTS dataset_snapshot (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    dataset         TEXT        NOT NULL
                    CHECK (dataset IN ('matching','search','intent','image')),
    version         TEXT        NOT NULL CHECK (version ~ '^[A-Za-z0-9._-]{1,40}$'),
    content_sha256  TEXT        NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    verified_count  INTEGER     NOT NULL CHECK (verified_count >= 0),
    candidate_count INTEGER     NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
    code_ref        TEXT        CHECK (code_ref IS NULL OR code_ref ~ '^[0-9a-f]{7,64}$'),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT dataset_snapshot_content_uniq UNIQUE (dataset, content_sha256)
);

CREATE TABLE IF NOT EXISTS ai_eval_run (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    snapshot_id       BIGINT      NOT NULL REFERENCES dataset_snapshot(id),
    component         TEXT        NOT NULL
                      CHECK (component IN ('gemini_intent','jina_image','matching','search')),
    algorithm_version TEXT        NOT NULL CHECK (char_length(algorithm_version) BETWEEN 1 AND 80),
    model_version     TEXT        CHECK (model_version IS NULL OR char_length(model_version) <= 80),
    trigger           TEXT        NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual','ci','cron')),
    -- TRUE = gercek saglayici cagrisi yapildi (maliyet api_usage'ta).
    live              BOOLEAN     NOT NULL DEFAULT FALSE,
    job_run_id        BIGINT      REFERENCES job_run(id) ON DELETE SET NULL,
    baseline_run_id   BIGINT      REFERENCES ai_eval_run(id),
    regressed         BOOLEAN,
    metrics           JSONB       NOT NULL
                      CHECK (jsonb_typeof(metrics) = 'object' AND pg_column_size(metrics) <= 4096),
    api_calls         INTEGER     NOT NULL DEFAULT 0 CHECK (api_calls >= 0),
    cost_micros       BIGINT      NOT NULL DEFAULT 0 CHECK (cost_micros >= 0),
    latency_p50_ms    INTEGER     CHECK (latency_p50_ms IS NULL OR latency_p50_ms >= 0),
    latency_p95_ms    INTEGER     CHECK (latency_p95_ms IS NULL OR latency_p95_ms >= 0),
    duration_ms       INTEGER     CHECK (duration_ms IS NULL OR duration_ms >= 0),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Cevrimdisi kosu para harcamaz.
    CONSTRAINT ai_eval_run_offline_free CHECK (live OR (api_calls = 0 AND cost_micros = 0))
);
CREATE INDEX IF NOT EXISTS ai_eval_run_component_idx ON ai_eval_run (component, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_eval_run_snapshot_idx ON ai_eval_run (snapshot_id);

CREATE TABLE IF NOT EXISTS ai_eval_case (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id        BIGINT      NOT NULL REFERENCES ai_eval_run(id) ON DELETE CASCADE,
    -- Fixture metninin SHA-256 oneki; metnin kendisi tutulmaz.
    case_key      TEXT        NOT NULL CHECK (case_key ~ '^[0-9a-f]{16,64}$'),
    outcome       TEXT        NOT NULL CHECK (outcome IN ('pass','fail','error','skipped')),
    -- Kisa sinif adi: 'wrong_action','false_match','zero_result','low_rank', ...
    failure_class TEXT        CHECK (failure_class IS NULL OR failure_class ~ '^[a-z][a-z0-9_]{1,39}$'),
    score         REAL,
    latency_ms    INTEGER     CHECK (latency_ms IS NULL OR latency_ms >= 0),
    detail        JSONB       NOT NULL DEFAULT '{}'::jsonb
                  CHECK (jsonb_typeof(detail) = 'object' AND pg_column_size(detail) <= 1024),
    CONSTRAINT ai_eval_case_uniq UNIQUE (run_id, case_key),
    CONSTRAINT ai_eval_case_failure_class CHECK (outcome IN ('fail','error') OR failure_class IS NULL)
);
CREATE INDEX IF NOT EXISTS ai_eval_case_failed_idx ON ai_eval_case (failure_class)
    WHERE outcome IN ('fail','error');

CREATE TABLE IF NOT EXISTS ai_error_event (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    provider       TEXT        NOT NULL CHECK (provider IN ('gemini','jina','other')),
    -- api_usage.operation ile ayni adlandirma.
    operation      TEXT        NOT NULL CHECK (operation ~ '^[a-z][a-z0-9_]{1,59}$'),
    surface        TEXT        NOT NULL
                   CHECK (surface IN ('chat','search','ingest','enrich','eval')),
    error_class    TEXT        NOT NULL
                   CHECK (error_class IN ('timeout','rate_limited','quota','auth','bad_request',
                          'schema_invalid','safety_blocked','empty_output','server_error',
                          'network','unknown')),
    http_status    SMALLINT    CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
    latency_ms     INTEGER     CHECK (latency_ms IS NULL OR latency_ms >= 0),
    model_version  TEXT        CHECK (model_version IS NULL OR char_length(model_version) <= 80),
    api_usage_id   BIGINT      REFERENCES api_usage(id) ON DELETE SET NULL,
    job_run_id     BIGINT      REFERENCES job_run(id) ON DELETE SET NULL,
    -- Sirsiz kisa ozet (job_run.error_summary ile ayni maskeleme).
    error_summary  TEXT        CHECK (error_summary IS NULL OR char_length(error_summary) <= 300)
);
CREATE INDEX IF NOT EXISTS ai_error_event_provider_idx
    ON ai_error_event (provider, error_class, occurred_at DESC);

REVOKE UPDATE, DELETE, TRUNCATE ON dataset_snapshot FROM arilla_app;
REVOKE UPDATE, DELETE, TRUNCATE ON ai_eval_run      FROM arilla_app;
REVOKE UPDATE, DELETE, TRUNCATE ON ai_eval_case     FROM arilla_app;
REVOKE UPDATE, TRUNCATE          ON ai_error_event  FROM arilla_app;
