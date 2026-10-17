-- kind: schema
-- 0077 — yinelenen ve sicak yazimi bozan indeksleri kaldir
--
-- Her biri baska bir indeksin (cogu PK/UNIQUE) bas kolonlariyla birebir ayni ya
-- da onun alt kumesidir; okuyan sorgu ayni plani digerinden alir. Kaldirmak her
-- INSERT/UPDATE'teki indeks yazimini azaltir:
--
--   price_point_offer_time_idx (offer_id, observed_at DESC)
--       = PRIMARY KEY (offer_id, observed_at). B-tree geriye de taranir. En buyuk
--       append-only tabloda her fiyat noktasi iki kez indeksleniyordu.
--   embedding_target_idx (target_type, target_id)
--       embedding_uniq (target_type, target_id, kind, model_version) on eki.
--       0014 silme tetikleyicileri de ayni on ekle cozulur.
--   user_consent_idx (user_id, kind, granted_at DESC)
--       user_consent_latest_idx (..., id DESC) on eki (0037).
--   auth_token_cleanup_idx (expires_at) WHERE consumed_at IS NULL
--       auth_token_expires_idx (expires_at) bunu kapsar (0030); temizlik isi
--       zaten tam indeksi kullanir.
--   discovery_slot_date_idx (slot_date)
--       PRIMARY KEY (slot_date, position) on eki.
--   query_resolution_popular_idx (hit_count DESC)
--       Her /ara isteginde artan kolonu indeksliyordu: HOT guncellemeyi engelliyor,
--       her isabette indeks de yaziliyordu. Tek okuyucu (yonetim kademe-3 listesi)
--       parser_tier + last_used_at ile suzer, kucuk kumede siralar.
--
-- GERIYE UYUMLU: yalnizca indeks kaldirilir; kod hicbir indeks adina bagli degil.
-- DROP INDEX tablo uzerinde kisa ACCESS EXCLUSIVE kilit alir; calistiricinin
-- lock_timeout'u (5 s) bekleyen yazimlari uzun sure tutmaz, kilit alinamazsa
-- migration duser ve tekrar denenir. IF EXISTS: elle onceden kaldirilmissa bos gecer.

DROP INDEX IF EXISTS price_point_offer_time_idx;
DROP INDEX IF EXISTS embedding_target_idx;
DROP INDEX IF EXISTS user_consent_idx;
DROP INDEX IF EXISTS auth_token_cleanup_idx;
DROP INDEX IF EXISTS discovery_slot_date_idx;
DROP INDEX IF EXISTS query_resolution_popular_idx;
