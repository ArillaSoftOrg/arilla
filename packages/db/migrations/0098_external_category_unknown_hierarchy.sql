-- kind: schema
-- 0098 — dis kaynak kategorilerinde bilinmeyen hiyerarsi ve supheli kayit (karar 0144)
--
-- BAGIMLILIK: 0096 (karar 0143, PR #205) once uygulanmis olmali. Bu migration yalnizca onun
-- tablolarini GEVSETIR ve genisletir; `category`, `product` ve siniflandiriciya dokunmaz.
--
-- Neden: Hepsiburada sitemap'i yalniz `slug-c-<id>` verir; ebeveyn, derinlik, yol ve yaprak
-- bilgisi yoktur. 0096 bunlari zorunlu kiliyordu; uydurmak "tahmini dogrulanmis gibi
-- kaydetme" olurdu. Simdi hiyerarsi `hierarchy_status` ile acikca 'verified' ya da 'unknown'
-- tutulur; Trendyol satirlari 'verified' kalir (DEFAULT) ve kisitlari aynen gecerlidir.
-- Geriye uyumlu: kolonlar yalnizca eklenir/NULL'lanabilir, mevcut satirlar degismez.
-- Geri alma: karar 0144 §6.

-- ---------------------------------------------------------------------------
-- Ice aktarim kaydi: kaynagin turu (api/sitemap); bilinmeyen sayilar NULL olabilir.
-- ---------------------------------------------------------------------------
ALTER TABLE external_category_import
    ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'api'
        CHECK (source_kind IN ('api', 'sitemap')),
    ADD COLUMN IF NOT EXISTS suspect_count INTEGER NOT NULL DEFAULT 0
        CHECK (suspect_count >= 0);
ALTER TABLE external_category_import ALTER COLUMN root_count DROP NOT NULL;
ALTER TABLE external_category_import ALTER COLUMN max_depth DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- Kategori: yeni kolonlar (eski satirlar DEFAULT ile 'verified' / 'valid' / 'source').
-- ---------------------------------------------------------------------------
ALTER TABLE external_category
    ADD COLUMN IF NOT EXISTS hierarchy_status TEXT NOT NULL DEFAULT 'verified'
        CHECK (hierarchy_status IN ('verified', 'unknown')),
    ADD COLUMN IF NOT EXISTS name_basis TEXT NOT NULL DEFAULT 'source'
        CHECK (name_basis IN ('source', 'slug')),
    ADD COLUMN IF NOT EXISTS quality TEXT NOT NULL DEFAULT 'valid'
        CHECK (quality IN ('valid', 'suspect')),
    ADD COLUMN IF NOT EXISTS quality_reason TEXT,
    ADD COLUMN IF NOT EXISTS slug TEXT,
    ADD COLUMN IF NOT EXISTS source_url TEXT,
    ADD COLUMN IF NOT EXISTS source_attrs JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE external_category ALTER COLUMN depth DROP NOT NULL;
ALTER TABLE external_category ALTER COLUMN is_leaf DROP NOT NULL;
ALTER TABLE external_category ALTER COLUMN path_ids DROP NOT NULL;
ALTER TABLE external_category ALTER COLUMN path_text DROP NOT NULL;

-- 0096'nin hiyerarsi ve kimlik kisitlari adsizdi: tanimina gore dusurulur, asagida adli ve
-- hierarchy_status'a bagli olarak yeniden kurulur (yeniden calistirmada adlilar da yenilenir).
DO $$
DECLARE
    c RECORD;
BEGIN
    FOR c IN
        SELECT conname
          FROM pg_constraint
         WHERE conrelid = 'external_category'::regclass
           AND contype = 'c'
           AND (conname IN ('external_category_hierarchy_chk', 'external_category_id_chk',
                            'external_category_quality_chk')
                OR pg_get_constraintdef(oid) LIKE '%depth%'
                OR pg_get_constraintdef(oid) LIKE '%external_id > 0%'
                OR pg_get_constraintdef(oid) LIKE '%external_id >= 0%')
    LOOP
        EXECUTE format('ALTER TABLE external_category DROP CONSTRAINT %I', c.conname);
    END LOOP;
END $$;

-- Dogrulanmis hiyerarsi: 0096 ile ayni kurallar. Bilinmeyen hiyerarsi: ebeveyn/derinlik/yol/yaprak
-- HEPSI bos olmali (kismi ya da tahmini bilgi yazilamaz).
ALTER TABLE external_category ADD CONSTRAINT external_category_hierarchy_chk CHECK (
    (hierarchy_status = 'verified'
        AND depth IS NOT NULL AND is_leaf IS NOT NULL AND path_ids IS NOT NULL AND path_text IS NOT NULL
        AND depth > 0 AND cardinality(path_ids) = depth
        AND (depth = 1) = (parent_external_id IS NULL))
    OR
    (hierarchy_status = 'unknown'
        AND depth IS NULL AND is_leaf IS NULL AND path_ids IS NULL AND path_text IS NULL
        AND parent_external_id IS NULL)
);
-- Kimlik 0 yalnizca supheli kayit olabilir (Hepsiburada sitemap'inde `hepsiburada-com`).
ALTER TABLE external_category ADD CONSTRAINT external_category_id_chk CHECK (
    external_id > 0 OR (external_id = 0 AND quality = 'suspect')
);
ALTER TABLE external_category ADD CONSTRAINT external_category_quality_chk CHECK (
    quality = 'valid' OR quality_reason IS NOT NULL
);

-- ---------------------------------------------------------------------------
-- Supheli kategori eslestirilemez (otomatik ya da elle 'suggested'/'confirmed'); yalnizca
-- 'rejected' yazilabilir. Siniflandirici bu tablolari zaten okumaz.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION external_category_map_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status <> 'rejected' AND EXISTS (
        SELECT 1 FROM external_category e
         WHERE e.source = NEW.source AND e.external_id = NEW.external_id AND e.quality <> 'valid'
    ) THEN
        RAISE EXCEPTION 'external_category_map: supheli kategori eslestirilemez (%/%)',
            NEW.source, NEW.external_id USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE TRIGGER external_category_map_guard
    BEFORE INSERT OR UPDATE ON external_category_map
    FOR EACH ROW EXECUTE FUNCTION external_category_map_guard();

-- ---------------------------------------------------------------------------
-- Kullanim gorunumu: mevcut kolonlar ayni sirada; yeni kolonlar sona eklenir. 'suspect' yeni deger.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW external_category_usage AS
SELECT ec.source,
       ec.external_id,
       ec.depth,
       ec.is_leaf,
       ec.path_text,
       ec.retired_at,
       m.category_id,
       m.status AS map_status,
       CASE
           WHEN ec.quality <> 'valid' THEN 'suspect'
           WHEN m.external_id IS NULL THEN 'unmapped'
           WHEN m.status = 'rejected' THEN 'rejected'
           WHEN EXISTS (SELECT 1 FROM product p WHERE p.category_id = m.category_id) THEN 'in_use'
           ELSE 'mapped_empty'
       END AS usage,
       ec.quality,
       ec.hierarchy_status,
       ec.name,
       ec.slug
  FROM external_category ec
  LEFT JOIN external_category_map m
    ON m.source = ec.source AND m.external_id = ec.external_id;
