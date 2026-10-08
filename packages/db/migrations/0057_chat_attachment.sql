-- 0057 — sohbet gorsel eki (docs/decisions/0078)
--
-- Kullanici ilk mesajina bir urun fotografi ekleyebilir. Gorsel `preprocessImage`
-- ciktisidir (en uzun kenar <= 512, EXIF/GPS yok, JPEG/PNG) ve KUCUKTUR; ayri obje
-- deposu yerine burada tutulur: R2 kovasi herkese aciktir, kullanici fotografi
-- orada durmamali. Yalnizca sahibine, kimlikli bir rotadan sunulur.
--
-- Saklama: sohbetle birlikte (ON DELETE CASCADE; 90 gun cron'u ve hesap silme).
-- Mesaj `payload.attachmentId` ile bu satira baglanir. Eklenir, degistirilmez.
--
-- Yalnizca ekleme; geri alinmasi DROP TABLE chat_attachment.

CREATE TABLE IF NOT EXISTS chat_attachment (
    id               UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id  UUID        NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    user_id          BIGINT      NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    mime_type        TEXT        NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png')),
    data             BYTEA       NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 524288),
    width            INTEGER     NOT NULL CHECK (width BETWEEN 1 AND 4096),
    height           INTEGER     NOT NULL CHECK (height BETWEEN 1 AND 4096),
    sha256           TEXT        NOT NULL CHECK (char_length(sha256) = 64),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_attachment_conversation_idx
    ON chat_attachment (conversation_id);

REVOKE UPDATE ON chat_attachment FROM arilla_app;
