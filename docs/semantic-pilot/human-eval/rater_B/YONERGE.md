# Degerlendirmeci B: etiketleme yonergesi (kisa)

Dosyalar: `labeling_pool.csv` (240 satir), `query_targets.csv` (38 sorgu), `catalog_for_absence_check.csv` (200 urun listesi).
Excel / LibreOffice / Google Sheets ile acin; **bos olmayan tek sey sizin dolduracaginiz sutunlar**. Kaydederken
**CSV UTF-8** biciminde kaydedin (Turkce Excel'de "CSV UTF-8 (virgulle ayrilmis)"; noktali virgullu CSV de kabul edilir).
Baska bir degerlendirmecinin dosyasini gormeyin, onunla konusmayin; yontem/siralama/skor bilgisi dosyada YOKTUR, aramayin.

## 1) `labeling_pool.csv`
Her satir bir (sorgu, urun) cifti. Yalniz su sutunlari doldurun:
- `relevance(0/1/2)`: **2** dogrudan ilgili (sorgunun aradigi sey) · **1** kismen ilgili (ayni cihaz/aile ama aranan tur degil, ya da bazi ozellikler uymuyor) · **0** ilgisiz.
- `result_type(...)`: urunun KENDI turu, sorgudan bagimsiz: `main` ana urun · `accessory` aksesuar (kilif, stand, kablo, ...) · `part` yedek parca (pil, filtre, ped, nozul, ...) · `other` bunlarin disi · `unclear` basliktan anlasilmiyor.
- `note`: istege bagli. **Emin degilseniz** yine de en yakin degeri secin ve notu `KARARSIZ:` ile baslatip nedenini yazin (ornek: `KARARSIZ: baslik hem kemer hem pantolon diyor`).
- `labeler` sutunu onceden `B` ile dolu; degistirmeyin. Baska hicbir sutunu degistirmeyin, satir silmeyin/eklemeyin/siralamayi bozmaktan cekinmeyin (siralama serbest, kimlikler esastir).

## 2) `query_targets.csv`
Her sorgu icin **bir kez** `query_target_type(...)`: sorgu ne ariyor? `main` · `accessory` · `part` · `unclear`.
Ornek: "kulaklik pedi" -> `part`; "bluetooth speaker" -> `main`; "mouse" -> `unclear`.
`yoga mat` / `yoga matı` sorgularinin havuzunda urun yoktur: `catalog_for_absence_check.csv`'yi tarayin; ilgili urun GERCEKTEN yoksa `note` alanina `KATALOGDA YOK` yazin,
varsa urun numarasini yazin (`VAR: 123`). Bu iki satirda `query_target_type`'i yine doldurun.

## 3) Kurallar
1. Yalniz baslik ve kategoriye bakin; anahtar sozcuk doldurulmus basliklarda ("belt ... jeans ... dresses") ASIL urunu secin.
2. Dil onemli degil: Turkce sorgu Ingilizce basligi eslestirebilir ve tersi.
3. Ilgililik ile urun turu AYRI karardir: "laptop battery" sorgusunda pil `relevance=2`, `result_type=part` olabilir.
4. Bos birakilan alan "degerlendirilmedi" demektir, 0 degildir. Mumkunse hepsini doldurun.
5. Uygunsuz/rahatsiz edici baslik gorurseniz etiketlemeden atlayin, `note`'a `uygunsuz icerik` yazin.
6. Bitince dosyalari `labeling_pool_B.csv` ve `query_targets_B.csv` adiyla geri gonderin.

Not: urun gorseli ve fiyat bilgisi yoktur (fiyat alani bu pilotta anlamsiz yer tutucudur); yalniz baslik ve kategori vardir.
