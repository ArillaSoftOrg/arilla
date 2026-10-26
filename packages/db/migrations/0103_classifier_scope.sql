-- kind: schema
-- 0103 — dinamik kategori adayi kapsami (karar 0154): hangi kategori dallarina siniflandirici
-- baslik/kaynak kanitiyla yazabilir.
--
-- Trendyol'dan gelen ~3.862 kategori (0102) varsayilan olarak siniflandiriciya KAPALIDIR: bu tablo
-- BOS acilir ve satir yoksa hicbir dal etkin degildir (siniflandirici V5 davranisi aynen). Bir dalin
-- altindaki kategorilere yazabilmesi icin elle ve gerekceyle `mode = 'apply'` satiri eklenir
-- (`python -m classify scope set ... --confirm`; denetim izi `job_run`). `off` etkinligi geri alir,
-- satiri silmeden. Kapsam yalnizca `external_category_map` ile Trendyol'a bagli dugumler icin
-- kullanilir (CLI dogrular).
--
-- Yalnizca yeni tablo; var olan tabloya dokunulmaz. `classify` calismasi bu tabloyu yalniz
-- `--dynamic` bayragiyla okur. Geri alma: DROP TABLE classifier_scope (hicbir sey buna bagli degil).
CREATE TABLE IF NOT EXISTS classifier_scope (
    scope_category_id  BIGINT      PRIMARY KEY REFERENCES category(id),
    mode               TEXT        NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'apply')),
    decided_by         TEXT        NOT NULL CHECK (char_length(btrim(decided_by)) BETWEEN 2 AND 60),
    note               TEXT        CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 200),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Etkin kapsamlar kosu basina bir kez okunur (kucuk tablo); indeks gerekmez.
