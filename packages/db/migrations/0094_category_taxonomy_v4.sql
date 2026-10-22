-- kind: data
-- 0094 — kategori agaci genislemesi (karar 0141): tekne ve deniz, banyo ve vucut bakimi,
-- masa ve kart oyunlari
--
-- YALNIZCA EKLEME ve IDEMPOTENT (0089/0091 ile ayni mantik): yol zaten varsa satir atlanir, mevcut
-- kategori kimligi ve slug'i DEGISMEZ; ebeveyni olmayan dugum atlanir ve NOTICE verilir.
-- Neden: uretimden alinan 196 urunluk ornekte "Boats" kovasinin 5/5 urunu motosiklet dalina,
-- dus jeli parfume, oyun mati fare altligina dusuyordu: dal yoktu (karar 0141 §2).
-- Geri alma (hicbir urun bu yollara baglanmadan once): docs/decisions/0141 'Migration ve geri alma'.
-- Kurallar `services/ingest/classify/taxonomy.py` icindedir; ordaki her yol 0089/0091 ya da bu
-- dosyada olmalidir (birim testi hepsini okur).

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
            ('oto-bahce/tekne-deniz', 'Tekne ve Deniz Araçları', TRUE),
            ('saglik-kozmetik/kisisel-bakim/banyo-vucut', 'Banyo ve Vücut Bakımı', TRUE),
            ('kitap-muzik-hobi/masa-kart-oyunlari', 'Masa ve Kart Oyunları', TRUE)
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
                RAISE NOTICE '0094: ebeveyni olmayan dugum atlandi: %', node.path;
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
        RAISE NOTICE '0094: % dugum atlandi', skipped;
    END IF;
END $$;
