# Fiyat doğrulama sistemi, satıcı pilotu ve yeni sitemap üretimi (2026-10-12)

## 1. Prototip envanteri: gerçek veri mi, örnek mi?

| Bileşen | Alan / davranış | Gerçek veriyle doğrulandı mı? |
|---|---|---|
| Ürün sitemap dizini | contentId, slug, CDN görseli | **Evet** (8.126.053; 20 liste sayfasıyla %99,86) |
| Liste sayfası dizini + çıkarıcı | ad, fiyat metni, görsel, contentId, groupId, merchantId, variantValue | **Evet** (gerçek Chrome, 20 sayfa) |
| `trendyol-seller-api.ts` (Onaylı Ürün V2) | uç nokta, Basic auth, UA biçimi | Uç nokta erişimi **evet** (anahtarsız 401). Yanıt alanları (`salePrice`, `listPrice`, `priceSeenByCustomer`, `variants[].attributes`, `productUrl`) **yalnızca belge örneği** |
| `trendyol-buybox.ts` | POST, ≤10 barkod | Erişim **evet** (401). `buyboxPrice`, `buyboxOrder`, 2./3. fiyat **yalnızca belge örneği** (2./3. OpenAPI'de yok) |
| `seller-pilot.ts` (Stok-Fiyat) | `salePrice`, `listPrice`, `quantity` | Erişim **evet** (401). Alanlar **yalnızca belge örneği** |
| `price-enrichment.ts` | kimlik/varyant eşleştirmesi | Kurallar gerçek gözlemlerden türetildi; satıcı verisiyle **test edilmedi** |
| `price-observation.ts` | indirim dedektörleri | **Gerçek** tarayıcı fiyatlarıyla test edildi (Samba %50, %25, %21; iPhone 3.000 TL sabit) |
| `priceSeenByCustomer` anlamı | — | **Doğrulanmadı** (belgede tanımsız) |
| buybox ↔ sayfa fiyatı ilişkisi | — | **Doğrulanmadı** |

Hiçbir satıcı veya Buybox API yanıtı gerçek olarak alınmadı (anahtar yok). Başarılı entegrasyon iddiası yoktur.

## 2. Fiyat doğrulama sistemi (`price-observation.ts`)

**Veri modeli** (`PriceObservation`): her fiyat ayrı bir gözlemdir.
- **Tür:**
  - satıcı API: `seller.salePrice`, `seller.listPrice`, `seller.priceSeenByCustomer`;
  - Buybox API: `buybox.price`, `buybox.second`, `buybox.third`;
  - ürün sayfası: `page.selling`, `page.discounted`, `page.original`, `page.coupon`, `page.basket`;
  - liste kartı: `listing.current`, `listing.discounted`, `listing.original`.
- **Kimlik:** `contentId`, `barcode` (beden başına), `variant` (renk/beden).
- **Fiyat:** `supplierId` (buybox 2./3.'de null), `priceKurus` (tamsayı), `currency`.
- **Bağlam:** `observedAt` (UTC), `source`, kampanya `tags`.

**Karşılaştırma (`comparePair`)**, sırasıyla:
1. Barkod farklı → `variant-mismatch`. Barkod yoksa ve varyant bir tarafta bilinmiyorsa → `variant-unknown`.
   Çok bedenli üründe hangi bedenin fiyatı olduğu belirsizse karşılaştırılmaz.
2. Satıcı farklı → `seller-mismatch` (anonim buybox hipotezlerinde muaf).
3. Zaman farkı > pencere (varsayılan 5 dk) → `time-gap`. Farklı zamanlar eşit varsayılmaz.
4. Eşit → `equal`. Değilse neden sınıflandırılır: `percent-discount` (tam sayı yüzde, ±1 kuruş),
   `fixed-discount` (100 TL'nin katı), `campaign-tagged`, yoksa `unexplained`.

**Hipotezler** (`HYPOTHESES`, hiçbiri doğrulanmış değil):

| Kimlik | Hipotez |
|---|---|
| H1 | `priceSeenByCustomer` = sayfa `discounted` |
| H2 | `salePrice` = sayfa `selling` |
| H3 | `listPrice` = sayfa `original` |
| H5 | `buyboxPrice` = sayfa `discounted` |
| H7 | liste `discounted` = sayfa `basket` |

**Referans set** (`reference-observations.ts`): 14 gerçek tarayıcı gözlemi (iPhone, Samba 38,5, Sony).
Samba'nın daha önceki varsayılan varyant gözlemi, bedeni doğrulanmadığı için `variant: null` olarak
kaydedildi; bu yüzden karşılaştırmaya girmez.

**Rapor CLI'si:**

```
node --experimental-transform-types --no-warnings scripts/trendyol-price-compare.ts [gozlem.json ...] [--skew-min 5]
```

Bugünkü çıktı (yalnızca referans set):
- H1, H2, H3, H5: **DOĞRULANMADI** (çift yok, satıcı/buybox gözlemi yok).
- H7: 1 çift, eşit **değil**. Samba liste 3.999,50 ile sayfa sepet 5.399,25, 28 sn arayla; kampanya etiketli.
  Liste kartının fiyatı sayfadaki sepet fiyatına eşit varsayılamaz.

Uçtan uca boru hattı tek bir **sentetik** satıcı gözlemiyle denendi (yalnızca çalıştığını görmek için;
sonuç doğrulama sayılmaz, dosya silindi).

## 3. Yetkili satıcı pilotu (`seller-pilot.ts`)

- **Anahtar:**
  - Yalnızca sunucuda, `SecretResolver` ile (ortam değişkeni veya secret manager) okunur.
  - Modül anahtarı saklamaz ve loglamaz; `redact()` anahtarı, sırrı ve `Basic …` başlığını gizler.
  - İstemciye hiçbir zaman gitmez. Gerçek kimlik bilgisi istenmedi, üretilmedi.
- **Salt okunur:**
  - Yalnızca okuma uç noktaları kullanılır: Stok-Fiyat (Read, 50 barkod), Onaylı Ürün V2 (Read) ve Buybox (Write grubu ama okuma işlemi; 10 barkod, yalnızca satıcının kendi barkodları).
  - Fiyat/stok güncelleme çağrılmaz.
- **Kota (`SellerQuota`):**
  - Satıcı kademesine göre grup limitleri: Read 1.000–2.000, Write 200–600 /dk.
  - ManiCepte payı varsayılan Read %10, Write %5. 50k kademede bu 100 ve 10 istek/dk eder.
  - Uç nokta başına 10 sn'de en fazla 50 istek.
  - Pay dolunca istek atılmaz, ertelenir. Böylece satıcının kendi stok/fiyat güncellemeleri (Write) aksamaz.
- **Plan (`planRefresh`):** Fiyat için önce Stok-Fiyat (50'li). Buybox yalnızca istenen barkodlar için ve
  Write payı yetiyorsa (10'lu). Örnek: 50k kademede 120 barkod → 3 Stok-Fiyat çağrısı; Buybox 10 çağrı,
  2 grup ertelendi.
- **Gözlem üretimi:** `observationsFromInventoryAndPrice` → `seller.salePrice` / `seller.listPrice` gözlemleri;
  doğrudan karşılaştırma motoruna girer.

## 4. Yeni sitemap üretimi (gerçek ölçüm)

- `sitemap_index.xml`: yeni `lastmod` **2026-10-12T00:35:46Z** (önceki 2026-10-11T16:39:34Z, ~8 saat).
  TR ürün dosyası sayısı **337 → 336**.
- **Dosya bazlı fark yanıltıcı:** Dosya 1, 150 ve 300'de dosya başına ~24.050 ekleme ve ~24.030 silme görüldü.
  Trendyol her üretimde ürünleri dosyalara **yeniden dağıtıyor**.
- **Doğru ölçü (tüm kümeye göre):** Yeni üretimden 72.384 ürünlük örneğin **%99,906**'sı önceki tam dizinde
  var; 68'i (%0,094) yeni.
  - Kaba tahmin: üretim başına ~7–8 bin yeni content.
  - Yeni kimliklerin çoğu yeni değil (medyan id 1,09 milyar, en küçük 57 milyon). Muhtemelen sitemap'e yeniden
    giren ürünler; doğrulanmadı.
  - Silinenler örneklemden ölçülemez (tam yeni küme gerekir).
- iPhone Çöl (857296094) yeni örnekte de yok.
- `trendyol-sitemap-diff.ts` artık tüm-küme karşılaştırması yapıyor (`<tmp>/manicepte-trendyol-ids.bin`).
  Dosya bazlı fark yalnızca bilgi olarak yazılıyor.

## 5. Paralel fiyat araştırması

Bu turda **somut teknik kanıtı olan yeni bir dağıtım kanalı bulunamadı**. Önceki turlarda elenen kaynaklar
tekrarlanmadı (02–11). Trendyol fiyatını üçüncü taraflara aktarma yetkisi belgelenmiş bir kaynak hâlâ yok.

## 6. Sonraki oturum

1. Yetkili satıcı gelirse:
   - `SecretResolver` için sunucu tarafında bir gizli değişken tanımla.
   - Stage'de Stok-Fiyat + V2 + Buybox çağrılarından gözlem JSON'u üret.
   - Aynı dakikada tarayıcıdan sayfa gözlemleri kaydet.
   - `trendyol-price-compare.ts` ile H1–H5 için eşitlik oranlarını ölç.
2. Sitemap: bir sonraki `lastmod` sonrası `trendyol-sitemap-diff.ts`.
   Silinen oranı için tam yeni küme gerekirse 336 dosyanın tamamı (kibar hızda) indirilmeli.
3. Gemini (H9) ölçümü yalnızca kullanıcı onayıyla.
