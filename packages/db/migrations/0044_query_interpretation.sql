-- 0044 — cevrimdisi model sorgu yorumu onbellegi (docs/decisions/0059)
--
-- Toplu is, sik aranan ve deterministik netlestirmenin domain bulamadigi
-- normalize sorgulari modele (bugun Gemini) yorumlatir; dogrulanan sonuc
-- burada saklanir (CLAUDE.md kural 3). Arama istegi ileride YALNIZCA bu
-- tabloyu okur; istek yolunda model cagrisi yoktur (kural 1).
--
-- Kimlik: (normalize sorgu, taksonomi ozeti, model surumu). `taxonomy_hash`
-- modele giden sozlesmenin (taksonomi, JSON semasi, talimatlar) SHA-256
-- ozetidir: kural sozlugu ya da talimat degisince ayni sorgu yeniden
-- yorumlanabilir; degismezse ikinci kez modele gitmez. Gecersiz cikti da
-- saklanir ki ayni surumde yeniden denenmesin.
--
-- Kisisel veri YOK: kullanici, oturum, IP, etkinlik olayi baglantisi yok.
-- `query_norm`, `search_query_day`/`query_resolution` ile ayni sinifta
-- (kimliksiz, kisisel veri suzgecinden gecmis normalize sorgu). Ham model
-- yaniti, istem ve sir SAKLANMAZ: `interpretation` dogrulanmis kimlikler ve
-- kurus cinsinden butcedir; `rejected` yalnizca dogrulamanin sabit yol/neden
-- kodlaridir. Saglayici hatasi satir uretmez (sonraki kosuda yeniden denenir).
--
-- Yalnizca ekleme; geri alinmasi DROP TABLE.

CREATE TABLE IF NOT EXISTS query_interpretation (
    id              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    query_norm      TEXT        NOT NULL CHECK (char_length(query_norm) BETWEEN 1 AND 200),
    taxonomy_hash   TEXT        NOT NULL CHECK (taxonomy_hash ~ '^[0-9a-f]{64}$'),
    model_version   TEXT        NOT NULL CHECK (char_length(model_version) BETWEEN 1 AND 100),
    -- accepted: en az bir alan dogrulandi; empty: model gecerli bicimde bir
    -- sey bulamadi; invalid: cikti nesne degil ya da her alani reddedildi.
    status          TEXT        NOT NULL CHECK (status IN ('accepted', 'empty', 'invalid')),
    -- Dogrulanmis yorum (domainId, facets, budget, pricePreference); yalnizca accepted.
    interpretation  JSONB,
    -- [{path, reason}] - validateInterpretation'in sabit kodlari.
    rejected        JSONB       NOT NULL DEFAULT '[]'::jsonb
                    CHECK (jsonb_typeof(rejected) = 'array' AND pg_column_size(rejected) <= 2048),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT query_interpretation_identity UNIQUE (query_norm, taxonomy_hash, model_version),
    CONSTRAINT query_interpretation_accepted_value CHECK (
        (status = 'accepted') = (interpretation IS NOT NULL)
    ),
    CONSTRAINT query_interpretation_value_shape CHECK (
        interpretation IS NULL OR jsonb_typeof(interpretation) = 'object'
    )
);
