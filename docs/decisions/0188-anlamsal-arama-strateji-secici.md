# 0188 — Anlamsal arama strateji seçici (canlıya bağlı değil)

Durum: **kabul (yalnız modül)**. Migration yok. Canlı arama değişmedi. İlgili: 0178, 0181, 0182,
0186. Kanıt: yerel E3-d / E3-d.1 ölçümleri (50.200 gerçek BGE-M3 vektörü).

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

1. **Açık kategori kesin filtredir.** Tahmin edilen kategori kesin filtreye dönüşmez (`soft`).
2. **Kategorisiz ürünler:** açık kategoride gösterilmez; tahmin edilen kategoride ikincil aday
   kaynağıdır (yapılandırılabilir).
3. **Strateji:**
   - Büyük kategori → kısmi HNSW.
   - ≤ `exactMaxRows` (varsayılan 2.000, kesin üretim eşiği değil) → B-tree + kesin.
   - Filtresiz ya da yalnız fiyat filtresi → global HNSW.
   - Binary + yeniden sıralama yalnız `allowBinary` ve kalite doğrulamasıyla.
4. **İndeks seçimi:** Yalnız istenen model ve indeks sürümüne ait, `ready` indeksler aday olur.
   Uzaylar (Jina-v3 ve BGE-M3) karışmaz. Üst kategori indeksi alt kategori filtresine otomatik
   uygulanmaz (ölçülmedi).
5. **Güvenli geri dönüş (`legacy_postfilter` = bugünkü yol):**
   - Envanter bilinmiyorsa.
   - İstatistik yok, eski ya da geçersizse ve kısmi indeks de yoksa.
   - Büyük kategori için kısmi indeks yoksa. Global + filtre bilerek seçilmez.
6. **SQL sözleşmesi (bu PR'da SQL üretilmez):**
   - Kısmi indeks seçilince `requiresCategoryLiteral = true`: kategori SQL'e **envanterdeki
     kapsam değerinden**, `isSafeCategoryLiteral` (`[a-z0-9-/]`) doğrulamasıyla sabit yazılır. Ya
     da sorgu `plan_cache_mode = force_custom_plan` ile çalışır.
   - Neden: Parametreli kategori ile genel plan kısmi indeksi kullanamaz (E3-d.1'de ölçüldü).
   - Kullanıcı girdisi SQL'e doğrudan girmez.
   - Kısmi indeksin `WHERE` koşulu, sorgunun filtre anlamıyla (tam eşleşme ya da önek) birebir aynı
     olmalı.

## Reddedilen

- **Global HNSW + iterative scan'i büyük kategori için kullanmak:** Ölçüldü; çelişen sorguda
  0,22–0,66 ve eksik sonuç.
- **Her kategoriye otomatik kısmi indeks:** Bakım ve WAL iki katına çıkar. Yalnız büyük üst
  kategoriler.
- **Bölümleme (partitioning):** Filtresiz sorgu tüm bölümleri tarar ve kategori değişince satır
  taşınır. Bugün gerekmiyor.

## Sonraki (ayrı PR'lar, insan onayıyla)

1. **Kategori kaynağı:** `QueryFilters`'a kategorinin kaynağı (açık mı, tahmin mi) eklenir. Bugün
   ayrım yok.
2. **İndeks envanteri:** Tablo ya da `embedding_index` genişletmesi (migration) ve kategori satır
   sayısı istatistiği (toplu iş).
3. **SQL katmanı:** Seçicinin kararını beyaz listeli SQL'e çeviren katman ve plan doğrulama
   entegrasyon testi (EXPLAIN'de beklenen indeks).
4. **Gölge ölçüm:** Seçilen strateji ile eksik sonuç oranı gölge olarak ölçülür. Ardından ayrı
   aktivasyon kararı verilir.
