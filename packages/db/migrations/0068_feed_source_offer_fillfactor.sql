-- kind: schema
-- 0068 — besleme uyeligi icin HOT guncelleme (karar 0114, olcum)
--
-- Her senkronizasyon her uyelik satirinin last_snapshot_id/last_seen_at'ini
-- gunceller. Sayfada bos yer birakilirsa (fillfactor) guncelleme HOT olur:
-- indeksler (pkey, offer_idx) yeniden yazilmaz, WAL ve indeks sismesi azalir.
-- Yalnizca depolama parametresi; veri ve sema degismez, tablo yeniden yazilmaz
-- (yeni sayfalara uygulanir).
ALTER TABLE feed_source_offer SET (fillfactor = 70);
