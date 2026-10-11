-- 0063 — Data Intelligence MVP (docs/decisions/0102)
--
-- Anonimlestirilmis, toplulastirilmis alisveris egilimi veri setlerinin SURUMLU
-- uretimi, kalite raporu, dahili disa aktarim kaydi ve dogruluk etiketleri.
-- YENIDEN KURULMAYANLAR:
--   * olaylar         -> `user_activity_event` (0036/0061; kaynak, DEGISMEZ)
--   * denetim         -> `admin_audit_event` (0027)
--   * AI degerlendirme parmak izi -> `dataset_snapshot` (0060) AI fixture'lari icindir
--                        (dataset CHECK'i 4 degerlidir); ticari veri seti surumu ayri tablodur.
--
-- KVKK / kural 10: bu tablolarda kullanici kimligi, oturum, IP, sorgu metni,
-- gorsel ya da gorsel adresi YOKTUR. `di_dataset_build.rows` yalnizca k-esikli
-- toplulastirilmis hucreler (kategori yolu, marka slug'i, fiyat bandi, hafta,
-- olay sayisi, kisi bandi) tasir. Kaynak olaylar rizayla toplanmistir ve
-- ticari lisans amaci icin hukuki dayanak DOGRULANMAMISTIR (docs/kvkk.md);
-- bu yuzden olusturma ve disa aktarim bayrakla kapalidir.
--
-- Yetkiler: di_dataset_build degistirilemez (duzeltme = yeni surum). di_export
-- yalnizca durum gecisi kolonlari guncellenir. di_accuracy_label yalnizca karar
-- kolonlari guncellenir. Yalnizca ekleme; geri alma DROP TABLE (label, export, build).

CREATE TABLE IF NOT EXISTS di_dataset_build (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    dataset_key       TEXT        NOT NULL
                      CHECK (dataset_key IN ('category_trends','brand_interest_trends',
                                             'price_range_trends','alternative_search_trends')),
    -- '<spec surumu>+<donem baslangici>_<donem sonu>.b<n>' (kodda uretilir).
    version           TEXT        NOT NULL
                      CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+\+[0-9]{8}_[0-9]{8}\.b[0-9]{1,4}$'),
    spec_version      TEXT        NOT NULL CHECK (spec_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
    generator_version TEXT        NOT NULL CHECK (char_length(generator_version) BETWEEN 1 AND 40),
    -- [period_start, period_end) UTC; en fazla 93 gun.
    period_start      DATE        NOT NULL,
    period_end        DATE        NOT NULL,
    status            TEXT        NOT NULL
                      CHECK (status IN ('ready','insufficient_data','blocked','failed')),
    -- 'ready' disindaki durumun sabit nedeni (serbest metin degil).
    status_reason     TEXT        CHECK (status_reason IS NULL OR status_reason ~ '^[a-z][a-z0-9_:]{1,79}$'),
    row_count         INTEGER     NOT NULL DEFAULT 0 CHECK (row_count BETWEEN 0 AND 20000),
    rows              JSONB       NOT NULL DEFAULT '[]'::jsonb
                      CHECK (jsonb_typeof(rows) = 'array' AND pg_column_size(rows) <= 6000000),
    content_sha256    TEXT        CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
    source_max_event_at TIMESTAMPTZ,
    lineage           JSONB       NOT NULL DEFAULT '{}'::jsonb
                      CHECK (jsonb_typeof(lineage) = 'object' AND pg_column_size(lineage) <= 16384),
    quality_report    JSONB       NOT NULL DEFAULT '{}'::jsonb
                      CHECK (jsonb_typeof(quality_report) = 'object' AND pg_column_size(quality_report) <= 32768),
    anonymity         JSONB       NOT NULL DEFAULT '{}'::jsonb
                      CHECK (jsonb_typeof(anonymity) = 'object' AND pg_column_size(anonymity) <= 8192),
    -- Teknik kontroller gecti mi. Hukuki kapi disa aktarim anindaki politikadan okunur.
    anonymity_ok      BOOLEAN     NOT NULL DEFAULT FALSE,
    created_by        BIGINT      REFERENCES app_user(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT di_dataset_build_period CHECK (period_end > period_start
                      AND period_end - period_start <= 93),
    CONSTRAINT di_dataset_build_version_uniq UNIQUE (dataset_key, version),
    CONSTRAINT di_dataset_build_ready_shape CHECK (
        (status = 'ready' AND content_sha256 IS NOT NULL AND row_count > 0 AND status_reason IS NULL)
        OR (status <> 'ready' AND status_reason IS NOT NULL AND anonymity_ok = FALSE)
    ),
    CONSTRAINT di_dataset_build_rowcount CHECK (row_count = jsonb_array_length(rows))
);
CREATE INDEX IF NOT EXISTS di_dataset_build_key_idx
    ON di_dataset_build (dataset_key, created_at DESC);

CREATE TABLE IF NOT EXISTS di_export (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    build_id      BIGINT      NOT NULL REFERENCES di_dataset_build(id),
    requested_by  BIGINT      REFERENCES app_user(id) ON DELETE SET NULL,
    status        TEXT        NOT NULL DEFAULT 'requested'
                  CHECK (status IN ('requested','completed','failed','cancelled')),
    -- [{name, bytes, sha256}] — dosya ICERIGI saklanmaz, surumden yeniden uretilir.
    manifest      JSONB       NOT NULL DEFAULT '[]'::jsonb
                  CHECK (jsonb_typeof(manifest) = 'array' AND pg_column_size(manifest) <= 8192),
    -- Disa aktarim anindaki dogruluk etiketi ozeti (yeniden uretimi sabitler).
    accuracy_snapshot JSONB   NOT NULL DEFAULT '{}'::jsonb
                  CHECK (jsonb_typeof(accuracy_snapshot) = 'object' AND pg_column_size(accuracy_snapshot) <= 4096),
    error_class   TEXT        CHECK (error_class IS NULL OR error_class ~ '^[a-z][a-z0-9_]{1,39}$'),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at   TIMESTAMPTZ,
    CONSTRAINT di_export_terminal_shape CHECK (
        (status = 'requested' AND finished_at IS NULL)
        OR (status <> 'requested' AND finished_at IS NOT NULL)
    ),
    CONSTRAINT di_export_failed_class CHECK ((status = 'failed') = (error_class IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS di_export_build_idx ON di_export (build_id, created_at DESC);
CREATE INDEX IF NOT EXISTS di_export_recent_idx ON di_export (created_at DESC);

-- Dogruluk degerlendirmesi: URUN (kategori/marka atamasi) ornegi. Kullanici veya
-- olay icermez; etiketleyici yalnizca katalogdaki atamanin dogru olup olmadigina bakar.
CREATE TABLE IF NOT EXISTS di_accuracy_label (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    build_id      BIGINT      NOT NULL REFERENCES di_dataset_build(id),
    product_id    BIGINT      NOT NULL REFERENCES product(id),
    field         TEXT        NOT NULL CHECK (field IN ('category','brand')),
    assigned_value TEXT       NOT NULL CHECK (char_length(assigned_value) BETWEEN 1 AND 120),
    sample_seed   TEXT        NOT NULL CHECK (char_length(sample_seed) BETWEEN 1 AND 64),
    verdict       TEXT        CHECK (verdict IS NULL OR verdict IN ('correct','incorrect','unsure')),
    labeled_by    BIGINT      REFERENCES app_user(id) ON DELETE SET NULL,
    labeled_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT di_accuracy_label_uniq UNIQUE (build_id, product_id, field),
    CONSTRAINT di_accuracy_label_decided CHECK ((verdict IS NULL) = (labeled_at IS NULL))
);
CREATE INDEX IF NOT EXISTS di_accuracy_label_build_idx ON di_accuracy_label (build_id);

REVOKE UPDATE, DELETE, TRUNCATE ON di_dataset_build FROM arilla_app;
REVOKE UPDATE, DELETE, TRUNCATE ON di_export FROM arilla_app;
GRANT  UPDATE (status, manifest, accuracy_snapshot, error_class, finished_at)
       ON di_export TO arilla_app;
REVOKE UPDATE, DELETE, TRUNCATE ON di_accuracy_label FROM arilla_app;
GRANT  UPDATE (verdict, labeled_by, labeled_at) ON di_accuracy_label TO arilla_app;
