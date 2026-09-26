-- 0021 — Shopify para birimi dogrulamasi: 18 merchant TRY olarak isaretlenir
-- (docs/decisions/0031)
--
-- Kanit: services/ingest/bootstrap/currency_verification_20260926.json
-- (`python -m collect.verify_currency`, 2026-09-26T10:11:58Z; merchant basina
-- tek `GET /meta.json`, yeniden deneme yok, yonlendirme izlenmez). 19
-- merchant'tan 18'i taban para birimi olarak tam `"TRY"` dondurdu. Tek FAIL:
-- `turkish-finds` (turkishbuys.myshopify.com) `"PHP"` dondurdu — bu migration
-- ona DOKUNMAZ.
--
-- Yalnizca `feed_config`'e iki anahtar yazilir: `currency = "TRY"`,
-- `currency_verified = true`. Diger anahtarlar (transport, mapping,
-- value_formats, category_hint, ...) JSONB birlestirmesiyle (`||`) aynen kalir.
--
-- `is_active` DEGISMEZ. Toplama kapisi (collect/gate.py) hem aktif olmayi hem
-- dogrulanmis TRY'yi ister; bu migration yalnizca ikincisini saglar.
-- Aktivasyon ayri, onayli bir karar.
--
-- Liste kanittan (slug + dogrulanan alan adi) birebir alinmistir; "Shopify
-- olup turkish-finds olmayan her sey" gibi genis bir kosul KULLANILMAZ.
-- Kanit bir ALAN ADI icin gecerlidir: slug baska bir alan adina isaret
-- ediyorsa migration durur.
--
-- Beklenmeyen bir durumda (eksik merchant, farkli alan adi, TRY disi para
-- birimi, bicimsiz bayrak, kapiyi yeni acacak aktif merchant) RAISE EXCEPTION
-- ile durur; migrate.ts dosyayi kendi isleminde calistirdigi icin hicbir
-- satir degismez.

CREATE TEMP TABLE shopify_verified_try (
    slug   TEXT PRIMARY KEY,
    domain TEXT NOT NULL UNIQUE
) ON COMMIT DROP;

INSERT INTO shopify_verified_try (slug, domain) VALUES
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

-- ---------------------------------------------------------------------------
-- Adim 1: on kosullar. Herhangi biri tutmazsa hicbir sey yazilmaz.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    problems TEXT;
BEGIN
    IF (SELECT count(*) FROM shopify_verified_try) <> 18 THEN
        RAISE EXCEPTION '0021: kanit listesi 18 merchant olmali';
    END IF;

    -- Kanittaki her slug, AYNI alan adiyla, Shopify merchant'i olarak var mi?
    SELECT string_agg(
               format('%s (beklenen %s, bulunan %s/%s)', v.slug, v.domain,
                      coalesce(m.domain, 'yok'), coalesce(m.source_type, 'yok')),
               '; ' ORDER BY v.slug)
      INTO problems
      FROM shopify_verified_try v
      LEFT JOIN merchant m ON m.slug = v.slug
     WHERE m.id IS NULL OR m.domain <> v.domain OR m.source_type <> 'shopify';
    IF problems IS NOT NULL THEN
        RAISE EXCEPTION '0021: kanit ile merchant satiri eslesmiyor: %', problems;
    END IF;

    -- feed_config nesne olmali; para birimi yok/null ya da zaten "TRY";
    -- bayrak yok ya da JSON boolean. Baska her sey insan gozu ister.
    SELECT string_agg(format('%s (currency=%s, currency_verified=%s)', m.slug,
                             coalesce(m.feed_config->'currency', 'null'::jsonb),
                             coalesce(m.feed_config->'currency_verified', 'null'::jsonb)),
                      '; ' ORDER BY m.slug)
      INTO problems
      FROM merchant m JOIN shopify_verified_try v ON v.slug = m.slug
     WHERE jsonb_typeof(m.feed_config) IS DISTINCT FROM 'object'
        OR coalesce(m.feed_config->'currency', 'null'::jsonb) NOT IN ('null'::jsonb, '"TRY"'::jsonb)
        OR (m.feed_config ? 'currency_verified'
            AND jsonb_typeof(m.feed_config->'currency_verified') IS DISTINCT FROM 'boolean');
    IF problems IS NOT NULL THEN
        RAISE EXCEPTION '0021: beklenmeyen para birimi durumu: %', problems;
    END IF;

    -- Bu migration aktivasyon DEGILDIR. Aktif olup henuz dogrulanmamis bir
    -- merchant'i isaretlemek, kapiyi onun icin fiilen acar — durdur.
    SELECT string_agg(m.slug, ', ' ORDER BY m.slug)
      INTO problems
      FROM merchant m JOIN shopify_verified_try v ON v.slug = m.slug
     WHERE m.is_active
       AND NOT (m.feed_config->'currency' = '"TRY"'::jsonb
                AND m.feed_config->'currency_verified' = 'true'::jsonb);
    IF problems IS NOT NULL THEN
        RAISE EXCEPTION '0021: aktif ve dogrulanmamis merchant (isaretlemek toplamayi acar): %',
            problems;
    END IF;

    -- turkish-finds kanitta PHP. Baska bir yoldan TRY/dogrulanmis olarak
    -- isaretlenmisse kanitla celisir.
    IF EXISTS (
        SELECT 1 FROM merchant
         WHERE slug = 'turkish-finds'
           AND (feed_config->'currency_verified' = 'true'::jsonb
                OR feed_config->'currency' = '"TRY"'::jsonb)
    ) THEN
        RAISE EXCEPTION '0021: turkish-finds kanitta PHP, ama TRY/dogrulanmis gorunuyor';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Adim 2: yalnizca iki anahtar. `||` diger anahtarlari korur.
-- ---------------------------------------------------------------------------
UPDATE merchant m
   SET feed_config = m.feed_config || '{"currency": "TRY", "currency_verified": true}'::jsonb,
       updated_at  = now()
  FROM shopify_verified_try v
 WHERE m.slug = v.slug
   AND m.domain = v.domain
   AND m.source_type = 'shopify'
   AND (m.feed_config->'currency' IS DISTINCT FROM '"TRY"'::jsonb
        OR m.feed_config->'currency_verified' IS DISTINCT FROM 'true'::jsonb);

-- ---------------------------------------------------------------------------
-- Adim 3: son kontrol.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF (SELECT count(*)
          FROM merchant m JOIN shopify_verified_try v ON v.slug = m.slug AND v.domain = m.domain
         WHERE m.feed_config->'currency' = '"TRY"'::jsonb
           AND m.feed_config->'currency_verified' = 'true'::jsonb) <> 18 THEN
        RAISE EXCEPTION '0021: son kontrol — 18 merchant TRY/dogrulanmis olmali';
    END IF;
    IF EXISTS (
        SELECT 1 FROM merchant
         WHERE slug = 'turkish-finds' AND feed_config->'currency_verified' = 'true'::jsonb
    ) THEN
        RAISE EXCEPTION '0021: son kontrol — turkish-finds dogrulanmis olmamali';
    END IF;
END $$;
