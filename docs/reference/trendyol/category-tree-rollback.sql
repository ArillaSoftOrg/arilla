-- Geri alma: 0102 (karar 0153 §8). ELLE ve ONAYLA calistirilir; migration degildir.
--
-- Yalnizca bu migration'in OLUSTURDUGU (3862) kategoriyi ve butun Trendyol eslemesini
-- (3867) siler. Mevcut 158 dugume DOKUNMAZ. Bir urun, siniflandirma, kaynak eslemesi
-- ya da baska bir tablo olusturulan bir dugume baglanmissa yabanci anahtar HATA verir ve TUM islem
-- geri alinir (kismi silme olmaz): once o baglantilar kaldirilmalidir.
BEGIN;

CREATE TEMP TABLE _tree_created ON COMMIT DROP AS
SELECT category_id FROM external_category_map
 WHERE source = 'trendyol' AND decided_by = 'migration:0102' AND note = 'created';

DELETE FROM external_category_map
 WHERE source = 'trendyol' AND decided_by = 'migration:0102';

-- Tek ifade: ebeveyn ve cocuklar birlikte silinir (yabanci anahtar ifade sonunda denetlenir).
DELETE FROM category WHERE id IN (SELECT category_id FROM _tree_created);

COMMIT;
