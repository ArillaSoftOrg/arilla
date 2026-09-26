-- 0022 — varyant duzeyinde barkod (docs/decisions/0032)
--
-- Tek offer birden fazla ticari varyant tasiyabilir (Korendy: ayni urunun
-- 60 ml ve 100 ml'si tek offer'in iki `offer_variant` satiri). Her boyutun
-- barkodu farklidir; offer duzeyinde tek bir barkod bu durumda YANLISTIR
-- (0030'daki "tek gecerli barkod" kurali bir boyutun barkodunu tum offer'a
-- yaziyordu). Barkod, varyantin zaten sahibi oldugu satira yazilir — `sku`
-- 0017'de ayni gerekceyle buraya eklendi.
--
-- Yalnizca GS1 kontrol basamagi dogru deger yazilir (gecersiz kimlik hic
-- saklanmaz, eslestirmeye giremez). `gtin_source` kaynagi kaydeder:
-- 'feed' | 'products_js' | 'sku'.
--
-- Geriye uyumlu (CLAUDE.md kural 14): NULL'lanabilir kolonlar + kismi indeks.
-- Toplama upsert'i bu kolonlara dokunmaz; yeniden toplamada korunurlar.

ALTER TABLE offer_variant ADD COLUMN gtin TEXT;
ALTER TABLE offer_variant ADD COLUMN gtin_source TEXT;

CREATE INDEX offer_variant_gtin_idx ON offer_variant (gtin) WHERE gtin IS NOT NULL;
