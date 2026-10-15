-- kind: schema
-- 0074 — Sitemap ile urun kesfi: fiyatsiz kesif defteri, ilk aktarim / haftalik yenileme
-- operasyonlari, dosya birimleri ve istek defteri (karar 0120; 0117 kota defteri AYNEN kullanilir).
--
-- YALNIZCA EKLEME. Mevcut tablolar, satirlar ve tetikleyiciler DEGISMEZ:
--   * collection_source / collection_run / collection_unit / catalog_intake_record'a dokunulmaz
--     (kosu #1 ve kota defteri oldugu gibi kalir).
--   * offer / product / price_point anlami degismez. Kesif kaydi offer DEGILDIR; fiyat kolonu
--     yoktur. Fiyat yalnizca dogrulanmis kaynak kaydindan (catalog_intake_record -> offer ->
--     price_point) gelir; burada yalnizca DURUMU ve hangi teklife bagli oldugu izlenir.
--
-- Operasyon turleri (kullanici karari, 2026-10-15):
--   initial_import   ilk kapsamli aktarim. Haftalik kota hakki HARCAMAZ (collection_run
--                    yazmaz); kendi istek/bayt/gunluk butcesiyle sinirlidir. Kaynak basina
--                    iptal edilmemis tek ilk aktarim olabilir.
--   weekly_refresh   haftalik yenileme. Operasyon basina TEK collection_run satiri rezerve
--                    eder (0070 tetikleyicisi: >= 7 gun aralik, takvim ayinda <= 4). Her sitemap
--                    dosyasi ayri hak SAYILMAZ.
--
-- Sinirsiz erisim varsayilmaz: istek araligi, gunluk istek tavani, operasyon basina istek ve
-- bayt tavani politikadan gelir ve SUNUCUDA zorlanir (istemci her istekten once hak alir).
-- Politika varsayilan KAPALIDIR; yalnizca sahip rol/migration acar.

-- ---------------------------------------------------------------------------
-- 1) KESIF POLITIKASI (kaynak basina; uygulama rolu yalnizca okur)
-- ---------------------------------------------------------------------------
CREATE TABLE discovery_source_policy (
    source                  TEXT        PRIMARY KEY REFERENCES collection_source(source),
    enabled                 BOOLEAN     NOT NULL DEFAULT FALSE,
    -- Kesfin baslangici: kaynagin urun sitemap indeksi.
    index_url               TEXT        NOT NULL CHECK (char_length(index_url) <= 500
                                                        AND index_url ~ '^https://'),
    -- Indeksteki dosya adreslerinin uymasi gereken yol deseni (baska yola istek atilmaz).
    file_path_pattern       TEXT        NOT NULL CHECK (char_length(file_path_pattern) <= 200),
    url_host                TEXT        NOT NULL CHECK (url_host ~ '^[a-z0-9.-]{3,100}$'),
    image_host              TEXT        NOT NULL CHECK (image_host ~ '^[a-z0-9.-]{3,100}$'),
    -- Ardisik iki kaynak istegi arasi en az sure (sunucu hak verirken zorlar).
    min_request_interval_ms INTEGER     NOT NULL DEFAULT 5000 CHECK (min_request_interval_ms >= 2000),
    -- Kayan 24 saatte kaynak basina en fazla istek (tum operasyonlar toplami).
    daily_max_requests      INTEGER     NOT NULL DEFAULT 2500 CHECK (daily_max_requests >= 1),
    -- Operasyon basina istek ve acilmis (sikistirilmamis) bayt tavani.
    initial_max_requests    INTEGER     NOT NULL CHECK (initial_max_requests >= 1),
    initial_max_bytes       BIGINT      NOT NULL CHECK (initial_max_bytes > 0),
    refresh_max_requests    INTEGER     NOT NULL CHECK (refresh_max_requests >= 1),
    refresh_max_bytes       BIGINT      NOT NULL CHECK (refresh_max_bytes > 0),
    -- Bir dosyanin en fazla deneme sayisi (ag hatasi / bozuk icerik). Sonra 'failed' kalir.
    max_attempts_per_file   SMALLINT    NOT NULL DEFAULT 3 CHECK (max_attempts_per_file BETWEEN 1 AND 5),
    -- Engel (403/429/dogrulama sayfasi) sonrasi yonetici en erken bu kadar saat sonra surdurebilir.
    blocked_cooldown_hours  SMALLINT    NOT NULL DEFAULT 24 CHECK (blocked_cooldown_hours >= 1),
    -- Urun ancak bu kadar ARDISIK TAM haftalik taramada gorulmezse 'removed' sayilir (>= 2).
    removal_missed_scans    SMALLINT    NOT NULL DEFAULT 2 CHECK (removal_missed_scans >= 2),
    -- Panel gostergesi; durma kosulu DEGILDIR.
    target_unique_items     BIGINT      NOT NULL DEFAULT 8000000 CHECK (target_unique_items > 0),
    note                    TEXT        CHECK (note IS NULL OR char_length(note) <= 500),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE discovery_source_policy IS
    'Sitemap kesif butceleri (karar 0120). Varsayilan kapali; yalnizca sahip rol degistirir.';

-- Hepsiburada: 2026-10-15 olcumu ~7.470 dosya x 10.000 URL, dosya basina 9-12 MB acik metin
-- (~78 GB). Butceler bunu bir kez taramaya yetecek kadardir, sinirsiz degildir.
INSERT INTO discovery_source_policy
    (source, enabled, index_url, file_path_pattern, url_host, image_host,
     min_request_interval_ms, daily_max_requests,
     initial_max_requests, initial_max_bytes, refresh_max_requests, refresh_max_bytes, note)
SELECT 'hepsiburada', FALSE,
       'https://www.hepsiburada.com/sitemaps/product/sitemap.xml',
       '^/sitemaps/product/[A-Za-z0-9_.-]{1,120}$',
       'hepsiburada.com', 'hepsiburada.net',
       5000, 2500,
       8000, 107374182400, 8000, 107374182400,
       'Kullanici karari 2026-10-15: ilk aktarim haftalik kotadan ayri; yenileme >= 7 gun, ayda <= 4. '
       || 'Izin belgeleri bagimsiz incelenmedi (0070 notu).'
 WHERE EXISTS (SELECT 1 FROM collection_source WHERE source = 'hepsiburada');

-- ---------------------------------------------------------------------------
-- 2) OPERASYON (ilk aktarim / haftalik yenileme)
-- ---------------------------------------------------------------------------
CREATE TABLE catalog_sync_operation (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source             TEXT        NOT NULL REFERENCES discovery_source_policy(source),
    kind               TEXT        NOT NULL CHECK (kind IN ('initial_import', 'weekly_refresh')),
    --   open       calisabilir (bir istemci hak alabilir)
    --   paused     yonetici duraklatti
    --   blocked    kaynak engel gosterdi (403/429/dogrulama); bekleme suresinden sonra elle surdurulur
    --   completed  tum dosyalar islendi (bazilari 'failed' kalmis olabilir; ozet soyler)
    --   cancelled  yonetici iptal etti
    --   expired    haftalik yenilemenin kota penceresi doldu
    status             TEXT        NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open', 'paused', 'blocked', 'completed', 'cancelled', 'expired')),
    -- Haftalik yenilemenin kota defteri satiri (tek hak). Ilk aktarimda NULL.
    quota_run_id       BIGINT      UNIQUE REFERENCES collection_run(id),
    started_by         BIGINT      REFERENCES app_user(id) ON DELETE SET NULL,
    -- Yoneticinin beyan ettigi ag (mobil veri ile buyuk aktarim baslatilmaz). Dogrulanamaz, beyandir.
    network_declared   TEXT        NOT NULL CHECK (network_declared IN ('wifi', 'wired')),
    -- Tetikleyici politikadan yazar; istemci belirleyemez.
    max_requests       INTEGER     NOT NULL CHECK (max_requests >= 1),
    max_bytes          BIGINT      NOT NULL CHECK (max_bytes > 0),
    requests_made      INTEGER     NOT NULL DEFAULT 0 CHECK (requests_made >= 0),
    -- Acilmis govde bayti (istemci olcer) ve bilinen aktarim bayti (Content-Length; yoksa 0).
    bytes_decoded      BIGINT      NOT NULL DEFAULT 0 CHECK (bytes_decoded >= 0),
    bytes_transferred  BIGINT      NOT NULL DEFAULT 0 CHECK (bytes_transferred >= 0),
    files_planned      INTEGER     NOT NULL DEFAULT 0 CHECK (files_planned >= 0),
    index_planned_at   TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at         TIMESTAMPTZ,
    last_request_at    TIMESTAMPTZ,
    last_checkpoint_at TIMESTAMPTZ,
    last_success_at    TIMESTAMPTZ,
    blocked_at         TIMESTAMPTZ,
    closed_at          TIMESTAMPTZ,
    -- Calisan istemci kirasi: hangi tarayici oturumu hak alabilir ve son sinyali. Kira suresi
    -- dolunca operasyon "calisan istemci yok" gorunur; baska istemci ancak ACIKCA devralir.
    lease_client       TEXT        CHECK (lease_client IS NULL OR lease_client ~ '^[A-Za-z0-9_-]{8,64}$'),
    lease_heartbeat_at TIMESTAMPTZ,
    -- Kaldirilma degerlendirmesi (yalnizca TAM haftalik taramada, Python `discovery-finalize`).
    removal_state      TEXT        NOT NULL DEFAULT 'not_applicable'
                       CHECK (removal_state IN ('not_applicable', 'pending', 'done', 'skipped_partial')),
    last_error_code    TEXT        CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]{2,60}$'),
    last_error_detail  TEXT        CHECK (last_error_detail IS NULL OR char_length(last_error_detail) <= 300),
    summary            JSONB       CHECK (summary IS NULL OR (jsonb_typeof(summary) = 'object'
                                                              AND pg_column_size(summary) <= 16384)),
    CONSTRAINT catalog_sync_operation_quota_kind
        CHECK ((kind = 'weekly_refresh') = (quota_run_id IS NOT NULL)),
    CONSTRAINT catalog_sync_operation_budget CHECK (requests_made <= max_requests),
    CONSTRAINT catalog_sync_operation_closed
        CHECK ((status IN ('open', 'paused', 'blocked')) = (closed_at IS NULL)),
    CONSTRAINT catalog_sync_operation_blocked_at CHECK (status <> 'blocked' OR blocked_at IS NOT NULL)
);
-- Kaynak basina tek etkin operasyon (ilk aktarim ile yenileme ust uste binmez).
CREATE UNIQUE INDEX catalog_sync_operation_one_active_uniq
    ON catalog_sync_operation (source) WHERE status IN ('open', 'paused', 'blocked');
-- Kaynak basina iptal edilmemis tek ilk aktarim.
CREATE UNIQUE INDEX catalog_sync_operation_one_initial_uniq
    ON catalog_sync_operation (source) WHERE kind = 'initial_import' AND status <> 'cancelled';
CREATE INDEX catalog_sync_operation_source_idx ON catalog_sync_operation (source, created_at DESC);

COMMENT ON TABLE catalog_sync_operation IS
    'Sitemap kesif operasyonu (karar 0120): initial_import kotadan ayri; weekly_refresh tek collection_run hakki.';

CREATE FUNCTION catalog_sync_operation_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    pol discovery_source_policy%ROWTYPE;
    run collection_run%ROWTYPE;
BEGIN
    SELECT * INTO pol FROM discovery_source_policy WHERE source = NEW.source;
    IF NOT FOUND OR NOT pol.enabled THEN
        RAISE EXCEPTION 'discovery_disabled' USING ERRCODE = 'P0001';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('catalog_sync_operation:' || NEW.source, 0));

    NEW.status := 'open';
    NEW.created_at := now();
    NEW.closed_at := NULL;
    NEW.blocked_at := NULL;
    NEW.requests_made := 0;
    NEW.bytes_decoded := 0;
    NEW.bytes_transferred := 0;
    NEW.files_planned := 0;
    NEW.index_planned_at := NULL;
    NEW.removal_state := 'not_applicable';
    IF NEW.kind = 'initial_import' THEN
        NEW.quota_run_id := NULL;
        NEW.expires_at := NULL;
        NEW.max_requests := pol.initial_max_requests;
        NEW.max_bytes := pol.initial_max_bytes;
    ELSE
        -- Yenileme ancak tamamlanmis bir ilk aktarimdan sonra.
        IF NOT EXISTS (SELECT 1 FROM catalog_sync_operation
                        WHERE source = NEW.source AND kind = 'initial_import'
                          AND status = 'completed') THEN
            RAISE EXCEPTION 'discovery_initial_required' USING ERRCODE = 'P0001';
        END IF;
        SELECT * INTO run FROM collection_run WHERE id = NEW.quota_run_id;
        IF NOT FOUND OR run.source <> NEW.source OR run.status <> 'open' OR run.kind <> 'refresh'
           OR run.requests_made <> 0 THEN
            RAISE EXCEPTION 'discovery_quota_run_invalid' USING ERRCODE = 'P0001';
        END IF;
        NEW.expires_at := run.expires_at;
        NEW.max_requests := pol.refresh_max_requests;
        NEW.max_bytes := pol.refresh_max_bytes;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER catalog_sync_operation_insert_guard_trg
    BEFORE INSERT ON catalog_sync_operation
    FOR EACH ROW EXECUTE FUNCTION catalog_sync_operation_insert_guard();

-- Kimlik ve butce degismez; sayaclar azalmaz; kapanan operasyon yeniden acilmaz
-- (kapanistan sonra yalnizca kaldirilma degerlendirmesi ve ozet yazilabilir).
CREATE FUNCTION catalog_sync_operation_update_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.source IS DISTINCT FROM OLD.source
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.quota_run_id IS DISTINCT FROM OLD.quota_run_id
       OR NEW.started_by IS DISTINCT FROM OLD.started_by
       OR NEW.network_declared IS DISTINCT FROM OLD.network_declared
       OR NEW.max_requests IS DISTINCT FROM OLD.max_requests
       OR NEW.max_bytes IS DISTINCT FROM OLD.max_bytes
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
        RAISE EXCEPTION 'discovery_operation_immutable' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.requests_made < OLD.requests_made
       OR NEW.bytes_decoded < OLD.bytes_decoded
       OR NEW.bytes_transferred < OLD.bytes_transferred THEN
        RAISE EXCEPTION 'discovery_counter_decrease' USING ERRCODE = 'P0001';
    END IF;
    IF OLD.status NOT IN ('open', 'paused', 'blocked') THEN
        IF NEW.status IS DISTINCT FROM OLD.status
           OR NEW.requests_made IS DISTINCT FROM OLD.requests_made
           OR NEW.bytes_decoded IS DISTINCT FROM OLD.bytes_decoded
           OR NEW.files_planned IS DISTINCT FROM OLD.files_planned
           OR NEW.closed_at IS DISTINCT FROM OLD.closed_at THEN
            RAISE EXCEPTION 'discovery_operation_closed' USING ERRCODE = 'P0001';
        END IF;
    END IF;
    IF NEW.status NOT IN ('open', 'paused', 'blocked') AND NEW.closed_at IS NULL THEN
        NEW.closed_at := now();
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER catalog_sync_operation_update_guard_trg
    BEFORE UPDATE ON catalog_sync_operation
    FOR EACH ROW EXECUTE FUNCTION catalog_sync_operation_update_guard();

-- ---------------------------------------------------------------------------
-- 3) DOSYA BIRIMI (dosya bazinda checkpoint; kaldigi yerden devam)
-- ---------------------------------------------------------------------------
-- seq 0 = sitemap indeksi; 1..N = indeksteki dosyalar (indeks sirasi).
CREATE TABLE catalog_sync_unit (
    operation_id      BIGINT      NOT NULL REFERENCES catalog_sync_operation(id),
    seq               INTEGER     NOT NULL CHECK (seq >= 0),
    unit_kind         TEXT        NOT NULL CHECK (unit_kind IN ('index', 'file')),
    file_url          TEXT        NOT NULL CHECK (char_length(file_url) <= 500 AND file_url ~ '^https://'),
    -- Indeksin bildirdigi lastmod (yoksa NULL; uydurulmaz).
    source_lastmod    TIMESTAMPTZ,
    --   pending   henuz istenmedi        fetching  hak alindi, sonuc bekleniyor
    --   done      islendi                failed    ag/icerik hatasi (deneme hakki varsa yeniden)
    --   blocked   kaynak engel gosterdi
    status            TEXT        NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'fetching', 'done', 'failed', 'blocked')),
    attempts          SMALLINT    NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    items_found       INTEGER     NOT NULL DEFAULT 0 CHECK (items_found >= 0),
    items_valid       INTEGER     NOT NULL DEFAULT 0 CHECK (items_valid >= 0),
    -- Bu dosyayla ILK KEZ deftere giren urun (denemeler boyunca birikir; tekrar sayilmaz).
    items_new         INTEGER     NOT NULL DEFAULT 0 CHECK (items_new >= 0),
    bytes_decoded     BIGINT      NOT NULL DEFAULT 0 CHECK (bytes_decoded >= 0),
    bytes_transferred BIGINT      NOT NULL DEFAULT 0 CHECK (bytes_transferred >= 0),
    error_code        TEXT        CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{2,60}$'),
    error_detail      TEXT        CHECK (error_detail IS NULL OR char_length(error_detail) <= 300),
    claimed_at        TIMESTAMPTZ,
    completed_at      TIMESTAMPTZ,
    PRIMARY KEY (operation_id, seq),
    CONSTRAINT catalog_sync_unit_url_uniq UNIQUE (operation_id, file_url),
    CONSTRAINT catalog_sync_unit_index_seq CHECK ((unit_kind = 'index') = (seq = 0)),
    CONSTRAINT catalog_sync_unit_done_at CHECK (status <> 'done' OR completed_at IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- 4) ISTEK DEFTERI (append-only): gunluk tavan ve aralik buradan hesaplanir
-- ---------------------------------------------------------------------------
CREATE TABLE catalog_sync_request (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source        TEXT        NOT NULL REFERENCES discovery_source_policy(source),
    operation_id  BIGINT      NOT NULL REFERENCES catalog_sync_operation(id),
    seq           INTEGER     NOT NULL CHECK (seq >= 0),
    requested_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX catalog_sync_request_source_idx ON catalog_sync_request (source, requested_at DESC);

-- ---------------------------------------------------------------------------
-- 5) KESIF DEFTERI: fiyatsiz urun kimligi (milyonlarca satir icin dar tutuldu)
-- ---------------------------------------------------------------------------
-- Birincil anahtar dogal anahtardir (source, external_id): ayni urun tekrar kesfedilince yeni
-- satir olusmaz. Ek indeks YOK: yazim ve okuma birincil anahtarla, toplu isler birincil anahtar
-- araligiyla parca parca ilerler; panel sayilari `catalog_discovery_tally`den okunur.
-- Operasyon kimliklerine FK yok (her yazimda FK denetimi milyonlarca satirda maliyetli;
-- operasyon satirlari silinemez - asagidaki REVOKE).
-- URL kaynak alan adi olmadan yol olarak saklanir (politikadaki `url_host` ile birlesir).
CREATE TABLE catalog_discovery (
    source                  TEXT        NOT NULL REFERENCES discovery_source_policy(source),
    -- Kaynak urun kodu (URL sonundaki -pm-/-p- kodu: HBC0000KHSC74, HBCV00009Z3XOE).
    external_id             TEXT        NOT NULL CHECK (external_id ~ '^[A-Za-z0-9]{4,40}$'),
    -- 'pm' = urun modeli adresi, 'p' = varyant adresi.
    code_kind               TEXT        NOT NULL CHECK (code_kind IN ('pm', 'p')),
    url_path                TEXT        NOT NULL CHECK (char_length(url_path) BETWEEN 2 AND 1024
                                                        AND url_path ~ '^/'),
    -- Sitemap gorsel basligi; yoksa NULL (adres kisaltmasindan baslik uydurulmaz).
    title                   TEXT        CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 500),
    image_url               TEXT        CHECK (image_url IS NULL OR (char_length(image_url) <= 1024
                                                                     AND image_url ~ '^https://')),
    first_seen_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Son gorulme = son BASARILI kontrol: urunu iceren sitemap dosyasinin islendigi an.
    last_seen_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    first_seen_operation_id BIGINT      NOT NULL,
    last_seen_operation_id  BIGINT      NOT NULL,
    -- Kaynak sitemap: (last_seen_operation_id, last_seen_unit_seq) -> catalog_sync_unit.file_url
    last_seen_unit_seq      INTEGER     NOT NULL CHECK (last_seen_unit_seq >= 1),
    -- Ardisik TAM haftalik taramada gorulmeme sayisi; gorulunce 0.
    missed_scans            SMALLINT    NOT NULL DEFAULT 0 CHECK (missed_scans >= 0),
    presence                TEXT        NOT NULL DEFAULT 'present'
                            CHECK (presence IN ('present', 'missing', 'removed')),
    -- Fiyat DURUMU (deger degil). Deger offer/price_point'tedir:
    --   unpriced     dogrulanmis fiyat yok (varsayilan)
    --   verified     dogrulanmis kaynak kaydi teklife islendi (price_offer_id)
    --   stale        dogrulanmis fiyat tazeligini yitirdi (guncelmis gibi gosterilmez)
    --   unavailable  kontrol edildi, satis/fiyat yok
    price_state             TEXT        NOT NULL DEFAULT 'unpriced'
                            CHECK (price_state IN ('unpriced', 'verified', 'stale', 'unavailable')),
    price_offer_id          BIGINT,
    price_source            TEXT        CHECK (price_source IS NULL OR price_source ~ '^[a-z0-9_]{2,40}$'),
    price_checked_at        TIMESTAMPTZ,
    --   hidden     yalnizca defterde       published  fiyatsiz teklif olarak kataloga acildi (offer_id)
    --   withdrawn  kaldirildi (kaynak urunu kaldirdi ya da yonetici geri cekti)
    publish_state           TEXT        NOT NULL DEFAULT 'hidden'
                            CHECK (publish_state IN ('hidden', 'published', 'withdrawn')),
    offer_id                BIGINT,
    PRIMARY KEY (source, external_id),
    CONSTRAINT catalog_discovery_seen_order CHECK (last_seen_at >= first_seen_at),
    CONSTRAINT catalog_discovery_price_checked CHECK ((price_state = 'unpriced') = (price_checked_at IS NULL)),
    CONSTRAINT catalog_discovery_price_offer
        CHECK (price_state NOT IN ('verified', 'stale') OR price_offer_id IS NOT NULL),
    CONSTRAINT catalog_discovery_published_offer CHECK (publish_state <> 'published' OR offer_id IS NOT NULL)
) WITH (
    -- Her haftalik tarama last_seen_* yazar: sayfada bos yer HOT guncellemeye izin verir
    -- (guncellenen kolonlar indekslenmez).
    fillfactor = 85,
    autovacuum_vacuum_scale_factor = 0.02,
    autovacuum_vacuum_insert_scale_factor = 0.05
);

COMMENT ON TABLE catalog_discovery IS
    'Fiyatsiz urun kesif defteri (sitemap). offer DEGILDIR; fiyat kolonu yoktur. Karar 0120.';

-- Panel sayaclari: milyonlarca satirda count(*) istek yolunda calismaz. Ekleme sayaci TS yazar
-- (yalnizca gercekten eklenen satirlar), fiyat/yayin/kaldirma sayilarini Python toplu isi
-- yeniden hesaplar.
CREATE TABLE catalog_discovery_tally (
    source          TEXT        PRIMARY KEY REFERENCES discovery_source_policy(source),
    items_total     BIGINT      NOT NULL DEFAULT 0 CHECK (items_total >= 0),
    items_priced    BIGINT      NOT NULL DEFAULT 0 CHECK (items_priced >= 0),
    items_published BIGINT      NOT NULL DEFAULT 0 CHECK (items_published >= 0),
    items_removed   BIGINT      NOT NULL DEFAULT 0 CHECK (items_removed >= 0),
    recounted_at    TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO catalog_discovery_tally (source)
SELECT source FROM discovery_source_policy;

-- ---------------------------------------------------------------------------
-- YETKILER
-- ---------------------------------------------------------------------------
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON discovery_source_policy FROM arilla_app;
GRANT SELECT ON discovery_source_policy TO arilla_app;
-- Operasyon ve birim gecmisi silinemez (silme kota/istek muhasebesini sifirlardi).
GRANT SELECT, INSERT, UPDATE ON catalog_sync_operation, catalog_sync_unit TO arilla_app;
REVOKE DELETE, TRUNCATE ON catalog_sync_operation, catalog_sync_unit FROM arilla_app;
-- Istek defteri yalnizca eklenir.
GRANT SELECT, INSERT ON catalog_sync_request TO arilla_app;
REVOKE UPDATE, DELETE, TRUNCATE ON catalog_sync_request FROM arilla_app;
-- Defterden satir silinmez: kaldirilan urun 'removed' olarak isaretlenir.
GRANT SELECT, INSERT, UPDATE ON catalog_discovery TO arilla_app;
REVOKE DELETE, TRUNCATE ON catalog_discovery FROM arilla_app;
GRANT SELECT, UPDATE ON catalog_discovery_tally TO arilla_app;
REVOKE INSERT, DELETE, TRUNCATE ON catalog_discovery_tally FROM arilla_app;
