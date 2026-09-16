-- 0018 — brand-discovery / endpoint-verification zincirinden merchant kaydi
-- (docs/decisions/0023, guncellendi: docs/decisions/0024)
--
-- Bu dosya bu oturumda yazildi ve hicbir ortama uygulanmadi; bu yuzden
-- yeni bir migration eklemek yerine YERINDE guncellendi (bkz. 0024).
--
-- Ilk yazildiginda `source_type='api'`, `feed_config.mapping` bos ve
-- `is_active=false` idi: collect/sources/rest_api.py + collect/normalize.py
-- Shopify'in `variants[].price` gibi liste-of-dict alanlarindan skaler deger
-- cekemiyordu, ayrica renk+beden ayni JSON girdisinde ic ice oldugu icin
-- (docs/decisions/0005'in varsaydigi "renk = ayri sayfa" modeli kiriliyordu).
--
-- `docs/decisions/0024` bunu `services/ingest/collect/sources/shopify.py`
-- (yeni, dordunucu transport) ile cozdu: renk bolme CONNECTOR seviyesinde
-- olur, normalize()/pipeline.py/writer.py hic degismedi. `source_type` artik
-- 'shopify' (0017 migration'i CHECK kisitini genisletti), gercek bir
-- `feed_config.mapping` asagida tanimli.
--
-- `is_active` HALA FALSE: para biriminin TRY oldugu hala dogrulanamadi
-- (Shopify'in duz /products.json ucu currency alani dondurmuyor). Bu, kod
-- degisikliginden BAGIMSIZ, ayri bir acik konu — ilk gercek ingest
-- calismasi (elle tetiklenip) fiyatlar/urun sayfalari gozden gecirildikten
-- sonra is_active elle TRUE yapilmali.
--
-- `transport.shopify.color_option = "option1"` TUM merchant'lara uygulandi:
-- tek-varyantli urunlerde (orn. kozmetik, gida) zararsizdir (tum varyantlar
-- zaten tek grupta toplanir, bolme olmaz), cok-renkli apparel/ev urunlerinde
-- (orn. North Sails) dogru sekilde renge gore ayirir.
--
-- Kaynak: docs/decisions/0023 — brand-discovery (web arama, aday tarama) +
-- endpoint-verification (tek istek, ikinci deneme yok) zinciri. 29 aday
-- taranmis, 22'si HTTP 200 + gecerli JSON dondurmus, 3'u veri kalitesi
-- sorunu nedeniyle (bos katalog, test/placeholder fiyat, EU/toptan sinyali)
-- elenmis; kalan 19 burada kayda geciyor.

INSERT INTO merchant (slug, name, domain, source_type, feed_url, feed_config, is_active) VALUES
    ('happy-place-home-decor', 'Happy Place Home & Decor', 'happy-place-home-decor-2.myshopify.com',
     'shopify', 'https://happy-place-home-decor-2.myshopify.com/products.json',
     '{"category_hint":"ev-yasam","transport":{"pagination":{"size":50},"rate_limit":{"requests_per_second":1.5},"shopify":{"color_option":"option1"}},"mapping":{"external_id":"external_id","url":"url","title":"title","brand":"vendor","category":"product_type","price":"price","list_price":"compare_at_price","image_url":"image_url","variants":{"path":"variants","size":"option2","availability":"available","external_id":"id","price":"price","sku":"sku"}},"currency_verified":false,"value_formats":{"decimal_separator":".","thousands_separator":","}}'::jsonb,
     FALSE),
    ('riva-istanbul', 'Riva İstanbul', 'riva-istanbul.myshopify.com',
     'shopify', 'https://riva-istanbul.myshopify.com/products.json',
     '{"category_hint":"ev-yasam","transport":{"pagination":{"size":50},"rate_limit":{"requests_per_second":1.5},"shopify":{"color_option":"option1"}},"mapping":{"external_id":"external_id","url":"url","title":"title","brand":"vendor","category":"product_type","price":"price","list_price":"compare_at_price","image_url":"image_url","variants":{"path":"variants","size":"option2","availability":"available","external_id":"id","price":"price","sku":"sku"}},"currency_verified":false,"value_formats":{"decimal_separator":".","thousands_separator":","}}'::jsonb,
     FALSE),
    ('turkish-finds', 'Turkish Finds', 'turkishbuys.myshopify.com',
     'shopify', 'https://turkishbuys.myshopify.com/products.json',
     '{"category_hint":"ev-yasam","transport":{"pagination":{"size":50},"rate_limit":{"requests_per_second":1.5},"shopify":{"color_option":"option1"}},"mapping":{"external_id":"external_id","url":"url","title":"title","brand":"vendor","category":"product_type","price":"price","list_price":"compare_at_price","image_url":"image_url","variants":{"path":"variants","size":"option2","availability":"available","external_id":"id","price":"price","sku":"sku"}},"currency_verified":false,"value_formats":{"decimal_separator":".","thousands_separator":","}}'::jsonb,
     FALSE),
    ('yutas-yapi-urunleri', 'Yütaş Yapı Ürünleri', 'yutas-yapi-urunleri.myshopify.com',
     'shopify', 'https://yutas-yapi-urunleri.myshopify.com/products.json',
     '{"category_hint":"ev-yasam","transport":{"pagination":{"size":50},"rate_limit":{"requests_per_second":1.5},"shopify":{"color_option":"option1"}},"mapping":{"external_id":"external_id","url":"url","title":"title","brand":"vendor","category":"product_type","price":"price","list_price":"compare_at_price","image_url":"image_url","variants":{"path":"variants","size":"option2","availability":"available","external_id":"id","price":"price","sku":"sku"}},"currency_verified":false,"value_formats":{"decimal_separator":".","thousands_separator":","}}'::jsonb,
     FALSE),
    ('halicizade-hali-kilim', 'Halıcızade Halı Kilim', 'halicizade-rug-store.myshopify.com',
     'shopify', 'https://halicizade-rug-store.myshopify.com/products.json',
     '{"category_hint":"ev-yasam","transport":{"pagination":{"size":50},"rate_limit":{"requests_per_second":1.5},"shopify":{"color_option":"option1"}},"mapping":{"external_id":"external_id","url":"url","title":"title","brand":"vendor","category":"product_type","price":"price","list_price":"compare_at_price","image_url":"image_url","variants":{"path":"variants","size":"option2","availability":"available","external_id":"id","price":"price","sku":"sku"}},"currency_verified":false,"value_formats":{"decimal_separator":".","thousands_separator":","}}'::jsonb,
     FALSE),
    ('termos-dunyasi', 'Termos Dünyası', 'termos-dunyasi.myshopify.com',
     'shopify', 'https://termos-dunyasi.myshopify.com/products.json',
     '{"category_hint":"ev-yasam","transport":{"pagination":{"size":50},"rate_limit":{"requests_per_second":1.5},"shopify":{"color_option":"option1"}},"mapping":{"external_id":"external_id","url":"url","title":"title","brand":"vendor","category":"product_type","price":"price","list_price":"compare_at_price","image_url":"image_url","variants":{"path":"variants","size":"option2","availability":"available","external_id":"id","price":"price","sku":"sku"}},"currency_verified":false,"value_formats":{"decimal_separator":".","thousands_separator":","}}'::jsonb,
     FALSE),
    ('north-sails-turkiye', 'North Sails Türkiye', 'north-sails-turkey.myshopify.com',
     'shopify', 'https://north-sails-turkey.myshopify.com/products.json',
     '{"category_hint":"spor-outdoor","transport":{"pagination":{"size":50},"rate_limit":{"requests_per_second":1.5},"shopify":{"color_option":"option1"}},"mapping":{"external_id":"external_id","url":"url","title":"title","brand":"vendor","category":"product_type","price":"price","list_price":"compare_at_price","image_url":"image_url","variants":{"path":"variants","size":"option2","availability":"available","external_id":"id","price":"price","sku":"sku"}},"currency_verified":false,"value_formats":{"decimal_separator":".","thousands_separator":","}}'::jsonb,
     FALSE),
    ('spor-plus', 'Spor Plus', '5i8abq-fn.myshopify.com',
     'shopify', 'https://5i8abq-fn.myshopify.com/products.json',
     '{"category_hint":"spor-outdoor","transport":{"pagination":{"size":50},"rate_limit":{"requests_per_second":1.5},"shopify":{"color_option":"option1"}},"mapping":{"external_id":"external_id","url":"url","title":"title","brand":"vendor","category":"product_type","price":"price","list_price":"compare_at_price","image_url":"image_url","variants":{"path":"variants","size":"option2","availability":"available","external_id":"id","price":"price","sku":"sku"}},"currency_verified":false,"value_formats":{"decimal_separator":".","thousands_separator":","}}'::jsonb,
     FALSE),
    ('for-fun', 'For Fun', 'murat-cihan-kurtoglu.myshopify.com',
     'shopify', 'https://murat-cihan-kurtoglu.myshopify.com/products.json',
     '{"category_hint":"spor-outdoor","transport":{"pagination":{"size":50},"rate_limit":{"requests_per_second":1.5},"shopify":{"color_option":"option1"}},"mapping":{"external_id":"external_id","url":"url","title":"title","brand":"vendor","category":"product_type","price":"price","list_price":"compare_at_price","image_url":"image_url","variants":{"path":"variants","size":"option2","availability":"available","external_id":"id","price":"price","sku":"sku"}},"currency_verified":false,"value_formats":{"decimal_separator":".","thousands_separator":","}}'::jsonb,
     FALSE),
    ('jura-store', 'Jura Store', '745bb0.myshopify.com',
     'shopify', 'https://745bb0.myshopify.com/products.json',
     '{"category_hint":"spor-outdoor","transport":{"pagination":{"size":50},"rate_limit":{"requests_per_second":1.5},"shopify":{"color_option":"option1"}},"mapping":{"external_id":"external_id","url":"url","title":"title","brand":"vendor","category":"product_type","price":"price","list_price":"compare_at_price","image_url":"image_url","variants":{"path":"variants","size":"option2","availability":"available","external_id":"id","price":"price","sku":"sku"}},"currency_verified":false,"value_formats":{"decimal_separator":".","thousands_separator":","}}'::jsonb,
     FALSE),
    ('casadora-baby', 'Casadora Baby', 'casadora-baby.myshopify.com',
     'shopify', 'https://casadora-baby.myshopify.com/products.json',
     '{"category_hint":"anne-bebek","transport":{"pagination":{"size":50},"rate_limit":{"requests_per_second":1.5},"shopify":{"color_option":"option1"}},"mapping":{"external_id":"external_id","url":"url","title":"title","brand":"vendor","category":"product_type","price":"price","list_price":"compare_at_price","image_url":"image_url","variants":{"path":"variants","size":"option2","availability":"available","external_id":"id","price":"price","sku":"sku"}},"currency_verified":false,"value_formats":{"decimal_separator":".","thousands_separator":","}}'::jsonb,
     FALSE),
    ('assema', 'ASSEMA', 'assema4455.myshopify.com',
     'shopify', 'https://assema4455.myshopify.com/products.json',
     '{"category_hint":"anne-bebek","transport":{"pagination":{"size":50},"rate_limit":{"requests_per_second":1.5},"shopify":{"color_option":"option1"}},"mapping":{"external_id":"external_id","url":"url","title":"title","brand":"vendor","category":"product_type","price":"price","list_price":"compare_at_price","image_url":"image_url","variants":{"path":"variants","size":"option2","availability":"available","external_id":"id","price":"price","sku":"sku"}},"currency_verified":false,"value_formats":{"decimal_separator":".","thousands_separator":","}}'::jsonb,
     FALSE),
    ('uy-design', 'UY Design', 'uydesign.myshopify.com',
     'shopify', 'https://uydesign.myshopify.com/products.json',
     '{"category_hint":"moda","transport":{"pagination":{"size":50},"rate_limit":{"requests_per_second":1.5},"shopify":{"color_option":"option1"}},"mapping":{"external_id":"external_id","url":"url","title":"title","brand":"vendor","category":"product_type","price":"price","list_price":"compare_at_price","image_url":"image_url","variants":{"path":"variants","size":"option2","availability":"available","external_id":"id","price":"price","sku":"sku"}},"currency_verified":false,"value_formats":{"decimal_separator":".","thousands_separator":","}}'::jsonb,
     FALSE),
    ('eubos-turkiye', 'Eubos Türkiye', 'eubos-turkiye.myshopify.com',
     'shopify', 'https://eubos-turkiye.myshopify.com/products.json',
     '{"category_hint":"saglik-kozmetik","transport":{"pagination":{"size":50},"rate_limit":{"requests_per_second":1.5},"shopify":{"color_option":"option1"}},"mapping":{"external_id":"external_id","url":"url","title":"title","brand":"vendor","category":"product_type","price":"price","list_price":"compare_at_price","image_url":"image_url","variants":{"path":"variants","size":"option2","availability":"available","external_id":"id","price":"price","sku":"sku"}},"currency_verified":false,"value_formats":{"decimal_separator":".","thousands_separator":","}}'::jsonb,
     FALSE),
    ('eveline-cosmetics-turkiye', 'Eveline Cosmetics Türkiye', 'eveline-tr-v2.myshopify.com',
     'shopify', 'https://eveline-tr-v2.myshopify.com/products.json',
     '{"category_hint":"saglik-kozmetik","transport":{"pagination":{"size":50},"rate_limit":{"requests_per_second":1.5},"shopify":{"color_option":"option1"}},"mapping":{"external_id":"external_id","url":"url","title":"title","brand":"vendor","category":"product_type","price":"price","list_price":"compare_at_price","image_url":"image_url","variants":{"path":"variants","size":"option2","availability":"available","external_id":"id","price":"price","sku":"sku"}},"currency_verified":false,"value_formats":{"decimal_separator":".","thousands_separator":","}}'::jsonb,
     FALSE),
    ('arifoglu-online', 'Arifoğlu Online', 'arifogluonline.myshopify.com',
     'shopify', 'https://arifogluonline.myshopify.com/products.json',
     '{"category_hint":"saglik-kozmetik","transport":{"pagination":{"size":50},"rate_limit":{"requests_per_second":1.5},"shopify":{"color_option":"option1"}},"mapping":{"external_id":"external_id","url":"url","title":"title","brand":"vendor","category":"product_type","price":"price","list_price":"compare_at_price","image_url":"image_url","variants":{"path":"variants","size":"option2","availability":"available","external_id":"id","price":"price","sku":"sku"}},"currency_verified":false,"value_formats":{"decimal_separator":".","thousands_separator":","}}'::jsonb,
     FALSE),
    ('bahs', 'bahs.', 'bahsbartr-com.myshopify.com',
     'shopify', 'https://bahsbartr-com.myshopify.com/products.json',
     '{"category_hint":"saglik-kozmetik","transport":{"pagination":{"size":50},"rate_limit":{"requests_per_second":1.5},"shopify":{"color_option":"option1"}},"mapping":{"external_id":"external_id","url":"url","title":"title","brand":"vendor","category":"product_type","price":"price","list_price":"compare_at_price","image_url":"image_url","variants":{"path":"variants","size":"option2","availability":"available","external_id":"id","price":"price","sku":"sku"}},"currency_verified":false,"value_formats":{"decimal_separator":".","thousands_separator":","}}'::jsonb,
     FALSE),
    ('noir-parfum', 'Noir Parfum', 'noirparfum.myshopify.com',
     'shopify', 'https://noirparfum.myshopify.com/products.json',
     '{"category_hint":"saglik-kozmetik","transport":{"pagination":{"size":50},"rate_limit":{"requests_per_second":1.5},"shopify":{"color_option":"option1"}},"mapping":{"external_id":"external_id","url":"url","title":"title","brand":"vendor","category":"product_type","price":"price","list_price":"compare_at_price","image_url":"image_url","variants":{"path":"variants","size":"option2","availability":"available","external_id":"id","price":"price","sku":"sku"}},"currency_verified":false,"value_formats":{"decimal_separator":".","thousands_separator":","}}'::jsonb,
     FALSE),
    ('wraith-esports', 'Wraith Esports', 'wraithesports.myshopify.com',
     'shopify', 'https://wraithesports.myshopify.com/products.json',
     '{"category_hint":"elektronik","transport":{"pagination":{"size":50},"rate_limit":{"requests_per_second":1.5},"shopify":{"color_option":"option1"}},"mapping":{"external_id":"external_id","url":"url","title":"title","brand":"vendor","category":"product_type","price":"price","list_price":"compare_at_price","image_url":"image_url","variants":{"path":"variants","size":"option2","availability":"available","external_id":"id","price":"price","sku":"sku"}},"currency_verified":false,"value_formats":{"decimal_separator":".","thousands_separator":","}}'::jsonb,
     FALSE)
ON CONFLICT (domain) DO NOTHING;
