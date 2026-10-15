-- kind: schema
-- 0073 — Katalog kesif defteri ve sitemap kosu altyapisi (karar 0120, 0117 altyapisi)
--
-- 0070'in kota defteri (collection_source / collection_run / collection_unit) AYNEN
-- kullanilir. Burada yalnizca:
--   1) kaynak politikasina GUVENLIK SINIRLARI (istek araligi, indirme bayt tavani, engel
--      sogumasi, ilk yukleme kosu suresi). Mevcut `collection_source` SATIRLARI DEGISMEZ:
--      yeni kolonlar muhafazakar varsayilanla gelir; istek/aralik/ay kotasi aynidir.
--   2) kosuya bayt muhasebesi + ONAY kapisi (buyuk indirme onaysiz baslamaz) + aktarim
--      kaynagi (VPS / Wi-Fi / mobil) etiketi.
--   3) kapsam birimine 'sitemap_file' turu, 'pending' durumu (kaldigi yerden devam), deneme
--      ve bayt sayaci.
--   4) `catalog_discovery`: fiyat ZORUNLU OLMAYAN urun kesif defteri. offer DEGILDIR
--      (offer.price zorunlu); fiyat sutunu yoktur, fiyat uydurulmaz.
--
-- Geriye uyumlu: yeni kolonlar/tablo, CHECK'ler yalnizca genisletilir. Kota tetikleyicisi
-- ayni mantikla yeniden tanimlanir (yalniz ek alanlar yazilir). Mevcut kosular etkilenmez
-- (max_bytes = 0: eski kosular indirme onayi alamaz; yeni kosular politikadan alir).
--
-- 0072 (Trendyol, acik PR #149) `collection_unit_kind_check`'i yeniden tanimlar. Hangisi
-- sonra gelirse gelsin kume BIRLESIK olmali: ('query','product_page','listing_page',
-- 'sitemap_file'). Bu dosya birlesik kumeyi yazar; #149 rebase'te 'sitemap_file'i eklemelidir.

-- ---------------------------------------------------------------------------
-- 1) POLITIKA: guvenlik sinirlari (hepsi ayarlanabilir; sinirsiz erisim varsayilmaz)
-- ---------------------------------------------------------------------------
ALTER TABLE collection_source
    -- NULL = run_window_days. Sitemap ile ilk yukleme 6 gunden uzun surebilir; yalnizca
    -- 'initial' kosu icin gecerli. Tek acik kosu kurali ust uste binmeyi yine engeller.
    ADD COLUMN initial_run_window_days SMALLINT
        CHECK (initial_run_window_days IS NULL OR initial_run_window_days BETWEEN 1 AND 60),
    -- Ardisik iki kaynak istegi arasi en az sure. Sunucu, toplu gonderilen birimlerin
    -- fetched_at araligindan hiz ihlalini reddeder; istemci ayrica beklemekle yukumludur.
    ADD COLUMN min_request_interval_ms INTEGER NOT NULL DEFAULT 2000
        CHECK (min_request_interval_ms >= 1000),
    -- Kosu basina indirilebilecek en fazla bayt (sikistirilmamis gövde). Varsayilan 1 GiB:
    -- kasitli olarak kucuk; buyuk indirme ayrica politika + kosu onayi ister.
    ADD COLUMN initial_max_bytes BIGINT NOT NULL DEFAULT 1073741824 CHECK (initial_max_bytes > 0),
    ADD COLUMN refresh_max_bytes BIGINT NOT NULL DEFAULT 1073741824 CHECK (refresh_max_bytes > 0),
    -- 403/429/dogrulama sayfasi (blocked birim) sonrasi bu kosuda yeni birim kabul edilmez.
    ADD COLUMN blocked_cooldown_minutes INTEGER NOT NULL DEFAULT 60
        CHECK (blocked_cooldown_minutes >= 1);

COMMENT ON COLUMN collection_source.initial_run_window_days IS
    'NULL = run_window_days. Yalniz ilk yukleme kosusunun suresi (gun, <= 60). Karar 0120.';
COMMENT ON COLUMN collection_source.min_request_interval_ms IS
    'Ardisik kaynak istekleri arasi en az sure (ms, >= 1000). Karar 0120.';
COMMENT ON COLUMN collection_source.initial_max_bytes IS
    'Ilk yukleme kosusu bayt tavani; ustu icin once politika degisir, sonra kosu onayi alinir.';
COMMENT ON COLUMN collection_source.blocked_cooldown_minutes IS
    'Engel (blocked) gorulen kosuda yeni birim kabul edilmeden once beklenecek dakika.';

-- ---------------------------------------------------------------------------
-- 2) KOSU: bayt muhasebesi, indirme onayi, aktarim kaynagi
-- ---------------------------------------------------------------------------
ALTER TABLE collection_run
    ADD COLUMN max_bytes BIGINT NOT NULL DEFAULT 0 CHECK (max_bytes >= 0),
    ADD COLUMN bytes_downloaded BIGINT NOT NULL DEFAULT 0 CHECK (bytes_downloaded >= 0),
    -- Yonetici onayi: bu kosuda indirilmesine IZIN VERILEN toplam bayt. 0 = onay yok.
    ADD COLUMN download_approved_bytes BIGINT NOT NULL DEFAULT 0
        CHECK (download_approved_bytes >= 0),
    ADD COLUMN download_approved_by BIGINT REFERENCES app_user(id) ON DELETE SET NULL,
    ADD COLUMN download_approved_at TIMESTAMPTZ,
    -- Verinin hangi agdan indigi (operasyon raporu icin; sunucu dogrulayamaz, beyandir).
    ADD COLUMN transfer_origin TEXT NOT NULL DEFAULT 'unknown'
        CHECK (transfer_origin IN ('unknown', 'vps', 'admin_wifi', 'admin_wired', 'admin_mobile')),
    ADD CONSTRAINT collection_run_bytes_order
        CHECK (bytes_downloaded <= download_approved_bytes AND download_approved_bytes <= max_bytes);

COMMENT ON COLUMN collection_run.download_approved_bytes IS
    'Yonetici onayli indirme tavani (bayt); bytes_downloaded bunu, bu da max_bytes (politika) tavanini asamaz.';
COMMENT ON COLUMN collection_run.transfer_origin IS
    'Veri aktariminin ag kaynagi beyani: vps / admin_wifi / admin_wired / admin_mobile / unknown.';

-- Kota tetikleyicisi: 0070 ile AYNI mantik; ek olarak ilk yukleme kosu suresi ve bayt tavani.
CREATE OR REPLACE FUNCTION collection_run_quota_guard() RETURNS trigger
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
    NEW.bytes_downloaded := 0;
    NEW.download_approved_bytes := 0;
    NEW.download_approved_by := NULL;
    NEW.download_approved_at := NULL;
    -- Ilk koşu = kota defterinde kotaya sayilan baska koşu yok.
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

    -- 'released' (hic istek atilmadan birakilan) kosu kotadan dusulur.
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

    SELECT count(*) INTO month_runs
      FROM collection_run
     WHERE source = NEW.source AND status <> 'released'
       AND NOT (kind = 'initial' AND pol.initial_load_exempt)
       AND date_trunc('month', reserved_at AT TIME ZONE 'UTC')
         = date_trunc('month', NEW.reserved_at AT TIME ZONE 'UTC');
    IF month_runs >= pol.max_runs_per_month THEN
        RAISE EXCEPTION 'collection_quota_month' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END $$;

-- Degismezlik tetikleyicisi: 0070 ile AYNI; ek olarak bayt tavani degismez, sayaclar azalmaz.
CREATE OR REPLACE FUNCTION collection_run_immutable_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.source IS DISTINCT FROM OLD.source
       OR NEW.reserved_at IS DISTINCT FROM OLD.reserved_at
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
       OR NEW.max_requests IS DISTINCT FROM OLD.max_requests
       OR NEW.max_bytes IS DISTINCT FROM OLD.max_bytes
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
    IF NEW.bytes_downloaded < OLD.bytes_downloaded
       OR NEW.download_approved_bytes < OLD.download_approved_bytes THEN
        RAISE EXCEPTION 'collection_bytes_decrease' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.status <> 'open' AND NEW.closed_at IS NULL THEN
        NEW.closed_at := now();
    END IF;
    RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- 3) KAPSAM BIRIMI: sitemap dosyasi, bekleyen birim, deneme ve bayt
-- ---------------------------------------------------------------------------
-- 'sitemap_file': unit_key = indeksteki dosya yolu, page = 1. 'listing_page': liste/kategori
-- sayfasi (page 1..1000; tek listede ~278 sayfa gorulebilir).
ALTER TABLE collection_unit
    DROP CONSTRAINT collection_unit_kind_check,
    ADD CONSTRAINT collection_unit_kind_check
        CHECK (kind IN ('query', 'product_page', 'listing_page', 'sitemap_file')),
    DROP CONSTRAINT collection_unit_page_check,
    ADD CONSTRAINT collection_unit_page_check CHECK (page BETWEEN 1 AND 1000),
    DROP CONSTRAINT collection_unit_status_check,
    ADD CONSTRAINT collection_unit_status_check
        CHECK (status IN ('pending', 'done', 'empty', 'failed', 'blocked'));

-- Bekleyen birim henuz istenmedi: fetched_at bos olabilir (yalniz 'pending' icin).
ALTER TABLE collection_unit ALTER COLUMN fetched_at DROP NOT NULL;
ALTER TABLE collection_unit
    ADD CONSTRAINT collection_unit_fetched_required
        CHECK (status = 'pending' OR fetched_at IS NOT NULL),
    -- Planlanan sira (sitemap indeksindeki konum); devam ederken bu siraya gidilir.
    ADD COLUMN unit_seq INTEGER CHECK (unit_seq IS NULL OR unit_seq >= 0),
    ADD COLUMN attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    ADD COLUMN bytes_received BIGINT NOT NULL DEFAULT 0 CHECK (bytes_received >= 0);

-- Kaldigi yerden devam: bir kosunun bekleyen/basarisiz birimleri sirayla.
CREATE INDEX collection_unit_resume_idx
    ON collection_unit (run_id, kind, unit_seq)
    WHERE status IN ('pending', 'failed');

-- ---------------------------------------------------------------------------
-- 4) KESIF DEFTERI: fiyatsiz urun kimligi (sitemap'ten)
-- ---------------------------------------------------------------------------
-- Birincil anahtar dogal anahtardir (source, external_id): ayni urun tekrar kesfedilince
-- yeni satir olusmaz. Vekil kimlik yoktur; 8 milyon sabit sinir degildir (yuz milyon satira
-- olceklenebilir sekilde dar tutuldu). FIYAT KOLONU YOKTUR: fiyat yalnizca dogrulanmis
-- kaynak kaydindan `catalog_intake_record` -> `offer` yoluyla gelir; burada yalnizca durumu
-- izlenir. Bu kayit tek basina `offer` degildir ve fiyat uydurulmaz.
CREATE TABLE catalog_discovery (
    source             TEXT        NOT NULL REFERENCES collection_source(source),
    -- Hepsiburada urun kodu (URL sonundaki -pm-/-p- kodu: HBC0000KHSC74, HBCV00009Z3XOE).
    external_id        TEXT        NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 100),
    -- 'pm' = urun modeli (grup) adresi, 'p' = varyant adresi.
    code_kind          TEXT        NOT NULL CHECK (code_kind IN ('pm', 'p')),
    url                TEXT        NOT NULL CHECK (char_length(url) <= 2048 AND url ~ '^https://'),
    title              TEXT        CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 500),
    image_url          TEXT        CHECK (image_url IS NULL
                                          OR (char_length(image_url) <= 2048 AND image_url ~ '^https://')),
    -- Urunun SON goruldugu kaynak sitemap dosyasi (unit_key).
    source_unit_key    TEXT        NOT NULL CHECK (char_length(source_unit_key) BETWEEN 1 AND 200),
    first_seen_run_id  BIGINT      NOT NULL REFERENCES collection_run(id),
    last_seen_run_id   BIGINT      NOT NULL REFERENCES collection_run(id),
    first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Fiyat durumu (fiyat degeri DEGIL):
    --   unpriced       fiyat hic alinmadi (varsayilan)
    --   listing_price  liste sayfasinda goruldu, ara depoya yazildi; bagimsiz dogrulanmadi
    --   page_verified  urun sayfasiyla dogrulandi
    --   stale          bir zamanlar fiyat vardi, taze degil
    --   unavailable    kontrol edildi, fiyat/satis yok
    price_state        TEXT        NOT NULL DEFAULT 'unpriced'
                       CHECK (price_state IN ('unpriced', 'listing_price', 'page_verified',
                                              'stale', 'unavailable')),
    price_checked_at   TIMESTAMPTZ,
    PRIMARY KEY (source, external_id),
    CONSTRAINT catalog_discovery_seen_order CHECK (last_seen_at >= first_seen_at),
    CONSTRAINT catalog_discovery_price_checked
        CHECK ((price_state = 'unpriced') = (price_checked_at IS NULL))
) WITH (
    -- Her haftalik tarama last_seen_* yazar; HOT guncelleme icin sayfada bos yer birakilir
    -- (son goruldu kolonlari indekslenmez). Karar 0120 olcumleri.
    fillfactor = 85,
    autovacuum_vacuum_scale_factor = 0.02,
    autovacuum_vacuum_insert_scale_factor = 0.05
);

COMMENT ON TABLE catalog_discovery IS
    'Fiyatsiz urun kesif defteri (sitemap). offer DEGILDIR; fiyat kolonu yoktur. Karar 0120.';
COMMENT ON COLUMN catalog_discovery.price_state IS
    'Fiyat durumu, fiyat degeri degil: unpriced/listing_price/page_verified/stale/unavailable.';

-- Defterden satir silinemez; icerik kosu sirasinda guncellenir.
REVOKE DELETE, TRUNCATE ON catalog_discovery FROM arilla_app;
