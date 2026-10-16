-- kind: schema
-- 0075 — Hepsiburada kota modeli: gunluk/aylik HTTP istegi + aylik urun (karar 0124)
--
-- Kullanici beyani (Ekim 2026, belge incelenmedi): 7 gunluk kosu araligi ve ayda 4 kosu siniri
-- KALKTI; eski 1.000/gun ve 30.000/ay istek sinirlari gecersiz. Yeni sinirlar: gunluk 20.000
-- HTTP istegi, aylik 60.000 HTTP istegi, aylik 5.000.000 urun. Yalniz urun kimligi, ad, gorsel
-- ve URL toplanir; fiyat toplama kapsam disidir.
--
-- Kota artik KOSU SAYISI uzerinden degil, istek/urun HACMI uzerinden ve VERITABANI
-- tetikleyicisinde uygulanir:
--   * Istek, gercek HTTP isteginden ONCE rezerve edilir (`requests_reserved`). Rezervasyon bir
--     UPDATE ile atomik yapilir (advisory kilit + gunluk/aylik defter). Istek atildiktan sonra
--     yazim basarisiz olsa bile defter dusmez (rezervasyon iade edilmez), kota asilamaz.
--   * `requests_made` yalniz tamamlanan istek bilgisidir; tetikleyici onu rezervasyonun
--     altinda tutar (eski toplayici `requests_made` ile ilerliyorsa fark ayni kilitle rezerve edilir).
--   * Urunler parti yazimi ile ayni islemde `products_counted` olarak sayilir; aylik tavani asan
--     parti reddedilir ve hicbir sey yazilmaz.
--
-- Geriye uyumlu: yeni kolon/tablo; eski kolonlar silinmez (min_interval_days, max_runs_per_month
-- politikada kalir; 0 / NULL = bu kisit uygulanmaz). Mevcut kosular `requests_made` degerinden
-- doldurulur, defter kosunun acildigi UTC gune yazilir (yaklasik; uretimde kosu yoktur).

-- ---------------------------------------------------------------------------
-- 1) POLITIKA
-- ---------------------------------------------------------------------------
ALTER TABLE collection_source
    DROP CONSTRAINT collection_source_window_lt_interval,
    DROP CONSTRAINT collection_source_reported_scope,
    DROP CONSTRAINT collection_source_min_interval_days_check,
    DROP CONSTRAINT collection_source_max_runs_per_month_check,
    ALTER COLUMN max_runs_per_month DROP NOT NULL,
    ADD CONSTRAINT collection_source_min_interval_days_check CHECK (min_interval_days >= 0),
    ADD CONSTRAINT collection_source_max_runs_per_month_check
        CHECK (max_runs_per_month IS NULL OR max_runs_per_month >= 1),
    -- NULL = o kota uygulanmaz.
    ADD COLUMN daily_max_requests   INTEGER CHECK (daily_max_requests IS NULL OR daily_max_requests >= 1),
    ADD COLUMN monthly_max_requests INTEGER CHECK (monthly_max_requests IS NULL OR monthly_max_requests >= 1),
    ADD COLUMN monthly_max_products INTEGER CHECK (monthly_max_products IS NULL OR monthly_max_products >= 1),
    ADD CONSTRAINT collection_source_request_quota_order
        CHECK (daily_max_requests IS NULL OR monthly_max_requests IS NULL
               OR daily_max_requests <= monthly_max_requests),
    -- 0070'in iki korumasi silinmez, yeni modele uyarlanir: aralik tanimliysa (> 0) pencere
    -- araliktan kisa kalir; yalniz bildirilen izinle (sozlu / e-posta) politika 7 gun ve ayda
    -- 4 kosunun disina gevsetilemez. Hacim kotasi icin dayanak 'declared_extended' ya da sozlesmedir.
    ADD CONSTRAINT collection_source_window_lt_interval
        CHECK (min_interval_days = 0 OR run_window_days < min_interval_days),
    ADD CONSTRAINT collection_source_reported_scope CHECK (
        permission_basis NOT IN ('verbal_reported', 'written_email_reported')
        OR (min_interval_days >= 7 AND max_runs_per_month IS NOT NULL
            AND max_runs_per_month <= 4 AND NOT initial_load_exempt));

COMMENT ON COLUMN collection_source.min_interval_days IS
    'Iki kosu arasi en az gun; 0 = aralik kisiti yok (karar 0124).';
COMMENT ON COLUMN collection_source.max_runs_per_month IS
    'Ayda en fazla kosu; NULL = kosu sayisi sinirsiz, hacim kotasi (istek/urun) gecerlidir.';
COMMENT ON COLUMN collection_source.daily_max_requests IS
    'UTC gununde rezerve edilebilecek en fazla kaynak HTTP istegi; NULL = uygulanmaz.';
COMMENT ON COLUMN collection_source.monthly_max_requests IS
    'UTC ayinda rezerve edilebilecek en fazla kaynak HTTP istegi; NULL = uygulanmaz.';
COMMENT ON COLUMN collection_source.monthly_max_products IS
    'UTC ayinda islenebilecek en fazla benzersiz-parti urun sayisi; NULL = uygulanmaz.';

-- ---------------------------------------------------------------------------
-- 2) KOSU: istek rezervasyonu ve urun sayaci
-- ---------------------------------------------------------------------------
ALTER TABLE collection_run DISABLE TRIGGER USER;
ALTER TABLE collection_run
    ADD COLUMN requests_reserved INTEGER NOT NULL DEFAULT 0 CHECK (requests_reserved >= 0),
    ADD COLUMN products_counted  BIGINT  NOT NULL DEFAULT 0 CHECK (products_counted >= 0);
UPDATE collection_run SET requests_reserved = requests_made WHERE requests_reserved <> requests_made;
ALTER TABLE collection_run ENABLE TRIGGER USER;
ALTER TABLE collection_run
    ADD CONSTRAINT collection_run_reserved_budget CHECK (requests_reserved <= max_requests),
    ADD CONSTRAINT collection_run_made_within_reserved CHECK (requests_made <= requests_reserved),
    ADD CONSTRAINT collection_run_released_no_reservation
        CHECK (status <> 'released' OR requests_reserved = 0);

COMMENT ON COLUMN collection_run.requests_reserved IS
    'Gercek HTTP isteginden ONCE rezerve edilen toplam istek (azalmaz, iade edilmez). requests_made <= requests_reserved.';
COMMENT ON COLUMN collection_run.products_counted IS
    'Bu kosuda kota defterine yazilan urun sayisi (parti basina kabul edilen benzersiz gecerli kimlik).';

-- ---------------------------------------------------------------------------
-- 3) GUNLUK KULLANIM DEFTERI (UTC gun)
-- ---------------------------------------------------------------------------
CREATE TABLE collection_usage_day (
    source      TEXT        NOT NULL REFERENCES collection_source(source),
    usage_date  DATE        NOT NULL,
    requests    BIGINT      NOT NULL DEFAULT 0 CHECK (requests >= 0),
    products    BIGINT      NOT NULL DEFAULT 0 CHECK (products >= 0),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (source, usage_date)
);
COMMENT ON TABLE collection_usage_day IS
    'Kaynak basina UTC gun bazli rezerve istek ve islenen urun sayaci. Yalniz collection_run tetikleyicisi yazar (karar 0124).';

INSERT INTO collection_usage_day (source, usage_date, requests, products)
SELECT source, (reserved_at AT TIME ZONE 'UTC')::date, sum(requests_reserved), 0
  FROM collection_run
 GROUP BY 1, 2
HAVING sum(requests_reserved) > 0;

-- ---------------------------------------------------------------------------
-- 4) TETIKLEYICILER
-- ---------------------------------------------------------------------------
-- Kosu rezervasyonu: 0073 ile AYNI mantik; aralik/ay-kosu kisiti yalniz politikada tanimliysa
-- calisir, ek olarak tukenmis hacim kotasi (gun/ay) yeni kosuyu reddeder.
CREATE OR REPLACE FUNCTION collection_run_quota_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    pol collection_source%ROWTYPE;
    last_at TIMESTAMPTZ;
    next_at TIMESTAMPTZ;
    month_runs INTEGER;
    today DATE;
    month_start DATE;
    day_req BIGINT;
    month_req BIGINT;
    month_prod BIGINT;
BEGIN
    SELECT * INTO pol FROM collection_source WHERE source = NEW.source;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'collection_source_unknown' USING ERRCODE = 'P0001';
    END IF;
    IF NOT pol.enabled THEN
        RAISE EXCEPTION 'collection_disabled' USING ERRCODE = 'P0001';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('collection_run:' || NEW.source, 0));

    NEW.reserved_at := now();
    NEW.status := 'open';
    NEW.closed_at := NULL;
    NEW.requests_made := 0;
    NEW.requests_reserved := 0;
    NEW.products_counted := 0;
    NEW.bytes_downloaded := 0;
    NEW.download_approved_bytes := 0;
    NEW.download_approved_by := NULL;
    NEW.download_approved_at := NULL;
    NEW.kind := CASE WHEN EXISTS (SELECT 1 FROM collection_run
                                   WHERE source = NEW.source AND status <> 'released')
                     THEN 'refresh' ELSE 'initial' END;
    NEW.expires_at := NEW.reserved_at + make_interval(
        days => CASE NEW.kind WHEN 'initial'
                     THEN COALESCE(pol.initial_run_window_days, pol.run_window_days)
                     ELSE pol.run_window_days END);
    NEW.max_requests := CASE NEW.kind WHEN 'initial' THEN pol.initial_max_requests
                                      ELSE pol.refresh_max_requests END;
    NEW.max_bytes := CASE NEW.kind WHEN 'initial' THEN pol.initial_max_bytes
                                   ELSE pol.refresh_max_bytes END;

    IF pol.min_interval_days > 0 THEN
        SELECT max(reserved_at) INTO last_at
          FROM collection_run
         WHERE source = NEW.source AND status <> 'released'
           AND NOT (kind = 'initial' AND pol.initial_load_exempt);
        IF last_at IS NOT NULL THEN
            next_at := last_at + make_interval(days => pol.min_interval_days);
            IF NEW.reserved_at < next_at THEN
                RAISE EXCEPTION 'collection_quota_interval' USING ERRCODE = 'P0001',
                    DETAIL = 'next_allowed_at=' || to_char((next_at AT TIME ZONE 'UTC'),
                                                           'YYYY-MM-DD"T"HH24:MI:SS"Z"');
            END IF;
        END IF;
    END IF;

    IF pol.max_runs_per_month IS NOT NULL THEN
        SELECT count(*) INTO month_runs
          FROM collection_run
         WHERE source = NEW.source AND status <> 'released'
           AND NOT (kind = 'initial' AND pol.initial_load_exempt)
           AND date_trunc('month', reserved_at AT TIME ZONE 'UTC')
             = date_trunc('month', NEW.reserved_at AT TIME ZONE 'UTC');
        IF month_runs >= pol.max_runs_per_month THEN
            RAISE EXCEPTION 'collection_quota_month' USING ERRCODE = 'P0001';
        END IF;
    END IF;

    -- Tukenmis hacim kotasi: yeni kosu acilmaz (acik kosu devam eder ama rezervasyon yine reddedilir).
    today := (NEW.reserved_at AT TIME ZONE 'UTC')::date;
    month_start := date_trunc('month', NEW.reserved_at AT TIME ZONE 'UTC')::date;
    SELECT COALESCE(sum(requests) FILTER (WHERE usage_date = today), 0),
           COALESCE(sum(requests), 0), COALESCE(sum(products), 0)
      INTO day_req, month_req, month_prod
      FROM collection_usage_day
     WHERE source = NEW.source AND usage_date >= month_start
       AND usage_date < (month_start + interval '1 month')::date;
    IF pol.monthly_max_requests IS NOT NULL AND month_req >= pol.monthly_max_requests THEN
        RAISE EXCEPTION 'collection_quota_monthly_requests' USING ERRCODE = 'P0001';
    END IF;
    IF pol.monthly_max_products IS NOT NULL AND month_prod >= pol.monthly_max_products THEN
        RAISE EXCEPTION 'collection_quota_monthly_products' USING ERRCODE = 'P0001';
    END IF;
    IF pol.daily_max_requests IS NOT NULL AND day_req >= pol.daily_max_requests THEN
        RAISE EXCEPTION 'collection_quota_daily_requests' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END $$;

-- Istek rezervasyonu ve urun sayaci: gunluk/aylik kotayi aynı kilitle denetler ve defteri yazar.
-- SECURITY DEFINER: `arilla_app` defteri dogrudan yazamaz, yalniz bu tetikleyici yazar.
CREATE OR REPLACE FUNCTION collection_run_usage_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    pol collection_source%ROWTYPE;
    d_req INTEGER;
    d_prod BIGINT;
    today DATE := (now() AT TIME ZONE 'UTC')::date;
    month_start DATE := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
    day_req BIGINT;
    month_req BIGINT;
    month_prod BIGINT;
BEGIN
    -- Eski toplayici yalniz requests_made'i artirir: farki ayni kilitle rezerve et.
    IF NEW.requests_made > NEW.requests_reserved THEN
        NEW.requests_reserved := NEW.requests_made;
    END IF;
    d_req := NEW.requests_reserved - OLD.requests_reserved;
    d_prod := NEW.products_counted - OLD.products_counted;
    IF d_req < 0 THEN
        RAISE EXCEPTION 'collection_requests_decrease' USING ERRCODE = 'P0001';
    END IF;
    IF d_prod < 0 THEN
        RAISE EXCEPTION 'collection_products_decrease' USING ERRCODE = 'P0001';
    END IF;
    IF d_req = 0 AND d_prod = 0 THEN
        RETURN NEW;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('collection_usage:' || NEW.source, 0));
    SELECT * INTO pol FROM collection_source WHERE source = NEW.source;
    IF d_req > 0 AND NOT pol.enabled THEN
        RAISE EXCEPTION 'collection_disabled' USING ERRCODE = 'P0001';
    END IF;

    SELECT COALESCE(sum(requests) FILTER (WHERE usage_date = today), 0),
           COALESCE(sum(requests), 0), COALESCE(sum(products), 0)
      INTO day_req, month_req, month_prod
      FROM collection_usage_day
     WHERE source = NEW.source AND usage_date >= month_start
       AND usage_date < (month_start + interval '1 month')::date;

    IF d_req > 0 THEN
        IF pol.daily_max_requests IS NOT NULL AND day_req + d_req > pol.daily_max_requests THEN
            RAISE EXCEPTION 'collection_quota_daily_requests' USING ERRCODE = 'P0001',
                DETAIL = 'remaining=' || GREATEST(pol.daily_max_requests - day_req, 0);
        END IF;
        IF pol.monthly_max_requests IS NOT NULL AND month_req + d_req > pol.monthly_max_requests THEN
            RAISE EXCEPTION 'collection_quota_monthly_requests' USING ERRCODE = 'P0001',
                DETAIL = 'remaining=' || GREATEST(pol.monthly_max_requests - month_req, 0);
        END IF;
    END IF;
    IF d_prod > 0 AND pol.monthly_max_products IS NOT NULL
       AND month_prod + d_prod > pol.monthly_max_products THEN
        RAISE EXCEPTION 'collection_quota_monthly_products' USING ERRCODE = 'P0001',
            DETAIL = 'remaining=' || GREATEST(pol.monthly_max_products - month_prod, 0);
    END IF;

    INSERT INTO collection_usage_day AS u (source, usage_date, requests, products)
    VALUES (NEW.source, today, d_req, d_prod)
    ON CONFLICT (source, usage_date)
    DO UPDATE SET requests = u.requests + EXCLUDED.requests,
                  products = u.products + EXCLUDED.products,
                  updated_at = now();
    RETURN NEW;
END $$;

COMMENT ON FUNCTION collection_run_usage_guard() IS
    'YETKI NOTU — SECURITY DEFINER: collection_usage_day yalniz bu tetikleyiciyle yazilir; cagiranin yetkisini atlar. search_path sabit. Karar 0124.';

-- Trigger fonksiyonu dogrudan cagrilamaz; yine de EXECUTE herkese acik birakilmaz.
REVOKE ALL ON FUNCTION collection_run_usage_guard() FROM PUBLIC;

CREATE TRIGGER collection_run_usage_guard_trg
    BEFORE UPDATE ON collection_run
    FOR EACH ROW EXECUTE FUNCTION collection_run_usage_guard();
-- Ayni olaydaki BEFORE tetikleyiciler ADA gore alfabetik calisir: `collection_run_immutable_guard_trg`
-- (0070; kapali kosu, azalan sayac, degismez alanlar) `collection_run_usage_guard_trg`'den ONCE kosar.
-- Kapali bir kosuda defter hic yazilmaz.

-- Eski satirlar etkilenmez; Hepsiburada politikasi (kullanici beyani).
UPDATE collection_source
   SET min_interval_days = 0,
       max_runs_per_month = NULL,
       daily_max_requests = 20000,
       monthly_max_requests = 60000,
       monthly_max_products = 5000000,
       initial_max_requests = 20000,
       refresh_max_requests = 20000,
       permission_basis = 'declared_extended',
       permission_note = 'Kullanici beyani (Ekim 2026), belge incelenmedi: kosu araligi ve aylik kosu siniri '
           || 'kaldirildi; gunluk 20.000 ve aylik 60.000 HTTP istegi, aylik 5.000.000 urun. Yalniz '
           || 'urun kimligi, ad, gorsel, URL; fiyat toplanmaz.'
 WHERE source = 'hepsiburada';

-- ---------------------------------------------------------------------------
-- 5) YETKI: defter yalniz okunur
-- ---------------------------------------------------------------------------
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON collection_usage_day FROM arilla_app;
GRANT SELECT ON collection_usage_day TO arilla_app;
