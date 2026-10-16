-- kind: schema
-- 0081 — sorgu istatistikleri (pg_stat_statements)
--
-- Darbogaz calismasinin olcum adimi: hangi sorgunun ne kadar sure ve okuma
-- harcadigi `node scripts/db-health.ts` raporundan okunur. Eklenti normalize
-- sorgu metnini ($1, $2 yer tutuculu) ve sayaclari tutar; parametre DEGERLERI
-- (arama metni, e-posta, kimlik) saklanmaz.
--
-- Ayri `monitoring` semasi: `public` semadaki varsayilan yetkiler (0010:
-- ALTER DEFAULT PRIVILEGES ... TO arilla_app) bu gorunumlere uzanmaz; uygulama
-- rolu sorgu metinlerini okuyamaz, sema dogrulamasi (`db:verify`) etkilenmez.
-- Yalnizca sahip rol (migration/bakim) okur.
--
-- Sayac toplanmasi `shared_preload_libraries = 'pg_stat_statements'` ister
-- (`infra/vps/postgres/postgresql.conf`; yeniden baslatma gerekir). Yuklenmemis
-- sunucuda CREATE EXTENSION yine basarili olur, gorunum okunursa hata verir;
-- rapor bunu "etkin degil" olarak gosterir. YALNIZCA EKLEME.

CREATE SCHEMA IF NOT EXISTS monitoring;
REVOKE ALL ON SCHEMA monitoring FROM PUBLIC;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA monitoring;
