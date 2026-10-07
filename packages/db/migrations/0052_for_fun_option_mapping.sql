-- 0052 — for-fun: konumsal secenek eslemesi yerine ad tabanli esleme (docs/decisions/0067)
--
-- Kanit (guarded_client, 2026-10-07, `murat-cihan-kurtoglu.myshopify.com/products.json`,
-- 200 urun / 1.098 varyant): 198 urunde secenekler ["Beden", "Renk"], 2 urunde
-- ["Size", "Renk"]; yani Beden = option1, Renk = option2. Mevcut yapilandirma
-- konumsal: `color_option = option1` (renk bolmesi BEDENE gore yapilir, her beden
-- ayri offer olur) ve `mapping.variants.size = option2` (beden alani RENGI
-- okur). `verify_readiness`: NOT_READY (mevcut esleme ornekle celisiyor).
--
-- Duzeltme yalnizca UC anahtar (baska hicbir anahtara, baska merchant'a dokunulmaz):
--   transport.shopify.color_option_names  = global renk adlari
--   transport.shopify.size_option_names   = global beden adlari
--   mapping.variants.size                 = 'size'   (ad tabanli beden alani)
-- Listeler `services/ingest/bootstrap/shopify_merchants.json` `defaults` ile
-- AYNIDIR (global parser kurallari gevsetilmez; `color_option` geriye uyum icin
-- kalir, ad oncelikli). Domain, para birimi, robots, kimlik ve aktiflik degismez.
--
-- Idempotent: onceden uygulanmissa (uc anahtar zaten yeni degerde) hicbir sey
-- yapmaz. Beklenmeyen durumda RAISE EXCEPTION; migrate.ts dosyayi kendi
-- isleminde calistirdigi icin hicbir satir degismez.

DO $$
DECLARE
    m          merchant%ROWTYPE;
    colour     JSONB := '["Renk", "Color", "Colour", "Kumaş", "Renk Seçeneği"]'::jsonb;
    size       JSONB := '["Beden", "Size", "Boyut", "Numara", "Ölçü"]'::jsonb;
    cfg        JSONB;
    before_cfg JSONB;
    already    BOOLEAN;
BEGIN
    SELECT * INTO m FROM merchant WHERE slug = 'for-fun';
    IF NOT FOUND
       OR m.domain <> 'murat-cihan-kurtoglu.myshopify.com'
       OR m.source_type <> 'shopify'
       OR m.feed_url <> 'https://murat-cihan-kurtoglu.myshopify.com/products.json' THEN
        RAISE EXCEPTION '0052: for-fun satiri beklenenle eslesmiyor';
    END IF;
    IF NOT m.is_active
       OR m.feed_config->'currency' IS DISTINCT FROM '"TRY"'::jsonb
       OR m.feed_config->'currency_verified' IS DISTINCT FROM 'true'::jsonb THEN
        RAISE EXCEPTION '0052: for-fun aktif ve TRY dogrulanmis degil';
    END IF;
    IF EXISTS (SELECT 1 FROM offer WHERE merchant_id = m.id) THEN
        RAISE EXCEPTION '0052: for-fun icin zaten offer var; esleme degisikligi mevcut veriyle celisir';
    END IF;

    already := m.feed_config #> '{transport,shopify,color_option_names}' = colour
           AND m.feed_config #> '{transport,shopify,size_option_names}' = size
           AND m.feed_config #> '{mapping,variants,size}' = '"size"'::jsonb;
    IF already THEN
        RETURN;  -- onceden uygulanmis
    END IF;

    -- Yalnizca beklenen ESKI durumdan: konumsal renk bolmesi + option2 beden alani.
    IF m.feed_config #> '{transport,shopify,color_option}' IS DISTINCT FROM '"option1"'::jsonb
       OR m.feed_config #> '{mapping,variants,size}' IS DISTINCT FROM '"option2"'::jsonb
       OR m.feed_config #> '{transport,shopify,color_option_names}' IS NOT NULL
       OR m.feed_config #> '{transport,shopify,size_option_names}' IS NOT NULL THEN
        RAISE EXCEPTION '0052: for-fun feed_config beklenen eski durumda degil: %', m.feed_config;
    END IF;

    before_cfg := jsonb_build_object(
        'color_option_names', m.feed_config #> '{transport,shopify,color_option_names}',
        'size_option_names',  m.feed_config #> '{transport,shopify,size_option_names}',
        'variants_size',      m.feed_config #> '{mapping,variants,size}');

    cfg := jsonb_set(m.feed_config, '{transport,shopify,color_option_names}', colour, TRUE);
    cfg := jsonb_set(cfg, '{transport,shopify,size_option_names}', size, TRUE);
    cfg := jsonb_set(cfg, '{mapping,variants,size}', '"size"'::jsonb, TRUE);

    -- Yalnizca uc anahtar degisti: baska her sey birebir ayni olmali.
    IF (cfg #- '{transport,shopify,color_option_names}'
            #- '{transport,shopify,size_option_names}'
            #- '{mapping,variants,size}')
       IS DISTINCT FROM
       (m.feed_config #- '{transport,shopify,color_option_names}'
                      #- '{transport,shopify,size_option_names}'
                      #- '{mapping,variants,size}') THEN
        RAISE EXCEPTION '0052: beklenmeyen ek degisiklik';
    END IF;

    INSERT INTO admin_audit_event
        (actor_user_id, actor_role, action, target_type, target_id, before, after, reason)
    VALUES (NULL, 'migration', 'merchant.config_change', 'merchant', m.id::text,
            jsonb_build_object('slug', m.slug, 'feedConfig', before_cfg),
            jsonb_build_object('feedConfig', jsonb_build_object(
                'color_option_names', colour, 'size_option_names', size, 'variants_size', 'size')),
            '0052: konumsal secenek eslemesi -> ad tabanli (Beden=option1, Renk=option2; docs/decisions/0067)');

    UPDATE merchant SET feed_config = cfg, updated_at = now() WHERE id = m.id;
END $$;

-- Son kontrol: uc anahtar yeni degerde, baska bir merchant degismedi.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM merchant
         WHERE slug = 'for-fun'
           AND feed_config #> '{transport,shopify,color_option_names}' IS NOT NULL
           AND feed_config #> '{mapping,variants,size}' = '"size"'::jsonb
           AND feed_config->'currency_verified' = 'true'::jsonb
           AND is_active
    ) THEN
        RAISE EXCEPTION '0052: son kontrol — for-fun yeni eslemede degil';
    END IF;
END $$;
