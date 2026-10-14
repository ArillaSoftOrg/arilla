-- kind: schema
-- 0070 — yonetici tarayicisindan katalog toplama: kota, kapsam, ara depo (karar 0117)
--
-- YALNIZCA EKLEME. Yeni tablolar ve tetikleyiciler; mevcut hicbir sey degismez.
--
-- Akis: yonetici tarayicisi kaynaktan (Hepsiburada) veriyi okur -> TS kimlikli
-- istekle `catalog_intake_record`e YALNIZCA SATIR EKLER -> Python is
-- (`python -m feeds hb-merge`) mevcut offer/price_point modeline birlestirir.
-- TS offer yazmaz (mimari sinir). Katalog yazimi `offer` modelindedir; ayri
-- veritabani ya da ayri urun tablosu yok.
--
-- KOTA SISTEM SEVIYESINDEDIR: kaynak basina en az `min_interval_days` aralik ve
-- takvim ayinda (UTC) en fazla `max_runs_per_month` toplama kosusu. Tetikleyici
-- uygulama kodundan bagimsiz calisir; `arilla_app` politikayi DEGISTIREMEZ.
-- Ilk yukleme de ayni kotaya tabidir (muaf degil).

-- ---------------------------------------------------------------------------
-- KAYNAK POLITIKASI
-- ---------------------------------------------------------------------------
CREATE TABLE collection_source (
    source               TEXT        PRIMARY KEY CHECK (source ~ '^[a-z0-9_]{2,40}$'),
    merchant_slug        TEXT        NOT NULL CHECK (char_length(merchant_slug) BETWEEN 1 AND 80),
    min_interval_days    SMALLINT    NOT NULL CHECK (min_interval_days >= 1),
    max_runs_per_month   SMALLINT    NOT NULL CHECK (max_runs_per_month >= 1),
    -- Kosunun en fazla yasam suresi (gun). Aralik'tan KISA olmak zorunda: iki
    -- kosu hicbir zaman ust uste binmez.
    run_window_days      SMALLINT    NOT NULL CHECK (run_window_days >= 1),
    -- Kosu basina kaynaga atilabilecek istek tavani (isletici guvenlik valfi;
    -- kaynagin bildirdigi bir sayi DEGILDIR).
    -- Ilk yukleme ile sonraki (haftalik) guncelleme AYRI butcelidir; ikisi de ayarlanabilir
    -- (politika yalnizca sahip rol/migration ile degisir). Ilk yukleme kotadan MUAF DEGILDIR:
    -- ayni aralik ve ay tavanina tabidir.
    initial_max_requests INTEGER     NOT NULL CHECK (initial_max_requests >= 1),
    refresh_max_requests INTEGER     NOT NULL CHECK (refresh_max_requests >= 1),
    enabled              BOOLEAN     NOT NULL DEFAULT FALSE,
    -- Iznin dayanagi. 'verbal_reported' = kullanicinin bildirdigi sozlu izin;
    -- yazili lisans DEGILDIR.
    permission_basis     TEXT        NOT NULL
                         CHECK (permission_basis IN ('verbal_reported', 'written_agreement', 'public_feed')),
    permission_note      TEXT        CHECK (permission_note IS NULL OR char_length(permission_note) <= 500),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT collection_source_window_lt_interval CHECK (run_window_days < min_interval_days),
    -- Bildirilen sozlu izin kapsaminin (>= 7 gun, ayda <= 4) disina POLITIKA gevsetilemez;
    -- gevsetmek icin once izin dayanagi yazili sozlesmeye yukseltilmelidir.
    CONSTRAINT collection_source_verbal_scope CHECK (
        permission_basis <> 'verbal_reported'
        OR (min_interval_days >= 7 AND max_runs_per_month <= 4))
);

INSERT INTO collection_source
    (source, merchant_slug, min_interval_days, max_runs_per_month, run_window_days,
     initial_max_requests, refresh_max_requests, enabled, permission_basis, permission_note)
VALUES
    ('hepsiburada', 'hepsiburada', 7, 4, 6, 500, 500, FALSE, 'verbal_reported',
     'Kullanicinin bildirdigi sozlu izin (Ekim 2026): mevcut CORS yontemi ve PostgreSQL''de saklama; '
     || 'toplu guncelleme en az 7 gun arayla, ayda en fazla 4. Yazili lisans yok.');

-- ---------------------------------------------------------------------------
-- TOPLAMA KOSUSU (kota defteri)
-- ---------------------------------------------------------------------------
CREATE TABLE collection_run (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source           TEXT        NOT NULL REFERENCES collection_source(source),
    -- Kosuyu baslatan yonetici. Hesap silinse de kosu kaydi kalir.
    started_by       BIGINT      REFERENCES app_user(id) ON DELETE SET NULL,
    -- 'initial': kaynagin ilk kotaya sayilan koşusu; sonrakiler 'refresh'. Tetikleyici yazar.
    kind             TEXT        NOT NULL DEFAULT 'initial' CHECK (kind IN ('initial', 'refresh')),
    status           TEXT        NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open', 'completed', 'aborted', 'released')),
    -- Tetikleyici sunucu saatiyle yazar; istemci geriye tarihleyemez.
    reserved_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at       TIMESTAMPTZ NOT NULL,
    closed_at        TIMESTAMPTZ,
    requests_made    INTEGER     NOT NULL DEFAULT 0 CHECK (requests_made >= 0),
    max_requests     INTEGER     NOT NULL CHECK (max_requests >= 1),
    -- Kosu ayarlari (sorgu listesi sayisi, sayfa tavani); sir icermez.
    options          JSONB       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(options) = 'object'),
    -- Yarim kalan kosuyu surdurmek icin tarayici kontrol noktasi.
    checkpoint       JSONB       CHECK (checkpoint IS NULL OR (jsonb_typeof(checkpoint) = 'object'
                                                              AND pg_column_size(checkpoint) <= 65536)),
    -- Kapanista: kapsam ozeti (toplam ozgun urun, tavana takilan sorgular...).
    summary          JSONB       CHECK (summary IS NULL OR jsonb_typeof(summary) = 'object'),
    CONSTRAINT collection_run_budget CHECK (requests_made <= max_requests),
    CONSTRAINT collection_run_released_unused CHECK (status <> 'released' OR requests_made = 0),
    CONSTRAINT collection_run_closed CHECK ((status = 'open') = (closed_at IS NULL))
);
-- Acik kosu kaynak basina tek.
CREATE UNIQUE INDEX collection_run_one_open_uniq ON collection_run (source) WHERE status = 'open';
CREATE INDEX collection_run_source_idx ON collection_run (source, reserved_at DESC);

CREATE FUNCTION collection_run_quota_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    pol collection_source%ROWTYPE;
    last_at TIMESTAMPTZ;
    next_at TIMESTAMPTZ;
    month_runs INTEGER;
BEGIN
    SELECT * INTO pol FROM collection_source WHERE source = NEW.source;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'collection_source_unknown' USING ERRCODE = 'P0001';
    END IF;
    IF NOT pol.enabled THEN
        RAISE EXCEPTION 'collection_disabled' USING ERRCODE = 'P0001';
    END IF;
    -- Ayni kaynakta eszamanli iki rezervasyon sirayla degerlendirilir.
    PERFORM pg_advisory_xact_lock(hashtextextended('collection_run:' || NEW.source, 0));

    NEW.reserved_at := now();
    NEW.status := 'open';
    NEW.closed_at := NULL;
    NEW.requests_made := 0;
    NEW.expires_at := NEW.reserved_at + make_interval(days => pol.run_window_days);
    -- Ilk koşu = kota defterinde kotaya sayilan baska koşu yok.
    NEW.kind := CASE WHEN EXISTS (SELECT 1 FROM collection_run
                                   WHERE source = NEW.source AND status <> 'released')
                     THEN 'refresh' ELSE 'initial' END;
    NEW.max_requests := CASE NEW.kind WHEN 'initial' THEN pol.initial_max_requests
                                      ELSE pol.refresh_max_requests END;

    -- 'released' (hic istek atilmadan birakilan) kosu kotadan dusulur.
    SELECT max(reserved_at) INTO last_at
      FROM collection_run WHERE source = NEW.source AND status <> 'released';
    IF last_at IS NOT NULL THEN
        next_at := last_at + make_interval(days => pol.min_interval_days);
        IF NEW.reserved_at < next_at THEN
            RAISE EXCEPTION 'collection_quota_interval' USING ERRCODE = 'P0001',
                DETAIL = 'next_allowed_at=' || to_char((next_at AT TIME ZONE 'UTC'),
                                                       'YYYY-MM-DD"T"HH24:MI:SS"Z"');
        END IF;
    END IF;

    SELECT count(*) INTO month_runs
      FROM collection_run
     WHERE source = NEW.source AND status <> 'released'
       AND date_trunc('month', reserved_at AT TIME ZONE 'UTC')
         = date_trunc('month', NEW.reserved_at AT TIME ZONE 'UTC');
    IF month_runs >= pol.max_runs_per_month THEN
        RAISE EXCEPTION 'collection_quota_month' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER collection_run_quota_guard_trg
    BEFORE INSERT ON collection_run
    FOR EACH ROW EXECUTE FUNCTION collection_run_quota_guard();

-- Kimlik alanlari ve rezervasyon zamani degistirilemez; kapanan kosu yeniden acilmaz.
CREATE FUNCTION collection_run_immutable_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.source IS DISTINCT FROM OLD.source
       OR NEW.reserved_at IS DISTINCT FROM OLD.reserved_at
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
       OR NEW.max_requests IS DISTINCT FROM OLD.max_requests
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.started_by IS DISTINCT FROM OLD.started_by THEN
        RAISE EXCEPTION 'collection_run_immutable' USING ERRCODE = 'P0001';
    END IF;
    IF OLD.status <> 'open' THEN
        RAISE EXCEPTION 'collection_run_closed' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.requests_made < OLD.requests_made THEN
        RAISE EXCEPTION 'collection_requests_decrease' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.status <> 'open' AND NEW.closed_at IS NULL THEN
        NEW.closed_at := now();
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER collection_run_immutable_guard_trg
    BEFORE UPDATE ON collection_run
    FOR EACH ROW EXECUTE FUNCTION collection_run_immutable_guard();

-- ---------------------------------------------------------------------------
-- KAPSAM TAKIBI: kesif birimi = (sorgu, sayfa)
-- ---------------------------------------------------------------------------
-- Her kaynak istegi bir birimdir. Kapsam raporu buradan turetilir: kac sorgu,
-- kac sayfa, her sayfada kac urun, hangi sorgu SAYFA TAVANINA takildi.
CREATE TABLE collection_unit (
    run_id         BIGINT      NOT NULL REFERENCES collection_run(id),
    kind           TEXT        NOT NULL CHECK (kind IN ('query')),
    unit_key       TEXT        NOT NULL CHECK (char_length(unit_key) BETWEEN 1 AND 200),
    page           SMALLINT    NOT NULL DEFAULT 1 CHECK (page BETWEEN 1 AND 200),
    status         TEXT        NOT NULL CHECK (status IN ('done', 'empty', 'failed', 'blocked')),
    items_found    INTEGER     NOT NULL DEFAULT 0 CHECK (items_found >= 0),
    -- Sayfanin onceki sayfalarda GORULMEMIS urun sayisi (sayfalama calisiyor mu kaniti).
    items_new      INTEGER     NOT NULL DEFAULT 0 CHECK (items_new >= 0),
    -- Kaynagin bildirdigi toplam (yoksa NULL; uydurulmaz).
    total_hint     INTEGER     CHECK (total_hint IS NULL OR total_hint >= 0),
    error_code     TEXT        CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{2,60}$'),
    fetched_at     TIMESTAMPTZ NOT NULL,
    recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, kind, unit_key, page)
);

-- ---------------------------------------------------------------------------
-- ARA DEPO: dogrulanmis kaynak kayitlari (offer'a Python birlestirir)
-- ---------------------------------------------------------------------------
-- (run_id, external_id) benzersiz: ayni kosuda tekrar eden urun TEK satirdir.
-- Kosular arasi tekrar `offer (merchant_id, external_id)` ile cozulur.
-- `source_observed_at`: kaynaktan okunma ani (istemci saati, sunucuda
-- [reserved_at, now()] araligina kisitlanir). `received_at`: sunucuya geldigi an.
CREATE TABLE catalog_intake_record (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id             BIGINT      NOT NULL REFERENCES collection_run(id),
    external_id        TEXT        NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 200),
    title              TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 500),
    url                TEXT        NOT NULL CHECK (char_length(url) <= 2048 AND url ~ '^https://'),
    price_minor        BIGINT      NOT NULL CHECK (price_minor > 0),
    list_price_minor   BIGINT      CHECK (list_price_minor IS NULL OR list_price_minor > 0),
    currency           CHAR(3)     NOT NULL CHECK (currency = 'TRY'),
    in_stock           BOOLEAN,
    image_url          TEXT        CHECK (image_url IS NULL OR (char_length(image_url) <= 2048
                                                               AND image_url ~ '^https://')),
    brand              TEXT        CHECK (brand IS NULL OR char_length(brand) <= 200),
    category_raw       TEXT        CHECK (category_raw IS NULL OR char_length(category_raw) <= 500),
    seller_external_id TEXT        CHECK (seller_external_id IS NULL OR char_length(seller_external_id) <= 200),
    gtin               TEXT        CHECK (gtin IS NULL OR gtin ~ '^[0-9]{8,14}$'),
    -- Hangi sorgu bu urunu buldu (kesif izi; kategori DEGILDIR).
    found_via          TEXT        CHECK (found_via IS NULL OR char_length(found_via) <= 200),
    source_observed_at TIMESTAMPTZ NOT NULL,
    received_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    merged_at          TIMESTAMPTZ,
    CONSTRAINT catalog_intake_run_external_uniq UNIQUE (run_id, external_id)
);
CREATE INDEX catalog_intake_pending_idx ON catalog_intake_record (run_id, id) WHERE merged_at IS NULL;

-- Yalniz ACIK ve suresi dolmamis kosuya kayit eklenir; kaynak zamani makul olmali.
CREATE FUNCTION catalog_intake_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    run collection_run%ROWTYPE;
BEGIN
    SELECT * INTO run FROM collection_run WHERE id = NEW.run_id;
    IF NOT FOUND OR run.status <> 'open' THEN
        RAISE EXCEPTION 'collection_run_not_open' USING ERRCODE = 'P0001';
    END IF;
    IF now() >= run.expires_at THEN
        RAISE EXCEPTION 'collection_run_expired' USING ERRCODE = 'P0001';
    END IF;
    NEW.received_at := now();
    IF NEW.source_observed_at < run.reserved_at - interval '5 minutes'
       OR NEW.source_observed_at > now() + interval '5 minutes' THEN
        RAISE EXCEPTION 'collection_observed_at_out_of_range' USING ERRCODE = 'P0001';
    END IF;
    NEW.merged_at := NULL;
    RETURN NEW;
END $$;

CREATE TRIGGER catalog_intake_guard_trg
    BEFORE INSERT ON catalog_intake_record
    FOR EACH ROW EXECUTE FUNCTION catalog_intake_guard();

-- ---------------------------------------------------------------------------
-- YETKILER
-- ---------------------------------------------------------------------------
-- Politika yalnizca sahip rol/migration ile degisir; uygulama okur.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON collection_source FROM arilla_app;
GRANT SELECT ON collection_source TO arilla_app;
-- Kota defterinden satir silinemez (silme kotayi sifirlardi).
REVOKE DELETE, TRUNCATE ON collection_run FROM arilla_app;
REVOKE DELETE, TRUNCATE ON collection_unit FROM arilla_app;
-- Ara depo: TS yalnizca ekler; birlestirme (`merged_at`) Python'dadir ve ayni rolu kullanir.
-- Kayit icerigi sonradan degistirilemez: yalnizca `merged_at` guncellenebilir.
REVOKE UPDATE ON catalog_intake_record FROM arilla_app;
GRANT UPDATE (merged_at) ON catalog_intake_record TO arilla_app;
REVOKE TRUNCATE ON catalog_intake_record FROM arilla_app;
