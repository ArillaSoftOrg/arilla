-- kind: data
-- 0078 — Hepsiburada aylik urun tavani kaldirilir (karar 0124, 16 Ekim 2026 kullanici karari)
--
-- 0075 politikayi aylik 5.000.000 urunle birakti; kullanici urun sayisini sinirlamamaya karar verdi.
-- Yalniz istek sinirlari (gunluk 20.000, aylik 60.000) gecerlidir. `products_counted` ve
-- `collection_usage_day.products` izleme icin yazilmaya devam eder; NULL tavan tetikleyicide
-- "uygulanmaz" demektir (0075). Kolon ve genel tavan yolu kalir. Tekrar calistirilabilir.
-- Numara: 0076/0077 acik bir dala (yurt disi urun aramasi) ayrildi.

UPDATE collection_source
   SET monthly_max_products = NULL,
       permission_note = 'Kullanici beyani (Ekim 2026), belge incelenmedi: kosu araligi ve aylik kosu siniri '
           || 'kaldirildi; gunluk 20.000 ve aylik 60.000 HTTP istegi, urun sayisi sinirsiz. Yalniz '
           || 'urun kimligi, ad, gorsel, URL; fiyat toplanmaz.'
 WHERE source = 'hepsiburada';
