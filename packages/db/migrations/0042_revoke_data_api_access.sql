-- 0042 — Supabase Data API erisimini kapatma (docs/decisions/0057)
--
-- Uygulama veritabanina yalnizca sunucudan, `arilla_app` roluyle baglanir
-- (docs/ops.md "Veritabani erisim yuzeyi"). Supabase'in varsayilan
-- yetkileri ise `public` semadaki her tabloyu, sequence'i ve fonksiyonu
-- `anon` ve `authenticated` rollerine aciyordu; Data API (PostgREST /
-- pg_graphql) acik oldugu icin publishable anahtari olan herkes bu tablolari
-- HTTP uzerinden okuyup yazabiliyordu. RLS bu modelin parcasi degildir
-- (0049): istemciye acik tablo yoktur, bu yuzden policy yazilmaz, yetki
-- tamamen geri alinir (deny-by-default).
--
-- Yapilanlar (yalnizca rol varsa; yerel ve CI veritabanlarinda bu roller
-- yoktur ve migration hicbir sey yapmaz):
-- 1. `public` semadaki tum tablo ve sequence'larda `anon`/`authenticated`
--    yetkileri geri alinir.
-- 2. Migration rolunun sahibi oldugu `public` fonksiyonlarinda (tetikleyici
--    fonksiyonlarimiz) EXECUTE geri alinir. Eklenti fonksiyonlari (pgvector,
--    pg_trgm) `supabase_admin`'e aittir, saf hesaplama yapar ve bu rolle
--    geri alinamaz; dokunulmaz.
-- 3. Migration rolunun (`current_user`; production'da tum `public`
--    objelerinin sahibi `postgres`) varsayilan yetkileri: bundan sonra
--    olusturulan tablo, sequence ve fonksiyonlar bu rollere otomatik
--    acilmaz. `supabase_admin`'in varsayilan yetkileri yalnizca o role
--    uyelik varsa duzeltilir (Supabase'de yoktur; ops.md'de not).
--
-- Dokunulmayanlar: `arilla_app` (0010 yetkileri aynen kalir), `service_role`
-- (gizli anahtar, kodda kullanilmiyor; ayri karar), sema USAGE yetkisi,
-- Supabase'in kendi semalari (auth, storage, graphql, realtime).
--
-- Tekrar calistirilabilir: REVOKE ve ALTER DEFAULT PRIVILEGES idempotenttir.
-- Geriye uyumlu: kolon ya da tablo degismez.

DO $$
DECLARE
    target  text;
    fn      regprocedure;
BEGIN
    FOREACH target IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target) THEN
            RAISE NOTICE '0042: % rolu yok, atlandi', target;
            CONTINUE;
        END IF;

        EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', target);
        EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', target);

        FOR fn IN
            SELECT p.oid::regprocedure
              FROM pg_proc p
              JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public'
               AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
        LOOP
            EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', fn, target);
        END LOOP;

        EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', target);
        EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', target);
        EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', target);

        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin')
           AND pg_has_role(current_user, 'supabase_admin', 'MEMBER') THEN
            EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON TABLES FROM %I', target);
            EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', target);
            EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', target);
        END IF;
    END LOOP;
END
$$;
