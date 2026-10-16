-- kind: schema
-- 0072 — katalog kalite denetimleri icin hedefli indeksler
--
-- /yonetim/katalog/kalite 2,8M teklifte iki denetim grubunda statement_timeout'a
-- (57014) dusuyordu:
--   * "adaysiz/reddedilmis/kabul edilmis eslesmemis teklif": her eslesmemis teklif
--     icin match_candidate aramasi yapiyordu. Artik adayi olan kume adaylardan
--     bulunur; adaysizlarin en eskileri asagidaki indeksle siralamadan okunur.
--   * "bayat teklif": offer yiginini bastan sona okuyordu. Kapsayan kismi indeks
--     yigina inmeden indeks-yalniz tarama saglar.
-- Sentetik 2,85M teklifte: adaysiz denetimi ~8 s -> ~0,3 s; bayat denetimi
-- ~6 s -> ~2 s.
--
-- YALNIZCA EKLEME. Yeni indeksler; veri ve sema degismez. `first_seen_at` hic
-- guncellenmez; `last_seen_at` yalniz degisen tekliflerde yazilir
-- (offer_unmatched_recent_idx zaten bu kolonu indeksler).
CREATE INDEX offer_unmatched_first_seen_idx ON offer (first_seen_at, id)
    WHERE product_id IS NULL AND is_active;
CREATE INDEX offer_active_seen_idx ON offer (id) INCLUDE (merchant_id, last_seen_at)
    WHERE is_active;
