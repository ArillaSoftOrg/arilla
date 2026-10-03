-- 0032 — kullanici geri bildirimi (docs/decisions/0045)
--
-- `/geri-bildirim` formu. Girisli kullanici da anonim ziyaretci de yazar;
-- tarayici tabloya dogrudan yazmaz, tek yol server action ->
-- `packages/core/src/feedback/submit-feedback.ts`. `user_id` yalnizca
-- sunucudaki oturumdan gelir.
--
-- - `source`: 'early_access' (girisli) | 'public' (anonim).
-- - `status`: uygulama yalnizca 'new' yazar. Ileride yonetim paneli icin
--   gereken degerler simdiden CHECK'te; genisletme migration'i gerekmez.
-- - `email`: anonimde istege bagli; girisli kullanicida hesap e-postasi
--   (telefon/Apple ile e-postasiz hesapta NULL).
-- - Uzunluk CHECK'leri uygulama sinirlarindan (baslik 3-120, mesaj
--   10-5000) bilerek genis: motor yalnizca bos ve asiri buyuk satiri
--   reddeder, asil dogrulama core'dadir.
--
-- Hesap silinince kullanicinin geri bildirimleri de silinir (ON DELETE
-- CASCADE, docs/kvkk.md "silme gercek olmalidir"); satir hesap e-postasini
-- tasiyabildigi icin SET NULL kisisel veri birakirdi.
-- arilla_app yetkisi 0010'daki ALTER DEFAULT PRIVILEGES'ten gelir.
-- Geriye uyumlu: yalnizca yeni tablo ve indeksler.

CREATE TABLE IF NOT EXISTS feedback (
    id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT      REFERENCES app_user(id) ON DELETE CASCADE,
    email       TEXT        CHECK (email IS NULL OR char_length(email) BETWEEN 3 AND 254),
    category    TEXT        NOT NULL CHECK (category IN
                    ('suggestion','bug','feature_request','ux','product_store','other')),
    title       TEXT        NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
    message     TEXT        NOT NULL CHECK (char_length(btrim(message)) BETWEEN 1 AND 10000),
    priority    TEXT        CHECK (priority IN ('low','medium','high')),
    status      TEXT        NOT NULL DEFAULT 'new' CHECK (status IN
                    ('new','reviewing','planned','resolved','rejected')),
    source      TEXT        NOT NULL CHECK (source IN ('public','early_access')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Girisli gonderim her zaman 'early_access', anonim her zaman 'public'.
    CONSTRAINT feedback_source_matches_user CHECK (
        (user_id IS NULL AND source = 'public') OR (user_id IS NOT NULL AND source = 'early_access')
    )
);

CREATE INDEX IF NOT EXISTS feedback_created_idx ON feedback (created_at DESC);
CREATE INDEX IF NOT EXISTS feedback_user_idx ON feedback (user_id) WHERE user_id IS NOT NULL;
