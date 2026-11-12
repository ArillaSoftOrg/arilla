# 0189 — Anlamsal arama strateji seçici (canlıya bağlı değil)

Durum: **kabul (yalnız modül)**. Migration yok. Canlı arama ve arama API'si değişmedi.
İlgili: 0178, 0181, 0182, 0186.
Kanıt: yerel E3-d / E3-d.1 ölçümleri (50.200 gerçek BGE-M3 vektörü).
Numara notu: Bu karar ilk olarak 0188 diye hazırlandı. Açık PR #327 aynı numarayı kullandığı için
0189 oldu.

## Bağlam

`semantic-candidates.ts` bugün global KNN ile aday bulup filtreyi sonradan uyguluyor. E3-d.1'de
ölçüldü:

- Sorgu kategoriyle çeliştiğinde global HNSW + kategori filtresi Recall@10'u 0,22–0,66'ya
  düşürüyor ve eksik sonuç döndürüyor.
- Kategoriye özgü kısmi HNSW (`ef_search` 400) aynı durumda 0,97–0,997 veriyor.
- B-tree + kesin sıralama ~2 bin satıra kadar 10 ms'nin altında ve tam doğru.

## Karar

`packages/core/src/search/semantic/strategy.ts`: saf `selectSemanticStrategy(input)`. Veritabanı,
ağ, model ve saat okumaz; sonuç olarak strateji, indeks kimliği, `ef_search`, kategori kipi,
kategorisiz ürün politikası, gerekçeler ve "geri dönüş mü" bilgisi döner.

1. **Kategori kaynağı:**
   - Arayüzden **açıkça seçilen** kategori kesin filtredir (`hard`).
   - Sorgudan **tahmin edilen** kategori yumuşak sinyaldir (`soft`); kesin filtreye dönüşmez.
   - İleride doğrulanmış bir **açık metin kategorisi** (örneğin kullanıcının yazdığı ve sözlükle
     kesinleşen kategori) üçüncü bir kaynak olarak eklenebilir. Bu turda canlı kategori ayrıştırıcısı
     değişmedi.
2. **Kategorisiz ürünler:** Açık kategoride gösterilmez. Tahmin edilen kategoride ikincil aday
   kaynağıdır (yapılandırılabilir). Kategori yoksa normal aday.
3. **Strateji:**
   - Büyük kategori → kısmi HNSW.
   - ≤ `exactMaxRows` (varsayılan 2.000; kesin üretim eşiği değil) → B-tree + kesin.
   - Filtresiz ya da yalnız fiyat filtresi → global HNSW.
   - Binary + yeniden sıralama yalnız `allowBinary` ve kalite doğrulamasıyla.
4. **İndeks seçimi:**
   - Yalnız istenen model ve indeks sürümüne ait, `ready` indeksler aday olur. Uzaylar (Jina-v3 ve
     BGE-M3) karışmaz.
   - Kapsam değeri güvensiz indeks elenir.
   - Üst kategori indeksi alt kategori filtresine otomatik uygulanmaz (ölçülmedi).
5. **Güvenli geri dönüş (`legacy_postfilter`):**
   - Ne zaman:
     - Envanter bilinmiyorsa.
     - İstatistik yok, eski ya da geçersizse ve kısmi indeks de yoksa.
     - Büyük kategori için kısmi indeks yoksa. Global + filtre bilerek seçilmez.
   - **Bu geri dönüş yalnız bugünkü davranışı korur; kategori filtresinde doğruluk garantisi
     VERMEZ.** Bugünkü yol (global KNN + sonradan filtre), E3-d.1'de ölçülen eksik sonuç sorununu
     taşır. Kararın `degraded = true` alanı bunu belirtir.

## SQL güvenliği ve plan doğrulaması (zorunlu entegrasyon gereksinimleri)

Bu PR SQL üretmez. Seçiciyi SQL'e bağlayacak her PR için:

1. **`isSafeCategoryLiteral` (`[a-z0-9-/]`) tek savunma DEĞİLDİR.** Yalnız ek bir süzgeçtir.
2. **Kabul edilen iki yöntem:**
   - **(a) Parametreli sorgu + doğrulanmış özel plan:** Kategori bağlı parametre olarak gider. Sorgu
     `plan_cache_mode = force_custom_plan` altında çalışır ve özel planın kısmi indeksi seçtiği
     entegrasyon testiyle doğrulanır.
   - **(b) Sabit SQL şablonu:** Güvenilir envanterden **seçilen sabit SQL şablonu**. Şablon kodda
     ya da envanter tablosunda önceden tanımlıdır; çalışma anında kullanıcı girdisinden SQL metni
     kurulmaz.
3. **Kullanıcı girdisi SQL metnine girmez.** Kategori her zaman envanterdeki kapsam değeriyle
   eşleştirilir.
4. **EXPLAIN doğrulaması zorunlu:** Her strateji için seçilen indeksin gerçekten kullanıldığı
   (Seq Scan ya da yanlış indeks değil) entegrasyon testiyle doğrulanır.
   - Neden: E3-d.1'de iki durum ölçüldü. Kategori parametreyken **genel plan kısmi indeksi
     KULLANAMIYOR**. Kısmi indeks varken planlayıcı "global" sorguda da kısmi indeksi seçiyor.
5. **Filtre anlamı:** Kısmi indeksin `WHERE` koşulu, sorgunun filtre anlamıyla (tam eşleşme ya da
   önek) birebir aynı olmalı.

## Reddedilen

- **Global HNSW + iterative scan'i büyük kategori için kullanmak:** Ölçüldü; çelişen sorguda
  0,22–0,66 ve eksik sonuç.
- **Her kategoriye otomatik kısmi indeks:** Bakım ve WAL iki katına çıkar. Yalnız büyük üst
  kategoriler.
- **Bölümleme (partitioning):** Filtresiz sorgu tüm bölümleri tarar ve kategori değişince satır
  taşınır. Bugün gerekmiyor.
- **Kategori metnini SQL'e doğrudan birleştirmek:** Yalnız (a) ya da (b) kabul edilir.

## Sonraki (ayrı PR'lar, insan onayıyla)

1. **Kategori kaynağı:** `QueryFilters`'a kategorinin kaynağı (açık / tahmin; ileride doğrulanmış
   metin) eklenir. Bugün ayrım yok.
2. **İndeks envanteri:** Tablo ya da `embedding_index` genişletmesi (migration) ve kategori satır
   sayısı istatistiği (toplu iş).
3. **SQL katmanı:** Yöntem (a) ya da (b) ile, EXPLAIN plan doğrulama entegrasyon testiyle.
4. **Gölge ölçüm:** Seçilen strateji ile eksik sonuç oranı gölge olarak ölçülür. Ardından ayrı
   aktivasyon kararı verilir.
