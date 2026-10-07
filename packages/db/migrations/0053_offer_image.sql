-- 0053 — offer_image: coklu urun gorseli galerisi (docs/decisions/0073)
--
-- Bugun yalnizca TEK gorsel var: `offer.image_url` (kaynak) ve ondan turetilen
-- `product.primary_image_url`. Bu tablo bir offer'in kaynaktaki gorsellerini
-- (en fazla MAX_SOURCE_IMAGES=6, `services/ingest/collect/images.py`) ve
-- bunlardan kullaniciya gosterilecek olanlari (display_rank, en fazla 3) tutar.
--
-- Gorsel ILK olarak offer'dan gelir; ayni kanonik urun ileride baska bir
-- merchant'ta baska gorsellerle bulunabilir. Bu yuzden kaynak offer'a baglidir
-- (kaynak izi = offer_id) ve urun galerisi okuma sirasinda en uygun offer'in
-- gorsellerinden kurulur. `product`a `image_url_2` gibi sabit kolon EKLENMEZ.
--
-- Iki kavram ayridir:
--   source_position = magaza/feed'in verdigi sira (0-tabanli, ayiklamadan sonra)
--   display_rank    = ManiCepte'nin gosterecegi sira; NULL = saklanir, gosterilmez
--
-- Binary/base64 YOKTUR: yalnizca URL, ozet ve metadata. `r2_url` simdilik hep
-- NULL; ileride ayri bir medya aynalama isi doldurur (karar 0062). Ana ingest
-- gorsel indirmez.
--
-- Yasam dongusu: kaynaktan kalkan gorsel silinmez, status='removed' olur ve
-- gosterimden duser; geri gelirse yeniden 'active' olur. 'broken' ileride
-- kaynak URL'si olu cikan gorseller icindir.
--
-- Yalnizca ekleme; `offer`/`product` kolonlarina dokunulmaz (`primary_image_url`
-- ve `offer.image_url` geri donus yolu olarak kalir). Geri alinmasi DROP TABLE.

CREATE TABLE IF NOT EXISTS offer_image (
    id                  BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    offer_id            BIGINT      NOT NULL REFERENCES offer(id) ON DELETE CASCADE,
    -- Normalize edilmis kaynak URL'sinin MD5'i (16 bayt). Surum/onbellek
    -- parametresi farkli ayni gorsel ayni satiri verir; indeks kucuk kalir.
    url_hash            BYTEA       NOT NULL CHECK (octet_length(url_hash) = 16),
    -- Kaynagin verdigi URL (en son goruldugu hali; surum parametresi dahil).
    source_url          TEXT        NOT NULL CHECK (char_length(source_url) BETWEEN 1 AND 2048),
    -- Ayna kopyasi (https://media.manicepte.com/products/...). NULL = aynalanmadi.
    r2_url              TEXT        CHECK (r2_url IS NULL OR char_length(r2_url) BETWEEN 1 AND 2048),
    source_position     SMALLINT    NOT NULL CHECK (source_position >= 0),
    display_rank        SMALLINT    CHECK (display_rank IS NULL OR display_rank >= 0),
    -- TRUE: kaynak bu gorseli bu offer'in varyantlarina baglamis (Shopify
    -- `variant_ids`). FALSE: iliski kanitlanamadi; renk/varyant iddiasi yok.
    is_variant_specific BOOLEAN     NOT NULL DEFAULT FALSE,
    -- Indirilmis icerigin ozeti; indirme isi gelene kadar NULL.
    image_hash          TEXT,
    perceptual_hash     BIGINT,
    width               INTEGER     CHECK (width IS NULL OR width > 0),
    height              INTEGER     CHECK (height IS NULL OR height > 0),
    status              TEXT        NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'removed', 'broken')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT offer_image_url_uniq UNIQUE (offer_id, url_hash),
    -- Gosterim sirasi offer icinde benzersiz. NULL'lar ayri sayilir (saklanan
    -- ama gosterilmeyenler cakismaz). ERTELENMIS: kaynak sirasi degisince ayni
    -- ifadede iki satir yer degistirebilsin; kontrol COMMIT'te yapilir.
    CONSTRAINT offer_image_rank_uniq UNIQUE (offer_id, display_rank) DEFERRABLE INITIALLY DEFERRED,
    -- Kaldirilmis/bozuk gorsel gosterilmez.
    CONSTRAINT offer_image_rank_active CHECK (display_rank IS NULL OR status = 'active')
);

COMMENT ON TABLE offer_image IS
    'Offer kaynak gorselleri (<=6) ve gosterim sirasi (display_rank). Binary yok; r2_url ileride aynalama isi doldurur. Karar 0073.';
