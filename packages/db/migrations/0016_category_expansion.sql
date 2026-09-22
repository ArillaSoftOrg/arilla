-- 0016 — kategori kapsami genisletildi (docs/decisions/0023)
--
-- docs/schema.sql `category.slug`'i hep UNIQUE olarak tanimliyordu (satir 55)
-- ama bu kisit 0002_catalog.sql'de hic eklenmemisti — referans belge ile
-- gercek sema burada ayrisiyordu. Once o bosluk kapatiliyor, sonra 0023'te
-- kararlastirilan 8 yeni ana kategori idempotent olarak ekleniyor ve mevcut
-- `kozmetik` yeni `saglik-kozmetik` ust kategorisinin altina tasiniyor.

-- ---------------------------------------------------------------------------
-- Adim 0: eksik kisit
--
-- IF NOT EXISTS ADD CONSTRAINT'i desteklemiyor (PG16); DO bloguyla korunuyor.
-- Bu kontrol gerceklen gerekliydi: yerel gelistirme DB'sinde bu kisit
-- migration bookkeeping'i (schema_migration) disinda, elle eklenmis halde
-- bulundu (2026-09-16, pnpm db:migrate calistirilirken tespit edildi) —
-- referans belge (docs/schema.sql) ile gercek sema arasindaki ayrisma daha
-- once fark edilip elle duzeltilmis ama migration'a hic yazilmamis.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'category_slug_key' AND conrelid = 'category'::regclass
    ) THEN
        ALTER TABLE category ADD CONSTRAINT category_slug_key UNIQUE (slug);
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Adim 1: saglik-kozmetik ust kategorisi + kozmetik'i yeniden ebeveynleme
-- ---------------------------------------------------------------------------
INSERT INTO category (slug, name, path, is_discoverable)
VALUES ('saglik-kozmetik', 'Saglik / Kozmetik', 'saglik-kozmetik', TRUE)
ON CONFLICT (slug) DO NOTHING;

UPDATE category
SET parent_id = (SELECT id FROM category WHERE slug = 'saglik-kozmetik'),
    path = 'saglik-kozmetik/kozmetik'
WHERE slug = 'kozmetik'
  AND parent_id IS NULL;

UPDATE category
SET path = 'saglik-kozmetik/' || path
WHERE path LIKE 'kozmetik/%';

-- ---------------------------------------------------------------------------
-- Adim 2: kalan 7 yeni ana kategori, idempotent
-- ---------------------------------------------------------------------------
INSERT INTO category (slug, name, path, is_discoverable) VALUES
    ('elektronik',        'Elektronik',           'elektronik',        TRUE),
    ('ev-yasam',          'Ev / Yasam',           'ev-yasam',          TRUE),
    ('anne-bebek',        'Anne / Bebek',         'anne-bebek',        TRUE),
    ('kitap-muzik-hobi',  'Kitap / Muzik / Hobi', 'kitap-muzik-hobi',  TRUE),
    ('spor-outdoor',      'Spor / Outdoor',       'spor-outdoor',      TRUE),
    ('oto-bahce',         'Oto / Bahce',          'oto-bahce',         TRUE),
    -- is_discoverable = FALSE: kesfet feed / curated pool / sitemap kapsami
    -- disinda (docs/decisions/0023). Eslestirme/alternatif bulma mantigini
    -- etkilemez, o pipeline is_discoverable kontrolu yapmaz.
    ('petshop',           'Petshop',              'petshop',           FALSE),
    ('supermarket',       'Supermarket',          'supermarket',       FALSE)
ON CONFLICT (slug) DO NOTHING;
