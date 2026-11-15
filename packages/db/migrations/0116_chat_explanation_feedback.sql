-- kind: schema
-- 0116 — sohbet: değerlendirme metni için ayrı geri bildirim (docs/decisions/0202)
--
-- Sonuç bloğunun geri bildirimi (chat_result_feedback, mesaj başına tek oy) DEĞİŞTİRİLMEZ:
-- eski uygulama sürümü `ON CONFLICT (message_id)` kullanır, birincil anahtarı değiştirmek onu
-- 42P10 ile kırardı (dağıtım penceresinde ve geri dönüşte), yönetim sorguları da çift sayardı.
-- Bu yüzden ikinci oy AYRI, yalnızca eklenen bir tablodur: eski kod bu tabloyu bilmez, yeni kod
-- tablo yokken `isMissingTable` ile sessizce devre dışı kalır.
--
-- Bir arama mesajının "açıklama" (değerlendirme metni) oyu: mesaj başına tek satır.
-- reasons: izinli neden kodları (en çok 3). comment: isteğe bağlı serbest metin 1..500 karakter,
-- kişisel veri içerebilir, 90 gün sonra NULL'a çekilir (cleanup-auth), oy ve neden kalır.
-- model_version: değerlendirme modelsizken NULL (ileride model destekli değerlendirme için).
-- Sahiplik conversation.user_id üzerinden; user_id kolonu eklenmez (CASCADE zinciri yeter).
--
-- Yalnızca ekleme. Geri alma: önce kod geri alınır; tablo zararsız kalabilir.

CREATE TABLE IF NOT EXISTS chat_explanation_feedback (
    message_id       BIGINT      PRIMARY KEY REFERENCES chat_message(id) ON DELETE CASCADE,
    conversation_id  UUID        NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    helpful          BOOLEAN     NOT NULL,
    reasons          TEXT[]      NOT NULL DEFAULT '{}',
    comment          TEXT,
    model_version    TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chat_explanation_feedback_reasons_check CHECK (
        cardinality(reasons) <= 3
        AND reasons <@ ARRAY['inaccurate', 'unclear', 'irrelevant', 'other']::TEXT[]
    ),
    CONSTRAINT chat_explanation_feedback_comment_check CHECK (
        comment IS NULL OR char_length(btrim(comment)) BETWEEN 1 AND 500
    ),
    CONSTRAINT chat_explanation_feedback_positive_clean CHECK (
        helpful = FALSE OR (cardinality(reasons) = 0 AND comment IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS chat_explanation_feedback_conversation_idx
    ON chat_explanation_feedback (conversation_id);
CREATE INDEX IF NOT EXISTS chat_explanation_feedback_helpful_created_idx
    ON chat_explanation_feedback (helpful, created_at DESC);
