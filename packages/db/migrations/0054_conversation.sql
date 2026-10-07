-- 0054 — konusmali urun kesfi: sohbet ve mesajlar (docs/decisions/0074)
--
-- `/sohbet/[id]`: kullanici mesaj yazar, model niyeti toplar (`clarify`) ya da
-- yapilandirilmis bir arama niyeti (`search`) dondurur; niyet mevcut aramaya
-- verilir. Model urun/fiyat uretmez; sonuclar bu tablolarda SAKLANMAZ, sayfa
-- gosterilirken saklanan niyetle aranir (fiyat/stok bayatlamaz).
--
-- Kisisel veri: `chat_message.content` kullanicinin serbest metnidir.
-- - Hesap silinince `ON DELETE CASCADE` ile gider.
-- - `last_message_at`'ten 90 gun sonra `cleanup-auth` cron'u siler.
-- - Analitik/hata kaydina girmez (CLAUDE.md).
--
-- Degismezler MOTOR tarafindan zorlanir:
-- - Mesaj sirasi: UNIQUE (conversation_id, seq).
-- - Cift gonderim: UNIQUE (conversation_id, client_request_id).
-- - Es zamanli tur: `processing_until` kirasi (uygulama tek atomik UPDATE kullanir).
-- - Sohbet kimligi tahmin edilemez UUID; sahiplik her sorguda `user_id` ile.
-- - Mesajlar eklenir, degistirilmez: arilla_app'ten UPDATE geri alinir.
--
-- Yalnizca ekleme; geri alinmasi DROP TABLE chat_message, conversation.

CREATE TABLE IF NOT EXISTS conversation (
    id                     UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id                BIGINT      NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    -- Normalize edilmis, birlestirilmis arama niyeti; NULL = henuz arama yok.
    current_search_intent  JSONB,
    -- Acik netlestirme sorusu (son asistan mesajinin `payload.question`i); NULL = yok.
    -- Sunucu "bu secenek gecerli mi" kontrolunu bundan yapar.
    pending_question       JSONB,
    -- Modelin onerdigi kisa baslik degil, ilk mesajin ilk 80 karakteri.
    title                  TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
    -- Atomik kira: model cagrisi suresince bir tur sahiplenir; sure dolunca duser.
    processing_until       TIMESTAMPTZ,
    message_count          INTEGER     NOT NULL DEFAULT 0 CHECK (message_count >= 0),
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_message_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT conversation_intent_shape CHECK (
        current_search_intent IS NULL OR (
            jsonb_typeof(current_search_intent) = 'object'
            AND pg_column_size(current_search_intent) <= 4096)
    ),
    CONSTRAINT conversation_question_shape CHECK (
        pending_question IS NULL OR (
            jsonb_typeof(pending_question) = 'object'
            AND pg_column_size(pending_question) <= 4096)
    )
);

CREATE INDEX IF NOT EXISTS conversation_user_recent_idx
    ON conversation (user_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS conversation_last_message_idx
    ON conversation (last_message_at);

CREATE TABLE IF NOT EXISTS chat_message (
    id                 BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    conversation_id    UUID        NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    seq                INTEGER     NOT NULL CHECK (seq >= 1),
    role               TEXT        NOT NULL CHECK (role IN ('user', 'assistant')),
    -- user: text | option | skip; assistant: clarify | search | notice.
    kind               TEXT        NOT NULL,
    content            TEXT        NOT NULL CHECK (char_length(content) BETWEEN 1 AND 2000),
    -- clarify: {question}; search: {intent, source}; option: {questionId, value}.
    payload            JSONB,
    -- Istemcinin tur basina urettigi opak anahtar; yalnizca tekillestirme icindir.
    client_request_id  TEXT        CHECK (client_request_id IS NULL
                                          OR char_length(client_request_id) BETWEEN 8 AND 100),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chat_message_order UNIQUE (conversation_id, seq),
    CONSTRAINT chat_message_role_kind CHECK (
        (role = 'user' AND kind IN ('text', 'option', 'skip'))
        OR (role = 'assistant' AND kind IN ('clarify', 'search', 'notice'))
    ),
    CONSTRAINT chat_message_payload_shape CHECK (
        payload IS NULL OR (jsonb_typeof(payload) = 'object' AND pg_column_size(payload) <= 4096)
    )
);

-- Ayni tur iki kez gonderilemez; yalnizca kullanici mesajlarinda anahtar var.
CREATE UNIQUE INDEX IF NOT EXISTS chat_message_request_unique
    ON chat_message (conversation_id, client_request_id)
    WHERE client_request_id IS NOT NULL;

REVOKE UPDATE ON chat_message FROM arilla_app;
