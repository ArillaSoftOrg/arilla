-- kind: schema
-- 0108 — anlamsal arama golge olcumu (karar 0178).
--
-- `SEMANTIC_SEARCH_MODE=shadow` iken her uygun `/sohbet` aramasindan sonra arka planda bir satir:
-- anlamsal adaylar "acik olsaydi" kullanicinin gordugu ilk 10'u nasil degistirirdi. Kullaniciya
-- donen sonuc degismez. Yalnizca SAYISAL olculer: sorgu metni, ozeti, oturum/kullanici ve urun
-- kimligi YOKTUR (KVKK; analitik kurali). Saklama: 90 gun (ops.md).
--
-- Yalnizca yeni tablo; geri alma: DROP TABLE semantic_shadow_event (hicbir sey buna bagli degil).
CREATE TABLE IF NOT EXISTS semantic_shadow_event (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    outcome          TEXT        NOT NULL
                     CHECK (outcome IN ('measured', 'no_vector', 'ineligible', 'capped', 'error')),
    reason           TEXT        CHECK (reason IS NULL OR reason ~ '^[a-z][a-z0-9_]{1,39}$'),
    model_version    TEXT        NOT NULL CHECK (model_version ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
    text_count       INTEGER     NOT NULL CHECK (text_count >= 0),
    text_with_vector INTEGER     NOT NULL DEFAULT 0 CHECK (text_with_vector >= 0),
    candidate_count  INTEGER     NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
    best_similarity  REAL        CHECK (best_similarity IS NULL OR best_similarity BETWEEN -1 AND 1),
    gate_passed      INTEGER     NOT NULL DEFAULT 0 CHECK (gate_passed >= 0),
    semantic_only    INTEGER     NOT NULL DEFAULT 0 CHECK (semantic_only >= 0),
    top_n            SMALLINT    NOT NULL CHECK (top_n BETWEEN 1 AND 10),
    overlap_top_n    SMALLINT    NOT NULL DEFAULT 0 CHECK (overlap_top_n BETWEEN 0 AND 10),
    new_in_top_n     SMALLINT    NOT NULL DEFAULT 0 CHECK (new_in_top_n BETWEEN 0 AND 10),
    embed_ms         INTEGER     CHECK (embed_ms IS NULL OR embed_ms >= 0),
    knn_ms           INTEGER     CHECK (knn_ms IS NULL OR knn_ms >= 0),
    cache_hit        BOOLEAN
);

CREATE INDEX IF NOT EXISTS semantic_shadow_event_created_idx
    ON semantic_shadow_event (created_at);
