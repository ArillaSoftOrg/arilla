-- 0050 — erken erisim sayaci: platform disi kayitlar (docs/decisions/0065)
--
-- `/erken-erisim` ve lansman oncesi landing'deki ilerleme cubugu su sayiyi
-- gosterir: platform disi gercek basvurular (bu tablo) + `early_access`
-- tablosundaki gercek kayitlar. Platform disi basvurular, siteden kayit
-- olamayan ama e-postayla erken erisim isteyen gercek kisilerdir; sayiyi
-- yonetici `/yonetim/erken-erisim` ekranindan, gerekce yazarak ve denetim
-- kaydina dusen bir islemle gunceller. Takvime bagli otomatik ya da rastgele
-- artis YOKTUR: gosterilen her kisi gercek bir basvurudur.
--
-- Tek satir (id = 1 CHECK). Baslangic degeri 78: lansman karari oncesi
-- e-postayla gelen basvurular (kullanici beyani). Uygulama satiri yalnizca
-- gunceller; ekleme/silme yetkisi yoktur.
--
-- Geriye uyumlu: yeni tablo, mevcut hicbir sey degismez. Tekrar calistirilabilir.

CREATE TABLE IF NOT EXISTS early_access_counter (
    id                 SMALLINT    PRIMARY KEY DEFAULT 1
        CONSTRAINT early_access_counter_single_row CHECK (id = 1),
    off_platform_count INTEGER     NOT NULL
        CONSTRAINT early_access_counter_range CHECK (off_platform_count BETWEEN 0 AND 1000000),
    updated_by         BIGINT      REFERENCES app_user(id) ON DELETE SET NULL,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO early_access_counter (id, off_platform_count)
VALUES (1, 78)
ON CONFLICT (id) DO NOTHING;

REVOKE INSERT, DELETE, TRUNCATE ON early_access_counter FROM arilla_app;
