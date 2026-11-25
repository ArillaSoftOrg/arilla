-- kind: schema
-- 0119 — Yonetici tarayicisi toplamasi icin zamanlama (karar 0221 §B; 0118'i degistirir)
--
-- Kaynak basina (collection_source) TEK satir: zamanlanmis koşunun hedef adres listesi, hizi ve
-- son denemenin sonucu. Toplama yine YALNIZ yoneticinin kendi tarayicisinda, eklentiyle yapilir;
-- sunucu kaynaga istek ATMAZ. Kota (en az 7 gun, ayda 4, ilk yukleme dahil) DEGISMEZ: zamanlanmis
-- koşu da `collection_run` satiridir ve 0070/0075 tetikleyicisinden gecer.
--
-- KAPALI gelir: satir yoksa ya da `enabled = FALSE` ise zamanlayici calismaz. Ayrica ortam
-- bayragi (`<KAYNAK>_SCHEDULE_ENABLED`) ve `collection_source.enabled` gerekir.
--
-- GERIYE UYUMLU: yalniz yeni tablo. Geri alma: once kod geri alinir; tablo zararsiz kalir.

CREATE TABLE IF NOT EXISTS collection_schedule (
    source            TEXT        PRIMARY KEY REFERENCES collection_source(source),
    enabled           BOOLEAN     NOT NULL DEFAULT FALSE,
    -- Zamanlanmis koşuda sirayla acilacak kaynak adresleri (dogrulama uygulamada; kaynaga gore).
    target_urls       JSONB       NOT NULL DEFAULT '[]'::jsonb
                      CHECK (jsonb_typeof(target_urls) = 'array' AND jsonb_array_length(target_urls) <= 500),
    -- Iki sayfa acilisi arasi en kisa sure (saniye); tarayici buna rastgele ek bekleme koyar.
    pace_seconds      INTEGER     NOT NULL DEFAULT 45 CHECK (pace_seconds BETWEEN 20 AND 600),
    updated_by        BIGINT      REFERENCES app_user(id) ON DELETE SET NULL,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Son zamanlanmis deneme (yonetim gorunurlugu ve bulgular).
    last_attempt_at   TIMESTAMPTZ,
    last_run_id       BIGINT      REFERENCES collection_run(id) ON DELETE SET NULL,
    last_outcome      TEXT        CHECK (last_outcome IS NULL OR last_outcome IN
                                         ('completed', 'aborted', 'blocked', 'budget', 'interrupted',
                                          'start_refused', 'error')),
    -- Kisa makine kodu (or. `structure_missing`, `collection_quota_interval`); kisisel veri yok.
    last_error_code   TEXT        CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]{2,60}$'),
    last_finished_at  TIMESTAMPTZ
);

-- Zamanlama satiri silinmez (gecmis sonuc kaybolmasin); kapatmak icin enabled = FALSE.
REVOKE DELETE, TRUNCATE ON collection_schedule FROM arilla_app;
