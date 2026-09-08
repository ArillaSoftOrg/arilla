-- 0010 — uygulama rolu ve append-only yetkileri
--
-- CLAUDE.md 4. kural: `price_point` degistirilemez, sadece INSERT.
-- architecture.md ayni seyi `variant_stock_event` icin soyler.
-- Bu dosya o kurali kod incelemesinden alip veritabani motoruna verir.
--
-- Not: `arilla` superuser'dir ve butun ACL kontrollerini atlar. Kuralin
-- islemesi icin uygulama AYRI ve superuser OLMAYAN bir rolle baglanmalidir.
-- Migration'lar ve bakim betikleri sahip rolle (`arilla`) calismaya devam eder.

-- Rol parolasiz ve NOLOGIN olusturulur: parola depoya girmez
-- (docs/ops.md — "Depoya asla anahtar yazilmaz").
-- LOGIN ve parola `scripts/bootstrap-app-role.ts` ile, ortam degiskeninden verilir.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arilla_app') THEN
        CREATE ROLE arilla_app NOLOGIN;
    END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO arilla_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO arilla_app;

-- Sonraki migration'larin acacagi tablolar da otomatik yetkilensin.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO arilla_app;

-- ---------------------------------------------------------------------------
-- APPEND-ONLY
-- ---------------------------------------------------------------------------
-- TRUNCATE varsayilan olarak verilmez ama acikca geri alinmasi niyeti belgeler.
REVOKE UPDATE, DELETE, TRUNCATE ON price_point          FROM arilla_app;
REVOKE UPDATE, DELETE, TRUNCATE ON variant_stock_event  FROM arilla_app;

-- `GRANT ... ON ALL TABLES` price_point partition'larina da degdi. Partitioned
-- tabloya INSERT'te yetki EBEVEYN uzerinde kontrol edilir, o yuzden
-- partition'larin kendi yetkilerine ihtiyac yok; hepsini geri aliyoruz.
-- Yeni partition'lar icin ayni islemi `scripts/partitions.ts` tekrarlar.
DO $$
DECLARE
    part regclass;
BEGIN
    FOR part IN
        SELECT inhrelid::regclass
        FROM pg_inherits
        WHERE inhparent = 'price_point'::regclass
    LOOP
        EXECUTE format('REVOKE ALL ON %s FROM arilla_app', part);
    END LOOP;
END
$$;

-- Bu noktadan sonra `arilla_app` icin gecerli olan:
--   price_point          → SELECT, INSERT
--   variant_stock_event  → SELECT, INSERT
--   diger tum tablolar   → SELECT, INSERT, UPDATE, DELETE
--
-- `offer_variant` silindiginde `variant_stock_event` cascade'i calismaya devam
-- eder: referans aksiyonlari gecerli kullanicinin degil, referans veren
-- tablonun sahibinin yetkisiyle yurutulur. Yalnizca dogrudan DELETE engellenir.
