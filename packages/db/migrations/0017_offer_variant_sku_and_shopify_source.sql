-- 0017 — offer_variant.sku + merchant.source_type'a 'shopify' eklendi
-- (docs/decisions/0024)
--
-- Bu, merchant kaydindan (0018_merchant_shopify_discovery.sql) ONCE
-- calismali: o dosya source_type='shopify' ile satir ekliyor, CHECK kisiti
-- genisletilmeden o deger reddedilir. Sira bilerek boyle (0017 < 0018).
--
-- Shopify /products.json her varyant icin kendi SKU'sunu tasiyor
-- (variants[].sku) ama offer_variant bunu saklayacak bir kolona sahip
-- degildi. Ayrica yeni, Shopify'a ozel bir connector eklendigi icin
-- (services/ingest/collect/sources/shopify.py) merchant.source_type CHECK
-- kisitina 'shopify' degeri eklenmesi gerekiyor. Ikisi de eklemeli/genisletici
-- — geriye donuk uyumluluk kuralini bozmaz.

ALTER TABLE offer_variant ADD COLUMN sku TEXT;

-- Not: kisit adi Postgres'in inline CHECK icin varsayilan adlandirmasi
-- (<tablo>_<kolon>_check). Gercek ortamda `\d merchant` ile teyit edilmeli;
-- farkliysa bu migration adi guncellenerek yeniden calistirilmadan once
-- duzeltilmeli (henuz hicbir ortama uygulanmadi).
ALTER TABLE merchant DROP CONSTRAINT merchant_source_type_check;
ALTER TABLE merchant ADD CONSTRAINT merchant_source_type_check
    CHECK (source_type IN ('xml_feed','api','affiliate_network','user_discovered','shopify'));
