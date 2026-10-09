-- 0058 — sohbet geri bildirimi: olumsuz oyda neden ve yorum (docs/decisions/0079)
--
-- 0055'teki chat_result_feedback tablosu genisletilir; yeni tablo acilmaz. Yalnizca
-- nullable / varsayilanli kolonlar eklenir: mevcut oylar (yalniz helpful) gecerli kalir,
-- eski kod yeni semada calismaya devam eder. Veri tasinmaz.
--
-- reasons: izinli neden kodlari (arayuz tek secim sunar; dizi cok secime hazir, en cok 3).
-- comment: istege bagli serbest metin, 1..500 karakter; kisisel veri icerebilir, bu yuzden
--          90 gun sonra NULL'a cekilir (cleanup-auth), oy ve neden istatistigi kalir.
-- model_version: oy anindaki yaklasik model surumu (api_usage'dan, FK yok); NULL olabilir.
-- Sahiplik conversation.user_id uzerinden; user_id kolonu eklenmez (CASCADE zinciri yeter).
--
-- Yalnizca ekleme. Geri alma: once kod geri alinir; kolonlar zararsiz kalabilir.

ALTER TABLE chat_result_feedback
    ADD COLUMN IF NOT EXISTS reasons       TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS comment       TEXT,
    ADD COLUMN IF NOT EXISTS model_version TEXT;

ALTER TABLE chat_result_feedback
    ADD CONSTRAINT chat_result_feedback_reasons_check CHECK (
        cardinality(reasons) <= 3
        AND reasons <@ ARRAY[
            'not_found', 'irrelevant', 'misunderstood', 'wrong_info',
            'wrong_price_or_product', 'slow', 'other'
        ]::TEXT[]
    ),
    ADD CONSTRAINT chat_result_feedback_comment_check CHECK (
        comment IS NULL OR char_length(btrim(comment)) BETWEEN 1 AND 500
    ),
    ADD CONSTRAINT chat_result_feedback_positive_clean CHECK (
        helpful = FALSE OR (cardinality(reasons) = 0 AND comment IS NULL)
    );

CREATE INDEX IF NOT EXISTS chat_result_feedback_created_idx
    ON chat_result_feedback (created_at DESC);
CREATE INDEX IF NOT EXISTS chat_result_feedback_helpful_created_idx
    ON chat_result_feedback (helpful, created_at DESC);
