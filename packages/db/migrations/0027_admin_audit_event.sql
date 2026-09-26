-- 0027 — yonetim denetim kaydi (docs/decisions/0039)
--
-- `/yonetim` altindaki her mutasyon (eslestirme onay/red, sozluk
-- ekle/duzenle/sil, ileride merchant ac/kapat) kimin, ne zaman, neyi
-- degistirdigini buraya yazar. Mutasyonla AYNI islemde yazilir: kayit
-- yazilamazsa degisiklik de geri alinir.
--
-- Bu tablo yalnizca GUVENLIK/DENETIM olaylari icindir. Isletim olaylari
-- (`ingest_run`), hata kayitlari ve analitik buraya karismaz.
--
-- Kisisel veri ve kimlik bilgisi YAZILMAZ: parola, token, cerez, IP, user
-- agent yok. `before`/`after` yalnizca kodda izin listesine alinmis,
-- hassas olmayan alanlari tasir (packages/core/src/admin/audit.ts).
--
-- Append-only (CLAUDE.md kural 4 ile ayni gerekce): arilla_app yalnizca
-- SELECT + INSERT. Denetim kaydini duzeltebilen bir uygulama rolu, denetim
-- kaydini silebilen bir saldirgan demektir.
--
-- `actor_user_id` CASCADE'siz FK: kayitli bir yoneticinin hesabi, denetim
-- izi kaybolmadan silinemez (once rol dusurulur, sonra politika karari).
-- Geriye uyumlu: yeni tablo, mevcut hicbir sey degismez.

CREATE TABLE admin_audit_event (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_user_id BIGINT      NOT NULL REFERENCES app_user(id),
    actor_role    TEXT        NOT NULL,
    action        TEXT        NOT NULL,
    target_type   TEXT        NOT NULL,
    target_id     TEXT        NOT NULL,
    before        JSONB,
    after         JSONB,
    reason        TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_event_time_idx   ON admin_audit_event (created_at DESC);
CREATE INDEX admin_audit_event_target_idx ON admin_audit_event (target_type, target_id, created_at DESC);
CREATE INDEX admin_audit_event_actor_idx  ON admin_audit_event (actor_user_id, created_at DESC);

REVOKE UPDATE, DELETE, TRUNCATE ON admin_audit_event FROM arilla_app;
