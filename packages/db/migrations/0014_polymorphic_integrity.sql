-- 0014 — polimorfik target_id icin silme yonu butunlugu
--
-- `embedding` ve `generated_content` tablolarinda `target_id` POLIMORFIKTIR:
-- `target_type`'a gore offer, product ya da query gosterir. Bir kolon iki
-- tabloya birden isaret edemeyecegi icin foreign key konulamaz — yani
-- Postgres'in referans butunlugu bu iki tabloda YOKTUR.
--
-- Bulunan ariza (B3): tohum betigi `offer` ve `product` tablolarini
-- `TRUNCATE ... RESTART IDENTITY CASCADE` ile bosaltiyordu. CASCADE foreign
-- key'leri izler, bu iki tabloya FK olmadigi icin degmedi. `RESTART IDENTITY`
-- kimlikleri bastan dagitinca eski vektorler sessizce BASKA urunlere yapisti.
-- Eksik veri degil, YANLIS veri.
--
-- Bu dosya SILME yonunu motora baglar. Yazma yonu (var olmayan bir target_id
-- ile INSERT) trigger ile degil izleme ile kapatilir: `pnpm db:orphans`,
-- `docs/ops.md` izleme tablosu. Gerekce: docs/decisions/0020.
--
-- Sema degismiyor: kolon ya da tablo yok, yalnizca iki fonksiyon ve dort
-- trigger.

-- ---------------------------------------------------------------------------
-- Neden SECURITY DEFINER
-- ---------------------------------------------------------------------------
-- Trigger fonksiyonu varsayilan olarak CAGIRAN rolun yetkisiyle kosar. Bu
-- olculdu: `arilla_app` hedef tabloda DELETE yetkisi yokken INVOKER trigger
-- "permission denied for table ..." ile dustu, DEFINER trigger temizligi
-- yapti — ustelik `arilla_app` fonksiyonu dogrudan CAGIRMA yetkisine sahip
-- degilken (has_function_privilege = false).
--
-- Bugun 0010'un `GRANT ... ON ALL TABLES`'i yuzunden `arilla_app`'in
-- `embedding` uzerinde DELETE'i zaten var; INVOKER de calisirdi. DEFINER
-- olmasinin karsiligi su: butunluk garantisi uygulama rolunun GRANT'lerine
-- BAGLI DEGIL. `embedding` ileride `price_point` gibi sikilastirilirsa
-- trigger sessizce bozulmaz.
--
-- Sertlestirme (SECURITY DEFINER'in standart geregi):
--   * search_path fonksiyon uzerinde sabitlenir — arama yolu ele gecirilemez.
--   * PUBLIC'ten EXECUTE geri alinir — kimse dogrudan cagiramaz.
--   * Govde sabit SQL; dinamik SQL (EXECUTE format) yok.

-- ---------------------------------------------------------------------------
-- DELETE yolu
-- ---------------------------------------------------------------------------
-- FOR EACH STATEMENT + gecis tablosu (PG 10+): 400 offer'lik bir silmede
-- satir duzeyi trigger 400 kez kosardi, bu tek DELETE ile biter.
--
-- Iki trigger da gecis tablosuna ayni adi (`deleted`) verdigi icin tek
-- fonksiyon ikisine de yeter; hedef tur TG_ARGV[0] ile gelir.
CREATE FUNCTION enforce_polymorphic_delete() RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    DELETE FROM embedding e
        USING deleted d
        WHERE e.target_type = TG_ARGV[0] AND e.target_id = d.id;

    DELETE FROM generated_content g
        USING deleted d
        WHERE g.target_type = TG_ARGV[0] AND g.target_id = d.id;

    RETURN NULL;   -- AFTER trigger'in donus degeri yok sayilir
END
$$;

REVOKE ALL ON FUNCTION enforce_polymorphic_delete() FROM PUBLIC;

CREATE TRIGGER offer_polymorphic_delete
    AFTER DELETE ON offer
    REFERENCING OLD TABLE AS deleted
    FOR EACH STATEMENT EXECUTE FUNCTION enforce_polymorphic_delete('offer');

CREATE TRIGGER product_polymorphic_delete
    AFTER DELETE ON product
    REFERENCING OLD TABLE AS deleted
    FOR EACH STATEMENT EXECUTE FUNCTION enforce_polymorphic_delete('product');

-- ---------------------------------------------------------------------------
-- TRUNCATE yolu — B3'te asil yanan yol
-- ---------------------------------------------------------------------------
-- TRUNCATE trigger'inin gecis tablosu yoktur ve GEREKMEZ: `offer` bosaldiysa
-- `target_type = 'offer'` olan her satir tanimi geregi yetimdir.
--
-- Olculdu: CASCADE ile DOLAYLI truncate edilen tablonun trigger'i da atesler
-- (`TRUNCATE product ... CASCADE` -> `offer` bosalir -> offer trigger'i kosar).
-- Ayni ifadede `embedding` de truncate edilirse cakisma olmaz; AFTER TRUNCATE
-- butun truncate'lerden SONRA kosar ve DELETE sifir satira deger.
CREATE FUNCTION enforce_polymorphic_truncate() RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    DELETE FROM embedding         WHERE target_type = TG_ARGV[0];
    DELETE FROM generated_content WHERE target_type = TG_ARGV[0];
    RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION enforce_polymorphic_truncate() FROM PUBLIC;

CREATE TRIGGER offer_polymorphic_truncate
    AFTER TRUNCATE ON offer
    FOR EACH STATEMENT EXECUTE FUNCTION enforce_polymorphic_truncate('offer');

CREATE TRIGGER product_polymorphic_truncate
    AFTER TRUNCATE ON product
    FOR EACH STATEMENT EXECUTE FUNCTION enforce_polymorphic_truncate('product');

-- ---------------------------------------------------------------------------
-- Gecmisten kalan yetimler
-- ---------------------------------------------------------------------------
-- Trigger yalnizca bundan SONRAKI silmeleri kapsar. Migration'dan once
-- olusmus yetimler elde kalirdi ve `pnpm db:orphans --check` ilk kosuda
-- kritik uyari uretirdi. Tasinacak dogru bir yer yok: satirin isaret ettigi
-- hedef artik mevcut degil.
DELETE FROM embedding
    WHERE (target_type = 'offer'   AND NOT EXISTS (SELECT 1 FROM offer   o WHERE o.id = target_id))
       OR (target_type = 'product' AND NOT EXISTS (SELECT 1 FROM product p WHERE p.id = target_id));

DELETE FROM generated_content
    WHERE (target_type = 'offer'   AND NOT EXISTS (SELECT 1 FROM offer   o WHERE o.id = target_id))
       OR (target_type = 'product' AND NOT EXISTS (SELECT 1 FROM product p WHERE p.id = target_id));
