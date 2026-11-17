-- kind: schema
-- 0117 — Kütüphane: aramalarda üst sıralarda çıkan ürünlerin kişisel vitrini (docs/decisions/0217)
--
-- Kütüphane arama/sohbet geçmişi DEĞİLDİR: sorgu metni, niyet, sohbet kimliği, başlık, görsel,
-- fiyat ve kategori SAKLANMAZ. Yalnızca kullanıcı-ürün ilişkisi tutulur; her şey okurken güncel
-- katalogdan (`product`, `category`) gelir. `product_view` (/gecmis) ve `saved_item`
-- (Kaydettiklerim) ile bağımsızdır; üçü birbirinden okumaz, birbirine yazmaz.
--
-- Rıza: `user_consent.kind = 'personalization'`; rıza yoksa yazılmaz (uygulama katmanı).
-- Saklama: kullanıcı başına en çok 60 satır (uygulama budar), 180 gün (cleanup-auth).
-- Hesap silinince ya da ürün katalogdan silinince satır CASCADE ile gider.
--
-- Yalnızca ekleme. Geri alma: önce kod geri alınır; tablo zararsız kalabilir.

CREATE TABLE IF NOT EXISTS library_item (
    user_id          BIGINT      NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    product_id       BIGINT      NOT NULL REFERENCES product(id) ON DELETE CASCADE,
    first_added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_surfaced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    best_rank        SMALLINT    NOT NULL CHECK (best_rank BETWEEN 1 AND 3),
    surfaced_count   INTEGER     NOT NULL DEFAULT 1 CHECK (surfaced_count >= 1),
    PRIMARY KEY (user_id, product_id)
);

CREATE INDEX IF NOT EXISTS library_item_user_recent_idx
    ON library_item (user_id, last_surfaced_at DESC, product_id DESC);
CREATE INDEX IF NOT EXISTS library_item_surfaced_idx
    ON library_item (last_surfaced_at);
