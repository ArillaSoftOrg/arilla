-- 0040 — arama kalitesi gunluk ozeti (docs/decisions/0052)
--
-- Yonetim ekraninin "sik sonucsuz / taninmayan sorgu" listesi icin en kucuk
-- olcum. OLAY tablosu DEGIL: (gun, normalize sorgu) basina tek satir, her
-- aramada sayac artar (upsert). Kimlik YOK: kullanici, oturum, IP, e-posta,
-- telefon tutulmaz. `query_norm` zaten `query_resolution`'da tutulan normalize
-- sorguyla ayni siniftadir; e-posta/telefon/adres/uzun rakam iceren sorgular
-- uygulama tarafinda (packages/core) hic yazilmaz.
--
-- Saklama: 90 gun; gunluk temizlik cron'u eski gunleri siler. Hacim, gun
-- basina farkli sorgu sayisiyla sinirlidir.
--
-- Yalnizca ekleme; geri alinmasi DROP TABLE.

CREATE TABLE IF NOT EXISTS search_query_day (
    day                DATE        NOT NULL,
    query_norm         TEXT        NOT NULL CHECK (char_length(query_norm) BETWEEN 1 AND 200),
    searches           INTEGER     NOT NULL DEFAULT 0 CHECK (searches >= 0),
    zero_results       INTEGER     NOT NULL DEFAULT 0 CHECK (zero_results >= 0),
    -- Sonuc yokken `/ara`'nin gosterdigi filtresiz yedek listeye dusenler.
    fallbacks          INTEGER     NOT NULL DEFAULT 0 CHECK (fallbacks >= 0),
    -- Netlestirme sorusu sorulanlar.
    clarifications     INTEGER     NOT NULL DEFAULT 0 CHECK (clarifications >= 0),
    last_result_count  INTEGER     CHECK (last_result_count IS NULL OR last_result_count >= 0),
    -- 2 = sozluk, 3 = model (query_resolution ile ayni).
    parser_tier        SMALLINT    CHECK (parser_tier IS NULL OR parser_tier BETWEEN 1 AND 3),
    -- Sozlukte karsiligi bulunmayan kelimeler (en fazla 8, her biri en fazla 40 karakter).
    unrecognized_terms TEXT[]      NOT NULL DEFAULT '{}'
                       CHECK (cardinality(unrecognized_terms) <= 8),
    last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (day, query_norm)
);
