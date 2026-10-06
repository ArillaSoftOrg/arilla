-- 0048 — Shopify merchant'larinin aktivasyonu ve urun tavani (docs/decisions/0063)
--
-- Kullanici karari (2026-10-06): hazirlik kontrolleri tamamlanmis Shopify
-- merchant'lari uretim toplamasi icin aktiflestirilir. 0021 yalnizca para
-- birimi kanitini yazmisti ve `is_active`'e dokunmamisti; aktivasyon bu
-- migration'in isidir. Kapi (collect/gate.py) degismez: aktif + dogrulanmis
-- TRY hala sarttir, robots.txt calisma aninda hala sorulur (0042).
--
-- Kapsam: 0021'in dogruladigi 18 merchant. `turkish-finds` KAPSAM DISIDIR:
-- kanitta para birimi PHP (0021), `currency_verified = false`; gate zaten
-- reddeder ve bu migration ona dokunmaz.
--
-- Her merchant icin:
--   - `is_active = TRUE` (zaten aktif olan `arifoglu-online` degismez, 0027
--     araciligiyla yonetim konsolundan 2026-09-28'de aktiflestirildi);
--   - `feed_config.transport.shopify.max_products = 3500` (varsayilan 30;
--     connector tavani 1..3500). Magaza basina TUM katalog toplansin diye
--     kod tavani; magaza daha kucukse sayfalama kendiliginden biter;
--   - `feed_config.transport.retry.max_retries = 2` (yalnizca gecici hatalar:
--     429/5xx/baglanti; 0027 ile ayni ussel geri cekilme), yoksa.
-- Diger `feed_config` anahtarlari (mapping, para birimi kaniti, hiz siniri,
-- sayfa boyu) `jsonb_set` ile aynen kalir.
--
-- Aktivasyon `admin_audit_event`'e (actor NULL, rol `migration`) yazilir; ayni
-- eylem adi (`merchant.activate`) yonetim konsoluyla tutarlidir.
--
-- Beklenmeyen durumda RAISE EXCEPTION ile durur; migrate.ts dosyayi kendi
-- isleminde calistirdigi icin hicbir satir degismez.

CREATE TEMP TABLE shopify_activation (
    slug   TEXT PRIMARY KEY,
    domain TEXT NOT NULL UNIQUE
) ON COMMIT DROP;

INSERT INTO shopify_activation (slug, domain) VALUES
    ('arifoglu-online',           'arifogluonline.myshopify.com'),
    ('assema',                    'assema4455.myshopify.com'),
    ('bahs',                      'bahsbartr-com.myshopify.com'),
    ('casadora-baby',             'casadora-baby.myshopify.com'),
    ('eubos-turkiye',             'eubos-turkiye.myshopify.com'),
    ('eveline-cosmetics-turkiye', 'eveline-tr-v2.myshopify.com'),
    ('for-fun',                   'murat-cihan-kurtoglu.myshopify.com'),
    ('halicizade-hali-kilim',     'halicizade-rug-store.myshopify.com'),
    ('happy-place-home-decor',    'happy-place-home-decor-2.myshopify.com'),
    ('jura-store',                '745bb0.myshopify.com'),
    ('noir-parfum',               'noirparfum.myshopify.com'),
    ('north-sails-turkiye',       'north-sails-turkey.myshopify.com'),
    ('riva-istanbul',             'riva-istanbul.myshopify.com'),
    ('spor-plus',                 '5i8abq-fn.myshopify.com'),
    ('termos-dunyasi',            'termos-dunyasi.myshopify.com'),
    ('uy-design',                 'uydesign.myshopify.com'),
    ('wraith-esports',            'wraithesports.myshopify.com'),
    ('yutas-yapi-urunleri',       'yutas-yapi-urunleri.myshopify.com');

-- Adim 1: on kosullar.
DO $$
DECLARE
    problems TEXT;
BEGIN
    IF (SELECT count(*) FROM shopify_activation) <> 18 THEN
        RAISE EXCEPTION '0048: aktivasyon listesi 18 merchant olmali';
    END IF;

    SELECT string_agg(
               format('%s (beklenen %s, bulunan %s/%s)', v.slug, v.domain,
                      coalesce(m.domain, 'yok'), coalesce(m.source_type, 'yok')),
               '; ' ORDER BY v.slug)
      INTO problems
      FROM shopify_activation v
      LEFT JOIN merchant m ON m.slug = v.slug
     WHERE m.id IS NULL OR m.domain <> v.domain OR m.source_type <> 'shopify';
    IF problems IS NOT NULL THEN
        RAISE EXCEPTION '0048: merchant satiri listeyle eslesmiyor: %', problems;
    END IF;

    -- Para birimi kaniti (0021) tam olmali: nesne, "TRY" ve JSON true.
    SELECT string_agg(m.slug, ', ' ORDER BY m.slug)
      INTO problems
      FROM merchant m JOIN shopify_activation v ON v.slug = m.slug
     WHERE jsonb_typeof(m.feed_config) IS DISTINCT FROM 'object'
        OR m.feed_config->'currency' IS DISTINCT FROM '"TRY"'::jsonb
        OR m.feed_config->'currency_verified' IS DISTINCT FROM 'true'::jsonb;
    IF problems IS NOT NULL THEN
        RAISE EXCEPTION '0048: para birimi dogrulanmamis merchant (aktivasyon durdu): %', problems;
    END IF;

    -- transport varsa nesne olmali (jsonb_set bozuk yapida sessizce bir sey yazmasin).
    SELECT string_agg(m.slug, ', ' ORDER BY m.slug)
      INTO problems
      FROM merchant m JOIN shopify_activation v ON v.slug = m.slug
     WHERE jsonb_typeof(m.feed_config->'transport') IS DISTINCT FROM 'object'
        OR (m.feed_config->'transport' ? 'shopify'
            AND jsonb_typeof(m.feed_config->'transport'->'shopify') IS DISTINCT FROM 'object');
    IF problems IS NOT NULL THEN
        RAISE EXCEPTION '0048: feed_config.transport beklenmedik yapida: %', problems;
    END IF;

    -- turkish-finds: PHP, kapsam disi; aktif ya da dogrulanmis olmamali.
    IF EXISTS (
        SELECT 1 FROM merchant
         WHERE slug = 'turkish-finds'
           AND (is_active
                OR feed_config->'currency_verified' = 'true'::jsonb
                OR feed_config->'currency' = '"TRY"'::jsonb)
    ) THEN
        RAISE EXCEPTION '0048: turkish-finds aktif ya da TRY/dogrulanmis gorunuyor';
    END IF;
END $$;

-- Adim 2: aktivasyon denetim izi (yalnizca durumu degisecekler), sonra guncelleme.
INSERT INTO admin_audit_event
    (actor_user_id, actor_role, action, target_type, target_id, before, after, reason)
SELECT NULL, 'migration', 'merchant.activate', 'merchant', m.id::text,
       jsonb_build_object('isActive', m.is_active, 'slug', m.slug),
       jsonb_build_object('isActive', TRUE),
       '0048: hazirlik tamamlanan Shopify merchant aktivasyonu (docs/decisions/0063)'
  FROM merchant m JOIN shopify_activation v ON v.slug = m.slug AND v.domain = m.domain
 WHERE NOT m.is_active;

UPDATE merchant m
   SET is_active   = TRUE,
       feed_config = jsonb_set(
           CASE
               WHEN m.feed_config->'transport'->'retry' IS NULL
               THEN jsonb_set(m.feed_config, '{transport,retry}', '{"max_retries": 2}'::jsonb)
               ELSE m.feed_config
           END,
           '{transport,shopify,max_products}', '3500'::jsonb, TRUE),
       updated_at  = now()
  FROM shopify_activation v
 WHERE m.slug = v.slug
   AND m.domain = v.domain
   AND m.source_type = 'shopify';

-- Adim 3: son kontrol.
DO $$
BEGIN
    IF (SELECT count(*)
          FROM merchant m JOIN shopify_activation v ON v.slug = m.slug AND v.domain = m.domain
         WHERE m.is_active
           AND m.feed_config->'currency' = '"TRY"'::jsonb
           AND m.feed_config->'currency_verified' = 'true'::jsonb
           AND m.feed_config->'transport'->'shopify'->'max_products' = '3500'::jsonb) <> 18 THEN
        RAISE EXCEPTION '0048: son kontrol — 18 merchant aktif ve tavanli olmali';
    END IF;
    IF EXISTS (SELECT 1 FROM merchant WHERE slug = 'turkish-finds' AND is_active) THEN
        RAISE EXCEPTION '0048: son kontrol — turkish-finds aktif olmamali';
    END IF;
END $$;
