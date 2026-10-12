# Tam ürün sitemap dizini raporu (2026-10-12)

337/337 `sitemap_products*.xml` indirildi. 6 sn aralık, dürüst UA; **hiç 403/429 alınmadı**.
Rapor betiği: `scripts/trendyol-index-report.ts` (ağ isteği atmaz, yerel önbelleği okur).

## 1. Sayılar

| Ölçü | Değer |
|---|---|
| Ürün URL'si | **8.126.053** |
| Benzersiz contentId | **8.126.053** (dosyalar arası yineleme yok) |
| Görselsiz ürün | %0 |
| Adreslerdeki marka slug'ı | 181.130 (gerçek marka sayısı **değil**) |
| Trendyol marka sitemap'i | 20.089 marka |
| Marka sitemap'iyle eşleşen slug | 20.040 → **3.924.708 ürün (%48,3)** |
| Birebir aynı marka + başlık slug'ı | 577.826 grup, **1.872.830 ürün** |

**Marka normalizasyonu:** Güvenilir marka anahtarı, marka sitemap'indeki `-x-b<id>` kimliğidir
(slug → brandId). Ürünlerin %48,3'ü bu 20 bin markaya bağlanabiliyor. Kalan %51,7 satıcı etiketleri,
`genel-markalar` ve uzun kuyruk; bunlar marka olarak normalize edilemez, yalnızca slug olarak tutulur.

## 2. Ürün kimliği ve varyant ilişkisi (gerçek gözlem)

- iPhone 16 Pro 128GB renkleri **ayrı contentId ve ayrı barkod** taşıyor ama aynı `productGroupId`
  **653969108**'de: Siyah Titanyum `857296083` (barkod 195949771187), Çöl Titanyum `857296094`
  (barkod 195949771569). Her ikisinde de satıcı Akarsu (724838) ve fiyat 124.999 TL (2026-10-12T00:09Z).
- Dizinde bu gruptan yalnızca **Siyah Titanyum** var; Çöl `857296094` **yok**. Dizindeki Apple ürünü
  sayısı yalnızca 1.603.
- **DÜZELTME (10-urun-gruplari.md):** Aşağıdaki hipotez 164 grupla test edildi ve **yanlış** çıktı: liste
  sayfalarında görülen 180 ürünün 179'u (%99,4) sitemap'te; çok üyeli 9 grubun 8'inde tüm üyeler var. Çöl
  tekil bir eksik.
- ~~**Hipotez (tek gruba dayalı, doğrulanmadı):** sitemap renk grubu (`productGroupId`) başına bir temsilci
  content listeliyor.~~ Doğruysa 8,13 milyon = yaklaşık **ürün grubu** sayısıdır; renk varyantları ve
  onların fiyatları sitemap'ten görünmez.
- Beden varyantları contentId'nin içinde (Samba ID0478: tek content, beden başına barkod).
- Sonuç: kimlik hiyerarşisi `productGroupId (renk grubu) → contentId (renk) → barkod/varyant (beden) →
  satıcı teklifi`. Fiyat en alt düzeyde (teklif) tanımlıdır; eşleştirme bu düzeyi sabitlemeden fiyat bağlamaz
  (`price-enrichment.ts` varyant çelişkisi kuralı).

## 3. Arama kalitesi

Katı başlık araması (`ProductIndex.search`, tüm sorgu belirteçleri slug'da):

| Sorgu | Sonuç |
|---|---|
| iPhone 16 Pro 128 GB | 1 (Siyah Titanyum; grup temsilcisi) |
| Adidas Samba | 614 |
| Nike Air Force 1 | 847 |
| Siyah kadın elbise | 8.987 |
| Sony WH-1000XM5 | 5 |

Gerçek Chrome'da görülmüş 10 referans ürün (03 §2.2, 07 §4):

| Sonuç | Adet | Ayrıntı |
|---|---|---|
| Dizinde var ve sorgu buluyor | **8** | Samba ×2, AF1 ×2, Sony ×3, elbise (FLOWERİNG) |
| Dizinde var, sorgu bulmuyor | 1 | SHEBARA `siyah-asimetrik-sandy-elbise` — başlıkta "kadın" yok; **liste sayfası** (cinsiyet filtresi) bulur |
| Dizinde yok | 1 | iPhone Çöl `857296094` — renk grubu temsilcisi değil (§2) |

**Değerlendirme:** Ürün dizini model sorgularında güçlü (Samba, AF1, Sony 3/3). Öznitelik sorgularında
(renk + cinsiyet + kategori) liste sayfası dizini daha iyi; iki dizin birlikte kullanılmalı (sorgu → liste
sayfası facet'leri + ürün dizini). Renk varyantlarının bir kısmı sitemap'te görünmez.

## 4. Fiyat açısından anlamı

- Dizin ad, görsel ve bağlantı verir; **fiyat vermez**. Fiyat, kimlik hiyerarşisinin en altındaki teklif
  düzeyinde ve yalnızca izinli kaynaklarda (satıcı API'si; H9 Gemini hattı) mevcut.
- Satıcı API'si contentId ve barkod döndürdüğü için dizindeki temsilci content'ten satıcı kataloğuna,
  oradan varyant fiyatına eşleme yapılabilir. Temsilci olmayan renkler (Çöl) yalnızca satıcı kataloğundan
  (veya grup bilgisinden) öğrenilir.

## 5. Sonraki oturum

1. `productGroupId` temsilci hipotezini 5–10 çok renkli üründe gerçek tarayıcıyla sına (her grubun hangi
   content'i sitemap'te?).
2. Liste sayfası + ürün dizini birleşik arama (sorgu → facet sayfası → ürün dizini) ve 50 sorguluk
   kalite ölçümü.
3. H9 (Gemini URL Context ile Trendyol fiyat doğrulaması): kullanıcı onayıyla 5 sorguluk ölçüm.
