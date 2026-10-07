-- 0055 — sohbet sonuc geri bildirimi: "Bu yardimci oldu mu?" (docs/decisions/0075)
--
-- Bir arama mesajinin sonuc blogu icin tek bir evet/hayir oyu. `feedback` tablosu
-- (0032) serbest metinli, yonetici triyajli bilet icindir; bu farkli bir sinyal
-- oldugu icin ayri, kucuk bir tablo. Kisisel veri YOK: yalnizca mesaj kimligi ve
-- oy; mesaj metni tasimaz. Sohbetle birlikte (hesap silme, 90 gun saklama) gider.
--
-- Mesaj basina tek oy (PRIMARY KEY); kullanici fikrini degistirebilir (UPDATE).
-- Yalnizca ekleme; geri alinmasi DROP TABLE chat_result_feedback.

CREATE TABLE IF NOT EXISTS chat_result_feedback (
    message_id       BIGINT      PRIMARY KEY REFERENCES chat_message(id) ON DELETE CASCADE,
    conversation_id  UUID        NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    helpful          BOOLEAN     NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_result_feedback_conversation_idx
    ON chat_result_feedback (conversation_id);
