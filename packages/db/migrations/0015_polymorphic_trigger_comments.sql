-- 0015 — 0014'un trigger fonksiyonlarina veritabani duzeyinde yetki notu
--
-- Not 0014 dosyasinda yorum olarak duruyor, ama bu notun okunmasi gereken
-- kisi `arilla_app`'in yetkilerini degistiren kisidir — ve o kisi eski bir
-- migration dosyasini acmaz. Yetki incelerken psql'de olur:
--
--     \df+ enforce_polymorphic*
--     SELECT obj_description('enforce_polymorphic_delete()'::regprocedure);
--
-- `COMMENT ON` notu veritabani nesnesine baglar, dosyaya degil; boylece not
-- semanin kendisiyle birlikte yolculuk eder ve tam o anda gorunur.
--
-- Ayri bir migration cunku 0014 uygulanmis durumda; uygulanmis bir
-- migration'in SQL'i degistirilmez.

COMMENT ON FUNCTION enforce_polymorphic_delete() IS
$doc$Polimorfik target_id butunlugu: offer/product satiri silindiginde bagli
embedding ve generated_content satirlarini temizler (bkz. 0014).

YETKI NOTU — SECURITY DEFINER: bu fonksiyon CAGIRANIN degil SAHIBININ
(arilla) yetkisiyle kosar, yani cagiranin yetkisini ATLAR. Bugun tasiyici
degil: 0010 arilla_app'e embedding uzerinde DELETE veriyor, INVOKER de
calisirdi. Tasiyici hale gelecegi an, arilla_app'in bu iki tablodaki
yetkilerinin daraltildigi gun.

O gun bu fonksiyon SESSIZCE calismaya devam eder, hata vermez. embedding ya
da generated_content price_point gibi append-only yapilirsa (REVOKE DELETE)
bu fonksiyon o kurali DELER ve bunu ilan etmez.

arilla_app yetkileri her degistirildiginde bakilacak kontrol listesi:
docs/decisions/0021-security-definer-yetki-istisnasi.md$doc$;

COMMENT ON FUNCTION enforce_polymorphic_truncate() IS
$doc$Polimorfik target_id butunlugu: offer/product tablosu TRUNCATE
edildiginde o turdeki embedding ve generated_content satirlarini temizler
(bkz. 0014). B3'te asil yanan yol budur.

YETKI NOTU — SECURITY DEFINER: yukaridaki fonksiyonla ayni. Cagiranin
yetkisini atlar, yetki daraltmasinda ses cikarmaz. Kontrol listesi:
docs/decisions/0021-security-definer-yetki-istisnasi.md$doc$;
