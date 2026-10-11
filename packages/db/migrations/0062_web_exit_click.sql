-- 0062 — internet arama sonuclarindan magaza cikisi kaydi (docs/decisions/0101)
--
-- CLAUDE.md kural 8: merchant'a giden her cikis bir kayit uretir. `click.offer_id`
-- NOT NULL ve `offer` tablosuna bagli; internetten gelen (katalogda OLMAYAN,
-- dogrulanmis katalog verisi sayilmayan) sonuclar icin offer satiri uydurulmaz.
-- Bu nedenle ayri, yalnizca-ekleme bir cikis defteri tutulur. `click` tablosuna
-- ve donusum (conversion) akisina dokunulmaz: web cikislari affiliate degildir.
--
-- Yalnizca ekleme: yeni tablo, mevcut kolon degismez/silinmez. Geri alma: once
-- kod geri alinir; tablo zararsiz kalir. Kisisel veri: user_id yalnizca
-- attribution; url sorgu metni tasimaz (sunucu imzali, izleme parametreleri atilmis).

CREATE TABLE IF NOT EXISTS web_exit_click (
    id             UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id        BIGINT      REFERENCES app_user(id) ON DELETE SET NULL,
    session_id     TEXT        NOT NULL,
    host           TEXT        NOT NULL CHECK (char_length(host) BETWEEN 3 AND 253),
    url            TEXT        NOT NULL CHECK (char_length(url) BETWEEN 10 AND 2048),
    match_kind     TEXT        NOT NULL CHECK (match_kind IN ('exact', 'similar')),
    -- Kurus. Yalnizca fiyat dogrulandiysa dolu; dogrulanmamis fiyat yazilmaz.
    price_at_click BIGINT      CHECK (price_at_click IS NULL OR price_at_click >= 0),
    price_status   TEXT        NOT NULL CHECK (price_status IN ('verified', 'unverified')),
    surface        TEXT        CHECK (surface IS NULL OR surface IN ('search', 'visual', 'link', 'chat')),
    result_position SMALLINT   CHECK (result_position IS NULL OR result_position BETWEEN 1 AND 500),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS web_exit_click_time_idx ON web_exit_click (created_at DESC);
CREATE INDEX IF NOT EXISTS web_exit_click_host_idx ON web_exit_click (host, created_at DESC);
CREATE INDEX IF NOT EXISTS web_exit_click_session_idx ON web_exit_click (session_id, created_at DESC);

-- arilla_app yetkisi 0010'daki ALTER DEFAULT PRIVILEGES'ten gelir; defter degistirilemez.
REVOKE UPDATE, DELETE, TRUNCATE ON web_exit_click FROM arilla_app;
