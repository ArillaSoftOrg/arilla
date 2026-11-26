-- kind: schema
-- 0119 — Toplama kotasi: haftalik kosu tavani (karar 0220/0221 eki)
--
-- Kullanici beyani (26 Kasim 2026, belgeler INCELENMEDI): Hepsiburada ve Trendyol yonetici
-- tarayicisi toplamasi haftada en fazla 100, ayda en fazla 400 kosuya kadar izinli. Izin
-- dayanagi bu nedenle 'declared_extended' olur (0124); kaynak politikasini (min_interval_days,
-- max_runs_per_month, permission_basis) URETIMDE SAHIP ROL gunceller, bu migration DEGIL.
--
-- Bu migration:
--   1) `collection_source.max_runs_per_week` (NULL = uygulanmaz) ekler;
--   2) kota tetikleyicisine kayan 7 gunluk kosu sayisi denetimini ekler (`collection_quota_week`);
--   3) Hepsiburada ve Trendyol icin haftalik tavani 100 yapar (yalniz NULL ise; daha siki bir
--      deger ezilmez). Hepsiburada'nin aylik kosu siniri 0075'ten beri NULL'du: beyan edilen 400
--      yazilir (yalniz NULL ise). Trendyol'un 7 gun / ayda 4 politikasi DEGISMEZ (sahip rol
--      gunceller; `collection_source_reported_scope` 'written_email_reported' icin gevsetmeye
--      izin vermez).
--
-- GERIYE UYUMLU: yeni NULL'a izin veren kolon; tetikleyici yalniz yeni bir kisit ekler. Eski kod
-- kolonu okumaz ve calismaya devam eder. Geri alma: once kod; kolon zararsiz kalir.

ALTER TABLE collection_source
    ADD COLUMN IF NOT EXISTS max_runs_per_week SMALLINT
        CHECK (max_runs_per_week IS NULL OR max_runs_per_week >= 1);

COMMENT ON COLUMN collection_source.max_runs_per_week IS
    'Kayan 7 gunde en fazla kosu (released disi); NULL = uygulanmaz (karar 0220/0221).';

UPDATE collection_source SET max_runs_per_week = 100
 WHERE source IN ('hepsiburada', 'trendyol') AND max_runs_per_week IS NULL;

UPDATE collection_source SET max_runs_per_month = 400
 WHERE source = 'hepsiburada' AND max_runs_per_month IS NULL;

CREATE OR REPLACE FUNCTION collection_run_quota_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    pol collection_source%ROWTYPE;
    last_at TIMESTAMPTZ;
    next_at TIMESTAMPTZ;
    month_runs INTEGER;
    week_runs INTEGER;
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

    -- 0119 (karar 0220/0221): kayan 7 gunde en fazla kosu (NULL = uygulanmaz).
    IF pol.max_runs_per_week IS NOT NULL THEN
        SELECT count(*) INTO week_runs
          FROM collection_run
         WHERE source = NEW.source AND status <> 'released'
           AND NOT (kind = 'initial' AND pol.initial_load_exempt)
           AND reserved_at > NEW.reserved_at - interval '7 days';
        IF week_runs >= pol.max_runs_per_week THEN
            RAISE EXCEPTION 'collection_quota_week' USING ERRCODE = 'P0001';
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
