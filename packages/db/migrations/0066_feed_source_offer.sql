-- kind: schema
-- 0066 — besleme x offer uyeligi (karar 0112)
--
-- Ayni kaynak urun birden fazla beslemede bulunabilir (AliExpress: "hot
-- products" ve fiyat bandi beslemeleri ayni urunu tasir). Deaktivasyon
-- `offer.last_snapshot_id` ile yapilsaydi bir besleme digerinin urunlerini
-- pasiflestirirdi. Uyelik besleme basina tutulur; offer ancak HICBIR etkin
-- beslemede kalmadiginda pasiflesir.
--
-- YALNIZCA EKLEME. Yeni tablo; mevcut hicbir sey degismez.

CREATE TABLE feed_source_offer (
    feed_source_id    BIGINT      NOT NULL REFERENCES feed_source(id),
    offer_id          BIGINT      NOT NULL REFERENCES offer(id) ON DELETE CASCADE,
    -- Bu beslemenin offer'i en son gordugu surum.
    last_snapshot_id  BIGINT      NOT NULL REFERENCES source_snapshot(id),
    first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (feed_source_id, offer_id)
);
CREATE INDEX feed_source_offer_offer_idx ON feed_source_offer (offer_id);

-- Affiliate takip baglantisi KANONIK urun adresinden AYRI tutulur (karar 0112):
-- `offer.url` urunun kendi adresi (kimlik, gosterim, eslestirme); `affiliate_url`
-- kaynagin verdigi takip baglantisi (or. Admitad). Cikis her zaman click kaydiyla
-- (kural 8); takip baglantisi kanonik adresin yerine gecmez.
ALTER TABLE offer ADD COLUMN affiliate_url TEXT
    CHECK (affiliate_url IS NULL OR (char_length(affiliate_url) <= 2048 AND affiliate_url ~ '^https://'));
