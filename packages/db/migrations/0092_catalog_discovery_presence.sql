-- kind: schema
-- 0092 — keşif defterinde kaldırılma takibi (karar 0140)
--
-- Yalnızca ekleme. Mevcut satırlar `present` ve `missed_scans = 0` ile gelir; hiçbir
-- satır silinmez (REVOKE DELETE 0073'te zaten var). Kaldırma hesabı yalnızca BAŞARILI
-- ve kapsamı doğrulanmış tam taramalarda ilerler (uygulama kodu: discovery-presence.ts).
--
--   presence      present  son tam taramada görüldü
--                 missing  son tam taramada görülmedi (henüz eşik dolmadı)
--                 removed  ardışık REMOVAL_MISSED_SCANS tam taramada görülmedi
--   missed_scans  ardışık görülmeyen tam tarama sayısı; görülünce 0.
--
-- Sabit varsayılanlı kolon (PG 11+): tablo yeniden yazılmaz.
--
-- Tam tarama tamamlanma kontrol noktası: kaynak başına tek satır. Aynı koşu iki kez
-- uygulanmaz (idempotent) ve eski bir koşu yeni olanın üstüne yazamaz.

ALTER TABLE catalog_discovery
    ADD COLUMN presence TEXT NOT NULL DEFAULT 'present'
        CHECK (presence IN ('present', 'missing', 'removed')),
    ADD COLUMN missed_scans SMALLINT NOT NULL DEFAULT 0
        CHECK (missed_scans >= 0);

CREATE TABLE catalog_discovery_scan_state (
    source                TEXT        PRIMARY KEY REFERENCES collection_source(source),
    last_finalized_run_id BIGINT      NOT NULL REFERENCES collection_run(id),
    finalized_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
