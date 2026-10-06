-- 0047 — iletisim formu `feedback` tablosunu paylasir (docs/decisions/0061)
--
-- `/iletisim` formu ayri bir gonderim sistemi kurmaz: `/geri-bildirim`
-- (0032, karar 0045) ile ayni tablo, ayni yazma yolu, ayni oran siniri, ayni
-- KVKK silme/indirme kapsami. Iki tur ayni tabloda `kind` ile ayrilir.
--
-- 1. `kind`: 'feedback' (mevcut satirlar ve eski kod; varsayilan) | 'contact'.
-- 2. `name`: iletisim formunda yanit icin ad; geri bildirimde NULL.
-- 3. Kategori CHECK'i iletisim kategorileriyle genisletilir ve tur ile
--    eslestirilir: geri bildirim yalnizca eski alti degeri, iletisim yalnizca
--    kendi listesini yazabilir. Mevcut satirlarin hepsi 'feedback' ve eski
--    kategorilerde oldugu icin yeni kisitlar mevcut veriyi bozmaz.
-- 4. Iletisim gonderisinde yanit adresi ve ad zorunlu (CHECK).
--
-- Geriye uyumlu (CLAUDE.md kural 14): kolon silinmez, yeni kolonlar NULL ya da
-- sabit varsayilanli (eski kod `kind` yazmadan INSERT edebilir). Yetki
-- degismez: `arilla_app` tabloda zaten SELECT/INSERT sahibi (yonetim gelen
-- kutusu okur, form yazar).

ALTER TABLE feedback
    ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'feedback'
        CONSTRAINT feedback_kind_check CHECK (kind IN ('feedback', 'contact'));

ALTER TABLE feedback
    ADD COLUMN IF NOT EXISTS name TEXT
        CONSTRAINT feedback_name_check CHECK (name IS NULL OR char_length(btrim(name)) BETWEEN 1 AND 100);

ALTER TABLE feedback DROP CONSTRAINT IF EXISTS feedback_category_check;
ALTER TABLE feedback ADD CONSTRAINT feedback_category_check CHECK (
    (kind = 'feedback' AND category IN
        ('suggestion', 'bug', 'feature_request', 'ux', 'product_store', 'other'))
    OR
    (kind = 'contact' AND category IN
        ('general', 'account', 'price_error', 'bug', 'partnership', 'privacy', 'other'))
);

ALTER TABLE feedback DROP CONSTRAINT IF EXISTS feedback_contact_reply_address;
ALTER TABLE feedback ADD CONSTRAINT feedback_contact_reply_address CHECK (
    kind <> 'contact' OR (email IS NOT NULL AND name IS NOT NULL)
);

-- Yonetim gelen kutusu: tur suzgeciyle yeniden eskiye.
CREATE INDEX IF NOT EXISTS feedback_kind_created_idx ON feedback (kind, created_at DESC, id DESC);
