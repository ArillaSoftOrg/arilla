-- 0011 — click tablosuna sonuc sirasi ve kaynak benzerlik turu eklenir
--
-- Nullable, geriye uyumlu ek: docs/events.md'deki alternative_clicked
-- olayinin list_position/matched_kind alanlariyla ayni bilgiyi kalici
-- attribution kaydinda (click) tutar. Gerekce: docs/decisions/0013.

ALTER TABLE click
    ADD COLUMN source_similarity_kind TEXT
        CHECK (source_similarity_kind IN ('same','visual','semantic','substitute')),
    ADD COLUMN result_position SMALLINT;
