# Tarayıcı tabanlı okuma: fizibilite, alan doğrulaması, kapsam (2026-10-15)

**Bağlam:**
- Trendyol resmî API vermiyor, CORS açılmayacak.
- Hepsiburada'daki tarayıcı tabanlı yöntemin benzerine **sözlü izin** verildi.
- Yenileme sınırı: haftada 1, ayda 4.
- Karar: [`docs/decisions/0117`](../../decisions/0117-trendyol-tarayici-tabanli-okuma.md).
- Kod: `packages/core/src/live-search-browser/`; bayrak `TRENDYOL_BROWSER_READ_ENABLED`, varsayılan kapalı.

**Yöntem (eski deneyler tekrarlanmadı):**
- Önce **kayıtlı HTML** incelendi (12 Ekim):
  - `pp.html`: iPhone 16 Pro Çöl;
  - `p1.html`: iPhone 16 Pro Max;
  - `cat1`, `l2`, `l3.html`: kategori sayfaları.
- Bedenli ve çok satıcılı yapıyı görmek için kullanıcının Chrome'unda **tek** bir normal sayfa ziyareti yapıldı (Samba ID0478, 14 Ekim 22:30Z). Toplu istek yok.

## 1. Trendyol origin'indeki sayfada ne var?

Ürün sayfası 170–192 `<script>` içeriyor. Fiyatın kaynağı sunucunun gömdüğü JSON; ayrı bir istek gerekmiyor.

| Kaynak | İçerik | Not |
|---|---|---|
| `window["__envoy__SHARED_PROPS"].product` | `id` (contentId), `name`, `brand`, `category`, `images[]`, `productGroupId`, `slicingAttributes`, `inStock`, `variants[]`, `merchantListing` | Ana kaynak |
| `…merchantListing.merchant` | `id`, `name`, `sellerScore` + **vergi no, KEP e-postası, adres, unvan, il** | Yalnız `id` ve `name` okunur (0117 §5) |
| `…merchantListing.winnerVariant` | `itemNumber`, `listingId`, `barcode`, `inStock`, `stockStatus`, `isRunningOut`/`runningOutQuantity`, `price{discountedPrice, sellingPrice, originalPrice, couponApplicablePrice, tyPlusCouponApplicablePrice, discountedPriceAfterNoLimitPromotions, discountPercentage}`, `tagDetails[]` | Kazanan teklif |
| `…merchantListing.variants[]` | Kazanan satıcının varyantları: `itemNumber`, `value`, `inStock` | Samba: 7 |
| `product.variants[]` | Ürün düzeyi varyantlar: `value`, `barcode`, `price{value,text}`, `inStock` | Samba: **15**. Satıcının listesinde olmayanların fiyatı başka satıcıya ait olabilir |
| JSON-LD `Product` / `ProductGroup` | `name`, `image.contentUrl[]`, `sku`, `color`, `brand`, `offers{price, priceCurrency, availability}`, `hasVariant[]`, `size[]` | `hasVariant` = **renk kardeşleri** (başka contentId, kendi fiyatı, `gtin12`); beden değil |
| `window["__envoy_side-other-seller__PROPS"]` | `hasOtherMerchant`, `otherMerchantCount` | Diğer satıcıların teklifleri **SSR'da yok**; dahili servisten yükleniyor, okunmaz |
| Liste sayfası `__single-search-result__PROPS` | 36 kart: `contentId`, `name`, `brand`, `merchantId`, `price{current, discounted, original…}`, `image`, `groupId`, `variantValue`, `itemNumber`, `tagStockBar.isSoldOut`; `stock: {}` | Sayfalama (`?pi=`) robots ile yasak → yalnız ilk 36 |

## 2. Alanlar tek tek: erişilebilir mi?

| Alan | Ürün sayfası | Liste sayfası | Kanıt |
|---|---|---|---|
| Ad | ✔ (JSON-LD markalı ad; SSR adı markasız) | ✔ marka + ad | pp, p1, Samba; cat1/l2/l3 108/108 |
| Fiyat | ✔ katmanlı, kuruş. JSON-LD `price` = `discounted` (3/3) | ✔ tek fiyat (`discountedPriceText`) | iPhone 124.999 / 127.999; Samba 3.999,50 (%50 sepet) / 7.999 / 5.599,30 |
| Görsel | ✔ 8–9 adet `cdn.dsmcdn.com` | ✔ 400 px | |
| Satıcı | ✔ id + ad (yalnız **kazanan** teklif). Diğer satıcılar ✘ (yalnız sayısı) | ✔ yalnız `merchantId` (ad yok) | 724838 Akarsu, 429601 İçke, 106871 SuperStep |
| Varyant | ✔ beden, barkod, fiyat, stok. Satıcıya ait olan `merchantListing.variants` ile ayrılır | ✘ yalnız gösterilen varyant | Samba 15 / 7 |
| Stok | ✔ `inStock`, `stockStatus`, "son N ürün" | ✘ (`stock: {}`; yalnız `isSoldOut`) | iPhone `runningOutQuantity: 1` |
| Barkod / GTIN | ✔ GS1 geçerli (iPhone `195949771569`, Samba EAN'lar) | ✘ | |
| Renk grubu | ✔ `productGroupId` + JSON-LD kardeş contentId'ler ve fiyatları | ✔ `groupId` | Kardeş fiyatının satıcısı belirsiz → katalog fiyatı yapılmaz |

**Riskler ve önlemler (kodda):**
- **Bayat gömülü veri.** Sayfa içinde gezinmeden sonra gömülü veri eski ürüne ait kalabilir.
  - Önlem: adresteki contentId gömülü veriyle eşleşmezse gözlem atılır (`staleEmbeddedData`).
- **Başka satıcının varyant fiyatı.** Ürün düzeyindeki varyant fiyatı başka bir satıcıya ait olabilir.
  - Önlem: teklife yalnız kazanan satıcının listesindeki varyantlar bağlanır; diğerleri `unattributedVariants` olarak sayılır.
- **Gereğinden fazla veri.** Satıcı nesnesinde kişisel ve kurumsal alanlar var.
  - Önlem: ayrıştırıcı bu alanları okumuyor; testte `REDACTED` metni çıktıda aranıyor.
- **"Ödenecek" fiyat sepet indirimi içerebilir.** Samba'da `discounted` %50 sepet indirimli fiyat.
  - Önlem: katman ve kaynak etiketi ayrı saklanır; matematik yapılmaz.

## 3. Eklenti / içerik betiği uygulanabilirliği

| Soru | Cevap |
|---|---|
| İçerik betiği gömülü veriyi okuyabilir mi? | Evet. `<script>` metinleri DOM'dadır; izole dünyadan `textContent` ile okunur. Sayfa değişkenine (`window[...]`) erişim gerekmez. Mevcut prototip (`apps/live-search-extension`) aynı yolla `/sr` sayfasında çalıştı (araştırma 01, 0.8) |
| Ağ isteği gerekir mi? | Hayır. Okuma, açık sayfanın kendi HTML'inden yapılır |
| İzinler | `content_scripts.matches` yalnız `https://www.trendyol.com/*-p-*` ve liste sayfaları; `storage`. Veri gönderimi için ManiCepte API host izni gerekir (henüz yok) |
| Core'daki ortak kod | `collectPageInputs(document, location.href)` → `extractTrendyolProductPage` / `extractSearchPage`. Bağımlılık yok; tarayıcıya paketlenebilir |
| Açık | Eklentinin core'u paketlemesi (esbuild) ve gönderim uç noktası. İzin kapsamı yazılı olmadan **eklenmedi** |

## 4. Sitemap kimlikleriyle eşleştirme (ölçüldü)

- 3 kayıtlı liste sayfası 108 farklı ürün içeriyor; sayfalar arasında çakışma yok.
  - 08:51 üretiminde: **108/108**.
  - 16:39 üretiminde: 103. Eksik 5'in 4'ü yeni eklenen kimlikler (1,21 milyar), 1'i iPhone Çöl (geçici eksiklik, 13).
- Ürün sayfası: contentId ve kanonik adres doğrudan geliyor; eşleme ikili aramayla (`sitemap-match.ts`) yapılıyor.
- Sitemap'te olmayan ürün reddedilmez; `not_in_sitemap` olarak işaretlenir. Yeni ya da geçici çıkmış olabilir.

## 5. Gerçek kapsam (8,13 milyonun tamamı varsayılmadı)

Ulaşılabilir kapsam **izinli hıza** bağlıdır ve hız bilinmiyor. Hesaplar yalnız üst sınırdır:

| Yöntem | Sayfa başına ürün | Okunan alanlar | 7 günde, 5 sn/sayfa | 8,13 M'ye oranı |
|---|---|---|---|---|
| Ürün sayfası | 1 (+ renk kardeşlerinin fiyatı, satıcısı belirsiz) | Tümü | 120.960 ürün | %1,5 |
| Liste sayfası (yalnız ilk 36) | 36 | Ad, fiyat, görsel, satıcı kimliği (stok ve varyant yok) | En fazla 4,35 M kart; benzersiz oran **ölçülmedi** | ≤ %53 (çakışma bilinmiyor) |

- **Tavan:** Liste sayfası dizini 455.549 sayfa × 36 = 16,4 M kart. Gerçek benzersiz kapsam ancak izinli bir döngüyle ölçülebilir.
- **Talep önceliği:** Yorumlu ürünler (505.640, belge 14) bile 5 sn/sayfa hızla 29 gün sürer, yani tek döngüye sığmaz. Öncelik sırası şöyle olmalı:
  1. ManiCepte'de aranan ya da tıklanan ürünler;
  2. yorumlu ürünler;
  3. kategori liste sayfaları.
- **Pasif okuma:** Kullanıcının kendi gezdiği sayfalardan yapılırsa kapsam küçük ve rastgele olur; kitle kaynağı ayrıca izin ve KVKK kararı ister.

## 6. Kota ve kontrol noktası (`refresh-quota.ts`)

- **Yeni döngü:** Son döngü başlangıcından 7 × 24 saat geçmeden yenisi başlamaz.
  - İstanbul takvim ayında en fazla 4 döngü başlar. Başlayan her döngü kotadan düşer (5. hafta reddedilir; testte 1, 8, 15, 22 → 29 Ekim reddi).
- **Döngü kaydı:** Hedef listesi başta sabitlenir (sha256). İlerleme tek yönlü bir imleçle tutulur; her ürün döngü başına bir kez okunur.
  - Kayıtta gözlenen / eksik / hatalı sayıları ve `updatedAt` var.
- **Devam:** Yalnız 7 günlük pencere içinde ve aynı listeyle yapılır.
  - Pencere dolunca döngü `expired` olur; kalan ürünler sonraki döngüye kalır.
  - 403/429 gibi bir durma (`stopped`) aynı döngüde otomatik devam etmez.
- **Kapı:** Kayıt dosyasını yazan çalıştırıcı, `bulkRefreshGate` iki bayrağı birlikte görmedikçe döngü başlatamaz. Bayraklardan biri yazılı kapsam onayıdır.

## 7. Katalog aktarımına hazırlık (yalnız önizleme)

`catalog-rows.ts`, main şemasına (0111/0113) göre satır önizlemesi üretir:
- `seller`;
- `offer` (`<contentId>:<saticiId>`, kanonik adres + `?merchantId=`);
- `offer_variant`;
- `price_point` adayı (INSERT);
- fiyat katmanları (`price_verification.discount_conditions` adayı).

Uymayan CHECK değerleri (`source_type`, `discovery_source`, `gtin_source`) `schemaGaps` olarak raporlanır. Migration yazılmadı (0117 §Sonuçlar).

Kuru çalışma: `scripts/live-search-browser-dry-run.ts`. Ağ yok, bayrak kapalıyken çalışmaz. Kayıtlı 2 ürün sayfası ve 3 liste sayfası için sonuç:

| | Değer |
|---|---|
| Ürün sayfasında eksik alan | 0/2 |
| JSON-LD = `discounted` | 2/2 |
| Katalog satırı ve `price_point` adayı | 2/2 |
| Liste kartı | 108; fiyat 108, satıcı kimliği 108, stok 0 |

## 8. Yapılmayanlar

- Toplu ya da otomatik tarama yapılmadı.
- Production'a veri aktarılmadı; migration yazılmadı.
- Eklentiye gönderim kodu eklenmedi.
- Diğer satıcıların teklifleri okunmadı (dahili servis).
- Liste sayfalaması (`?pi=`) kullanılmadı.

## 9. Yazılı izin için sorular (0117 §Açık)

1. Okuyan kim? Operatörün tarayıcısı mı, kullanıcıların eklentisi mi?
2. Hangi sayfalar (ürün / liste) ve hangi hızda?
3. ManiCepte'de ad, fiyat ve görsel gösterimi ve saklama süresi.
4. Satıcı adının gösterimi.
5. Affiliate takibi.
6. "Haftada 1" kayan 7 gün mü, takvim haftası mı? Kod kayan pencereyi uyguluyor (daha sıkı).
