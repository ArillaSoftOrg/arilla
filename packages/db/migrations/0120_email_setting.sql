-- kind: schema
-- 0120 — Yönetimde e-posta ayarları (docs/decisions/0222)
--
-- Tek satırlı anahtar tablosu (`id = 1`). Yeni bildirimler (ekibe bildirim, ziyaretçiye onay)
-- KAPALI doğar; mevcut e-postalar (fiyat alarmı, pazarlama toplu gönderimi) AÇIK doğar, yani bu
-- migration hiçbir mevcut davranışı değiştirmez. Giriş ve kimlik bilgisi e-postalarının anahtarı
-- YOKTUR (kapatılırsa kullanıcılar giriş yapamaz).
--
-- Yalnızca ekleme. Geri alma: önce kod geri alınır; tablo zararsız kalabilir.

CREATE TABLE IF NOT EXISTS email_setting (
    id                    SMALLINT    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    team_notifications    BOOLEAN     NOT NULL DEFAULT FALSE,
    visitor_confirmations BOOLEAN     NOT NULL DEFAULT FALSE,
    price_alerts          BOOLEAN     NOT NULL DEFAULT TRUE,
    marketing_emails      BOOLEAN     NOT NULL DEFAULT TRUE,
    updated_by            BIGINT      REFERENCES app_user(id) ON DELETE SET NULL,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO email_setting (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
