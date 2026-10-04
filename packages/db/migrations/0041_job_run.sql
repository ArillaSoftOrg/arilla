-- 0041 — operasyonel is kosusu gecmisi (docs/decisions/0052)
--
-- Boru hattinin isleri (python -m collect/resolve/enrich/similarity ...) ve
-- zamanlanmis uclar (discovery, temizlik, alarm, pazarlama) elle ya da cron'la
-- calisir; 0051'deki "son kanit" verinin zamanindan tahmin ediyordu. Bu tablo
-- her kosunun baslangic/bitis/durumunu dogrudan tutar.
--
-- Kapsam: ISLETIM sinyali. Denetim kaydi (`admin_audit_event`), analitik ya da
-- genel log tablosu DEGILDIR. `detail` kucuk, duz sayilar (koşu basina en fazla
-- 4 KB); `error_summary` kisa ve sirsiz (adresler kirpilir, en fazla 500
-- karakter). Yeniden deneme / simdi calistir YOK: gozlem once.
--
-- `ingest_run` (magaza basina toplama) aynen kalir; `job_run` bir toplama
-- cagrisinin tamami (birden cok magaza) icindir.
--
-- Saklama: 180 gun; gunluk temizlik cron'u siler.
-- Yalnizca ekleme; geri alinmasi DROP TABLE.

CREATE TABLE IF NOT EXISTS job_run (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job           TEXT        NOT NULL CHECK (job ~ '^[a-z][a-z0-9_]{1,39}$'),
    trigger       TEXT        NOT NULL DEFAULT 'manual'
                  CHECK (trigger IN ('manual','cron','worker')),
    status        TEXT        NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running','success','partial','failed')),
    started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at   TIMESTAMPTZ,
    detail        JSONB       NOT NULL DEFAULT '{}'::jsonb
                  CHECK (jsonb_typeof(detail) = 'object' AND pg_column_size(detail) <= 4096),
    error_summary TEXT        CHECK (error_summary IS NULL OR char_length(error_summary) <= 500),
    CONSTRAINT job_run_finished CHECK ((status = 'running') = (finished_at IS NULL))
);

-- Is basina son kosular (`/yonetim/islemler`, genel bakis).
CREATE INDEX IF NOT EXISTS job_run_job_idx ON job_run (job, started_at DESC);
