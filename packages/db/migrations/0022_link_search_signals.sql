-- 0021 — link araması: kaynak ürün sinyalleri, kararlı hata kodu, önbellek anahtarı
-- (docs/decisions/0035)
--
-- Yapıştırılan ürün linki artık yalnızca bir `offer` yazmakla bitmiyor; worker
-- sayfadan okuduğu sinyalleri (başlık, marka, barkod, görsel...) ve kaynak
-- görselin embedding'ini isteğe bağlıyor, `/ara/link` bunlarla katalogda
-- benzer ürün arıyor.
--
-- Geriye uyumlu (CLAUDE.md kural 14): yalnızca NULL'lanabilir kolon ve indeks
-- eklenir. Eski worker bu kolonlara dokunmaz, eski web kodu onları okumaz.

ALTER TABLE link_resolution_request
    ADD COLUMN normalized_url     TEXT,
    ADD COLUMN source             JSONB,
    ADD COLUMN error_code         TEXT,
    ADD COLUMN image_embedding_id BIGINT REFERENCES embedding(id);

CREATE INDEX link_resolution_request_url_idx ON link_resolution_request (normalized_url, created_at DESC)
    WHERE normalized_url IS NOT NULL;
