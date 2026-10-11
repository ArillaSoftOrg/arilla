# Fiyat dağıtım zinciri, açık veri ve varyant eşleştirmesi (2026-10-12)

## 1. Yeni hipotezler ve gerçek testler

| # | Hipotez | Mekanizma | Erişim | Gerçek test | Sonuç |
|---|---|---|---|---|---|
| H8 | **Open Prices** (Open Food Facts, ODbL açık lisans) | Topluluğun kanıtlı fiyat gözlemleri; mağaza = OSM konumu ya da `ONLINE` web sitesi | Açık API, anahtarsız | `GET /api/v1/locations?type=ONLINE` → **136** çevrimiçi mağaza; hiçbiri Trendyol veya Türkiye değil. `GET /api/v1/prices?product_code=195949771569` (iPhone GTIN) → `total: 0` | Lisans izinli ama **Trendyol verisi yok** (D, şimdilik). Katkıyla büyütmek kanıt fotoğrafı ister ve Trendyol fiyatının yeniden yayımı kullanım koşulları sorununu çözmez |
| H9 | Mevcut internet araması (karar 0102: Gemini grounding + URL Context) | Google'ın kendi okuyucusu sayfayı okur; fiyat kanıt metninde birebir geçerse "verified" (`web-search/parse.ts`) | Mevcut ücretli Gemini hattı | **Test edilmedi**: her çağrı ücretli; kullanıcı onayı olmadan çalıştırılmadı. Ölçülecek: Trendyol ürün sayfaları URL Context ile okunuyor mu, kaç fiyat "verified" | Google şartları gereği sonuç **saklanamaz**; fiyat tek sorgu için doğrulanır. Mevcut sistemde var, ek kod gerektirmez (**B/var olan**) |
| H10 | Satıcı mağaza sitemap'i ile kapsam planı | `sitemap_seller_store.xml` | Node, robots serbest | **200**, 0,93 MB, **5.264** satıcı mağazası (`magaza/<ad>-m-<id>`); SuperStep (106871) var, Akarsu (724838), Trendyol 1P (968), 105350 ve 1082671 **yok** | Sitemap, satıcıların küçük bir seçkisi (Trendyol "200.000'den fazla satıcı" diyor). Satıcı onboarding'i için aday listesi olarak kullanılabilir, tam liste değil |

Önceki fazlarda sonuçlanan kaynaklar tekrarlanmadı (Akakçe, Cimri, Epey, Sovrn, Common Crawl, IA,
Google Merchant, entegratörler, kazıma servisleri).

## 2. Fiyat dağıtım zinciri (bilinenler)

```
satıcı ── (Partner API / entegratör: salePrice, listPrice) ──▶ Trendyol
Trendyol ── kampanya, sepet indirimi, kupon, buybox ──▶ müşteri ekranı (discountedPrice, "Sepette …")
Trendyol ── ürün feed'i (Productsup, ~30 kanal; sözleşmeli) ──▶ Google/Meta/… (alıcı lisanslı değil)
Trendyol sayfaları ── kendi tarayıcıları (Akakçe: "kendi robotu") ──▶ karşılaştırma siteleri (yeniden lisans yok)
Trendyol sayfaları ── Googlebot ──▶ Google dizini ──▶ Gemini grounding (H9; saklama yok)
```

Üçüncü tarafların hiçbirinde Trendyol fiyatını **ManiCepte'ye aktarma hakkı** belgelenmiş değil. İzinli
olan iki halka var: satıcının kendi API verisi (satıcı onayıyla) ve Google'ın grounding hattı (saklamadan,
Google şartlarıyla).

## 3. Varyant farkındalıklı eşleştirme (kod)

Gözlemler: aynı model kodu farklı renkte farklı fiyatlı (Sony Siyah 23.949 / Mavi 16.999 TL); aynı
contentId'de beden başına barkod ve fiyat farklı (Samba ID0478: 36 → `4066765863348`, 38,5 →
`4066765863256`; 7.199 / 7.999 / 5.349 TL katmanları).

`price-enrichment.ts` güncel sırası:
1. **Barkod eşit → exact.** Barkod varyant başınadır.
2. **Varyant çelişkisi → low (reddet):** açık varyant değeri (`variant`: "38,5" ≠ "36"), kapasite
   (128GB ≠ 256GB) ya da renk (siyah ≠ mavi; Türkçe ve İngilizce sözlük) iki tarafta da var ve uyuşmuyor.
   **contentId aynı olsa bile** uygulanır.
3. contentId (aynı mağaza) → exact; productUrl → exact.
4. Ortak model kodu → high. 5. Başlık ≥%80 + kapasite birebir → medium.

`trendyol-seller-api.ts`: varyant öznitelikleri (`Beden`, `Numara`, `Renk`, `Hafıza`, `Kapasite`,
`Ebat`) teklife `variant` olarak taşınır. Testler: 43 (5 yeni; Sony renk, Samba beden, barkod önceliği,
tek taraflı renk). Gerçek satıcı verisiyle test **edilmedi**.

## 4. Araştırılmamış alternatifler (sonraki oturumlar)

- H9'u ölçmek: kullanıcı onayıyla `pnpm --filter @arilla/core web-search:smoke` benzeri, Trendyol'a
  odaklı 5 sorgu. Kaç Trendyol URL'si döndü, URL Context ile kaç fiyat "verified", referans setle
  (03 §2.2, 07 §4) uyuşuyor mu?
- Satıcı onboarding'i için aday seçimi: 5.264 mağaza sitemap'i × dizindeki marka/kategori sıklığı.
- Trendyol webhook belgeleri (satıcının kendi fiyat/stok olayları; push ile güncellik).
- Dizin tamamlanınca: marka normalizasyonu (slug → 20.089 marka sitemap'i), yinelenen başlık analizi,
  sorgu kalitesi ölçümü.
