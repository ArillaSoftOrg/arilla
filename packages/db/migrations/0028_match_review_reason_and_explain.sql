-- 0028 — eslestirme incelemesi: red nedeni, skor aciklamasi, inceleyen FK
-- (docs/decisions/0041)
--
-- `review_reason`: insanin (ya da onayin kardes adaylari dusurmesinin) red
-- nedeni. Yalnizca `rejected` satirlarda anlamlidir; NULL = belirtilmedi.
--   not_same_product  farkli urun
--   different_color   farkli renk
--   different_size    farkli boyut/hacim/beden
--   bad_data          teklif ya da urun verisi bozuk
--   other             diger
--   superseded        ayni teklifin baska bir adayi onaylandi (makine yazar)
--
-- `explain`: resolver'in skoru nasil urettigi (yontem, metin benzerligi,
-- inceleme nedeni, otomatik kabul uygunlugu). Kisisel veri tasimaz. Eski
-- satirlarda NULL; bir sonraki `resolve` kosusunda dolar.
--
-- `reviewed_by` FK: kolon 0004'ten beri vardi ama hic yazilmiyordu ve
-- referans kisiti yoktu. Once NOT VALID eklenir (tabloyu uzun kilitlemez),
-- sonra dogrulanir. CASCADE yok: `admin_audit_event` ile ayni ilke (0039).
--
-- Geriye uyumlu: yalnizca NULL'lanabilir kolon + kisit eklenir.

ALTER TABLE match_candidate
    ADD COLUMN review_reason TEXT
        CONSTRAINT match_candidate_review_reason_check
        CHECK (review_reason IN ('not_same_product','different_color','different_size',
                                 'bad_data','other','superseded')),
    ADD COLUMN explain JSONB;

ALTER TABLE match_candidate
    ADD CONSTRAINT match_candidate_reviewed_by_fkey
    FOREIGN KEY (reviewed_by) REFERENCES app_user(id) NOT VALID;

ALTER TABLE match_candidate VALIDATE CONSTRAINT match_candidate_reviewed_by_fkey;
