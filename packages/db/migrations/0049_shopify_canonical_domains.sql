-- 0049 — Shopify merchant'larinin kanonik alan adina tasinmasi (docs/decisions/0064)
--
-- `<magaza>.myshopify.com/robots.txt` ozel alan adina 301 verdigi icin toplama
-- `refused:robots_unavailable` ile duruyordu (0042: yonlendirme izlenmez).
-- Kapi degismez; merchant'in `domain` ve `feed_url`'u GERCEK kanonik host'a
-- tasinir. Kanit: services/ingest/bootstrap/canonical_domains_20261006.json
-- (`python -m collect.canonical_domain`, salt okunur): elle ve adim adim
-- dogrulanan robots yonlendirme zinciri, genel IP, `meta.json`
-- `myshopify_domain` = eski domain (Shopify kimligi), `currency = "TRY"`
-- (`verify_currency.check_merchant`) ve `verify_readiness` = READY.
--
-- Kapsam yalnizca TUM kontrolleri gecen 2 merchant. Gecmeyenler (baska bir
-- Shopify magazasina yonlendirenler, ulasilamayanlar, esleme incelemesi
-- gerekenler) DOKUNULMAZ.
--
-- Guvenlik: yalnizca henuz hic offer'i olmayan, aktif, TRY dogrulanmis
-- merchant'lar; mevcut domain/feed_url beklenen degerlerle birebir ayni
-- olmali. `feed_config` degismez. Denetim izi `admin_audit_event`'e yazilir.
-- Beklenmeyen durumda RAISE EXCEPTION; hicbir satir degismez.

CREATE TEMP TABLE shopify_canonical (
    slug       TEXT PRIMARY KEY,
    old_domain TEXT NOT NULL,
    new_domain TEXT NOT NULL UNIQUE
) ON COMMIT DROP;

INSERT INTO shopify_canonical (slug, old_domain, new_domain) VALUES
    ('halicizade-hali-kilim', 'halicizade-rug-store.myshopify.com', 'www.halicizade.com'),
    ('north-sails-turkiye',   'north-sails-turkey.myshopify.com',   'collection.northsails.com.tr');

DO $$
DECLARE
    problems TEXT;
BEGIN
    SELECT string_agg(
               format('%s (beklenen %s, bulunan %s/%s)', c.slug, c.old_domain,
                      coalesce(m.domain, 'yok'), coalesce(m.source_type, 'yok')),
               '; ' ORDER BY c.slug)
      INTO problems
      FROM shopify_canonical c
      LEFT JOIN merchant m ON m.slug = c.slug
     WHERE m.id IS NULL
        OR m.domain <> c.old_domain
        OR m.source_type <> 'shopify'
        OR m.feed_url <> 'https://' || c.old_domain || '/products.json';
    IF problems IS NOT NULL THEN
        RAISE EXCEPTION '0049: merchant satiri beklenenle eslesmiyor: %', problems;
    END IF;

    SELECT string_agg(m.slug, ', ' ORDER BY m.slug)
      INTO problems
      FROM merchant m JOIN shopify_canonical c ON c.slug = m.slug
     WHERE NOT m.is_active
        OR m.feed_config->'currency' IS DISTINCT FROM '"TRY"'::jsonb
        OR m.feed_config->'currency_verified' IS DISTINCT FROM 'true'::jsonb
        OR EXISTS (SELECT 1 FROM offer o WHERE o.merchant_id = m.id);
    IF problems IS NOT NULL THEN
        RAISE EXCEPTION '0049: aktif/TRY-dogrulanmis olmayan ya da offer''i olan merchant: %',
            problems;
    END IF;

    -- Yeni domain baska bir merchant'ta kullanilmamali (UNIQUE zaten korur; acik hata).
    SELECT string_agg(m.slug, ', ')
      INTO problems
      FROM merchant m JOIN shopify_canonical c ON c.new_domain = m.domain;
    IF problems IS NOT NULL THEN
        RAISE EXCEPTION '0049: yeni domain zaten baska merchant''ta: %', problems;
    END IF;
END $$;

INSERT INTO admin_audit_event
    (actor_user_id, actor_role, action, target_type, target_id, before, after, reason)
SELECT NULL, 'migration', 'merchant.domain_change', 'merchant', m.id::text,
       jsonb_build_object('slug', m.slug, 'domain', m.domain, 'feedUrl', m.feed_url),
       jsonb_build_object('domain', c.new_domain,
                          'feedUrl', 'https://' || c.new_domain || '/products.json'),
       '0049: kanonik alan adi (robots yonlendirmesi); kanit canonical_domains_20261006.json'
  FROM merchant m JOIN shopify_canonical c ON c.slug = m.slug;

UPDATE merchant m
   SET domain     = c.new_domain,
       feed_url   = 'https://' || c.new_domain || '/products.json',
       updated_at = now()
  FROM shopify_canonical c
 WHERE m.slug = c.slug
   AND m.domain = c.old_domain;

DO $$
BEGIN
    IF (SELECT count(*)
          FROM merchant m JOIN shopify_canonical c ON c.slug = m.slug AND c.new_domain = m.domain
         WHERE m.feed_url = 'https://' || c.new_domain || '/products.json') <> 2 THEN
        RAISE EXCEPTION '0049: son kontrol — 2 merchant tasinmis olmali';
    END IF;
END $$;
