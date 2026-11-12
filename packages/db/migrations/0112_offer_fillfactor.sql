-- kind: schema
-- 0112 — teklif sayfalarinda HOT guncelleme icin bos yer (karar 0185, B1)
--
-- Gunluk beslemede fiyati degisen teklifin yeni surumu ayni sayfaya sigarsa HOT olur (dizin
-- yazimi yok). Uretimde besleme teklifi ortalama 1.064 bayt (takip baglantisi 488 bayt;
-- 12 Kasim olcumu): %90 doluluk (~820 bayt bos) yeni surume YETMEZ. %80 (~1,6 KB bos) bir
-- surume yer birakir. Yerel olcum (100 bin teklif, uretim genisligi, dolu ilk sayfalar,
-- 4. gun): WAL -%36, HOT %52; yigin +%7 ama dizinler -%19, toplam boyut ~ayni.
-- Yalniz meta veri: tablo YENIDEN YAZILMAZ (VACUUM FULL yok), kisa kilit (SHARE UPDATE
-- EXCLUSIVE); var olan dolu sayfalar budama/vacuum ile acilan yeri kullanir. Ayni yol
-- `feed_source_offer` icin 0068'de (fillfactor 70).
--
-- GERI ALMA: ALTER TABLE offer RESET (fillfactor);

ALTER TABLE offer SET (fillfactor = 80);
