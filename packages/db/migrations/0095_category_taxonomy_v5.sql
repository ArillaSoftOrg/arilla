-- kind: data
-- 0095 — kategori agaci genislemesi (karar 0142): spor ve seyahat cantalari
--
-- YALNIZCA EKLEME ve IDEMPOTENT (0089/0091/0094 ile ayni mantik): yol zaten varsa satir atlanir,
-- mevcut kategori kimligi ve slug'i DEGISMEZ; ebeveyni olmayan dugum atlanir ve NOTICE verilir.
-- Neden: "Luggage & Bags > Travel Bags" kovasi (duffel, spor salonu, plaj/hafta sonu cantasi)
-- valiz dalina yaziliyordu; valiz bavul demektir (karar 0142 §2).
-- Geri alma (hicbir urun bu yola baglanmadan once): docs/decisions/0142 'Migration ve geri alma'.

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
            ('moda/canta/spor-seyahat-cantasi', 'Spor ve Seyahat Çantaları', TRUE)
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
                RAISE NOTICE '0095: ebeveyni olmayan dugum atlandi: %', node.path;
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
        RAISE NOTICE '0095: % dugum atlandi', skipped;
    END IF;
END $$;
