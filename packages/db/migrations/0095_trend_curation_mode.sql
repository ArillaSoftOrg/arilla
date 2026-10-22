-- kind: schema
-- 0095 — trend.curation: elle secilmis (editoryal) trend koleksiyonlari (docs/decisions/0142)
--
-- `services/ingest/curate --apply` her trend icin `trend_product` baglarini
-- "sil + ekle" ile yeniden yazar (0077). Editorun elle sectigi urunler bir
-- sonraki kosuda silinirdi. Bu kolon trendin baglarinin sahibini soyler:
--
--   'auto'   (varsayilan) — baglari curate toplu isi yazar; bugunku davranis.
--   'manual' — baglari editor yazar; curate bu trendi OKUMAZ ve YAZMAZ.
--
-- Mevcut 50 trend varsayilanla 'auto' olur: otomatik kurasyon degismez.
-- Sabit varsayilanli NOT NULL kolon PG 11+ icin yalnizca katalog degisikligidir
-- (tablo yeniden yazilmaz). Eski kod kolonu bilmeden INSERT edebilir.
--
-- Yalnizca ekleme; veri silinmez/tasinmaz, yetki degismez. Geriye uyumlu
-- (CLAUDE.md kural 14). 0092/0093 karar 0140 (acik PR #201) icin ayrilmistir.
-- Geri alma: ALTER TABLE trend DROP COLUMN curation; (once curate kodu geri alinir).

ALTER TABLE trend
    ADD COLUMN IF NOT EXISTS curation TEXT NOT NULL DEFAULT 'auto'
        CONSTRAINT trend_curation_check CHECK (curation IN ('auto', 'manual'));

COMMENT ON COLUMN trend.curation IS
    'Urun baglarinin sahibi: auto = curate toplu isi yazar, manual = editor yazar, curate dokunmaz. Karar 0142.';
