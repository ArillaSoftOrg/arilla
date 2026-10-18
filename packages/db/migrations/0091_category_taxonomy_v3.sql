-- kind: data
-- 0091 — kategori agaci genislemesi (karar 0139): guc/batarya, elektrik tesisati, olcum,
-- alet yedek parca, endustriyel ekipman, bebek arabasi, mangal/barbekü
--
-- YALNIZCA EKLEME ve IDEMPOTENT (0089 ile ayni mantik): yol zaten varsa satir atlanir, mevcut
-- kategori kimligi ve slug'i DEGISMEZ; ebeveyni olmayan dugum atlanir ve NOTICE verilir.
-- `endustriyel` is_discoverable = FALSE (B2B/sanayi urunu kesfet akisina girmez; arama ve
-- siniflandirma etkilenmez).
-- Geri alma (hicbir urun bu yollara baglanmadan once): docs/decisions/0139 'Migration ve geri alma'.
-- Kurallar ve kaynak eslemeleri `services/ingest/classify/taxonomy.py` icindedir; ordaki her yol
-- 0089 ya da bu dosyada olmalidir (birim testi ikisini de okur).

DO $$
DECLARE
    node RECORD;
    parent BIGINT;
    candidate TEXT;
    skipped INTEGER := 0;
BEGIN
    FOR node IN
        SELECT t.path, t.name, t.discoverable
          FROM (VALUES
            ('elektronik/guc-batarya', 'Güç ve Batarya', TRUE),
            ('elektronik/guc-batarya/batarya', 'Piller ve Bataryalar', TRUE),
            ('elektronik/guc-batarya/sarj-cihazi', 'Batarya Şarj Cihazları', TRUE),
            ('elektronik/guc-batarya/adaptor-guc-kaynagi', 'Adaptörler ve Güç Kaynakları', TRUE),
            ('ev-yasam/yapi-market/elektrik-tesisati', 'Elektrik Tesisatı', TRUE),
            ('ev-yasam/yapi-market/olcum-aletleri', 'Ölçü ve Test Aletleri', TRUE),
            ('ev-yasam/yapi-market/alet-yedek-parca', 'El Aleti Yedek Parça ve Aksesuarları', TRUE),
            ('ev-yasam/yapi-market/endustriyel', 'Endüstriyel Ekipman', FALSE),
            ('anne-bebek/bebek-arabasi', 'Bebek Arabaları', TRUE),
            ('anne-bebek/bebek-arabasi/aksesuar', 'Bebek Arabası Aksesuarları', TRUE),
            ('oto-bahce/bahce/mangal-barbeku', 'Mangal ve Barbekü', TRUE)
          ) AS t(path, name, discoverable)
         ORDER BY array_length(string_to_array(t.path, '/'), 1), t.path
    LOOP
        IF EXISTS (SELECT 1 FROM category WHERE path = node.path) THEN
            CONTINUE;
        END IF;
        parent := NULL;
        IF position('/' IN node.path) > 0 THEN
            SELECT id INTO parent FROM category
             WHERE path = regexp_replace(node.path, '/[^/]+$', '')
             ORDER BY id LIMIT 1;
            IF parent IS NULL THEN
                skipped := skipped + 1;
                RAISE NOTICE '0091: ebeveyni olmayan dugum atlandi: %', node.path;
                CONTINUE;
            END IF;
        END IF;
        candidate := replace(node.path, '/', '-');
        IF EXISTS (SELECT 1 FROM category WHERE slug = candidate) THEN
            candidate := candidate || '-k';
        END IF;
        INSERT INTO category (slug, name, parent_id, path, is_discoverable)
        VALUES (candidate, node.name, parent, node.path, node.discoverable)
        ON CONFLICT (slug) DO NOTHING;
    END LOOP;
    IF skipped > 0 THEN
        RAISE NOTICE '0091: % dugum atlandi', skipped;
    END IF;
END $$;
