# Buybox, fiyat alanları ve geniş kapsam (2026-10-12)

Bağlam: `03-satici-kaynakli-fiyat.md` (Product V2). Bu belge Buybox servisini, ürün sayfasındaki
fiyat yapısını ve "az sayıda yetkili satıcıyla geniş kapsam" sorusunu ele alır.

## 1. Buybox servisi: belge

Kaynaklar: `docs/ürün-buybox-kontrol-servisi-1` (2026-07-20), OpenAPI `reference/getbuyboxinformation`
(2026-06-09), servis limitleri (2026-08-25). Bir alt ajan okudu.

| Konu | Belgede | Not |
|---|---|---|
| Uç nokta | `POST https://apigw.trendyol.com/integration/product/sellers/{sellerId}/products/buybox-information`, gövde `{"barcodes":[…]}` | en fazla **10** barkod |
| Kimlik | Satıcının API Key/Secret'ı, UA `"<SatıcıId> - <Entegratör>"` | yalnızca satıcı |
| Kapsam | "Trendyol'daki **ürünlerinizin** buybox bilgisini öğrenebilirsiniz" | Satıcının satmadığı barkod için davranış **belirtilmemiş** |
| Alanlar | `barcode`, `buyboxOrder` ("Buybox'taki sırası"), `buyboxPrice` ("ürünün buybox fiyatı"), `hasMultipleSeller` | Hiçbir alanın resmî tanımı yok |
| 2./3. fiyat | `secondBuyboxPrice`, `thirdBuyboxPrice` yalnızca **örnek yanıtta**; OpenAPI şemasında yok; satıcı kimliği yok (anonim) | Örnekte `hasMultipleSeller:false` iken 2./3. fiyat dolu, tutarsız |
| Müşteri fiyatı mı? İndirim/kupon dahil mi? | **Belirtilmemiş** | |
| Limit | 14 Eylül 2026'dan beri "Product Integration Write" grubunda, satıcı kademesine göre 200–600 istek/dk (ürün yazma işlemleriyle ortak kota) | 10 barkod/istek → 2.000–6.000 barkod/dk |
| Gösterim/kullanım şartı | **Belirtilmemiş** | |

Belgede başka satıcıların fiyatını veren başka bir servis yok (llms.txt taraması). Rakip, kategori
fiyatı veya komisyon servisi bulunmuyor.

**Yetki sınırı (bu araştırmanın kararı):** Buybox yalnızca yetkili satıcının **kendi
katalogundaki** barkodlarla sorgulanır. Satıcının anahtarıyla satmadığı ürünlerin barkodunu sorgulamak
belgedeki amacın ("ürünlerinizin") dışındadır; denenmeyecek. Kod (`trendyol-buybox.ts`) dışarıdan
barkod kabul etmez.

## 2. Anahtarsız gerçek testler

| # | Test | Sonuç |
|---|---|---|
| 2.1 | Node → Buybox uç noktası (POST, anahtarsız, 1 istek) | **401 `TrendyolAuthorizationException`** (`server: cloudflare`): ağ geçidi erişilebilir |
| 2.2 | iPhone ürün sayfası (gerçek Chrome) | contentId 857296094, **barkod 195949771569**, satıcı 724838 Akarsu, `otherMerchantCount: 0`, `sellingPrice` 124.999, `discountedPrice` 124.999, `originalPrice` 127.999 |
| 2.3 | Akakçe ↔ Trendyol | Akakçe aynı model için iki Trendyol satıcısı gösteriyordu (Akarsu, HALİÇ); 857296094'te tek satıcı var → **aynı GTIN başka contentId'de de satılıyor**. Barkod → birden çok contentId olabilir |
| 2.4 | Samba ID0478 ürün sayfası | Buybox satıcısı **SuperStep (106871)**, `otherMerchantCount: 6`. Barkod **beden başına** farklı: gerçek adidas EAN'ları (ör. 36 → `4066765863348`) ve satıcıya özgü `TYB…` kodları |
| 2.5 | Aynı barkodun teklifleri | Beden 36 / `4066765863348` birden çok satıcı teklifinde **farklı fiyatlarla** (7.199; 7.199,1; 7.999 TL) → buybox **barkod düzeyinde satıcılar arası sıralama** hipoteziyle uyumlu |
| 2.6 | Sayfa fiyat nesnesi | `{discountedPrice, sellingPrice, originalPrice, rrp, discountPercentage, couponApplicablePrice, profitMargin}`; Samba varsayılan teklif: discounted 5.349, selling 5.524, original 5.349, kupon 5.349 |
| 2.7 | Liste ↔ ürün sayfası | Liste kartı Samba için 3.999,50 TL gösteriyordu; ürün sayfasındaki varsayılan teklif 5.349 TL → **liste fiyatı ≠ varsayılan varyant fiyatı** (muhtemelen en düşük beden/teklif; doğrulanmadı) |

## 3. Fiyat alanları: hipotezler (doğrulanmadı)

| Sayfa alanı (gözlem) | API alanı (belge) | Hipotez |
|---|---|---|
| `sellingPrice` | `salePrice` | Satıcının girdiği satış fiyatı |
| `originalPrice` | `listPrice` | Üstü çizili/liste fiyatı (Samba'da selling'den düşük olması tutarsız; kampanya mantığı belgelenmemiş) |
| `discountedPrice` | `priceSeenByCustomer` | Kampanya sonrası müşteri fiyatı (iPhone 124.999 / 127.999; Akakçe de 124.999) |
| `couponApplicablePrice` | — | Kupon uygulanabilir fiyat; API'de karşılığı yok |
| liste kartı `discountedPriceText` | `buyboxPrice`? | Buybox kazananın müşteri fiyatı (çok varyantlıda hangi varyant olduğu belirsiz) |

Bunlar **varsayım değil hipotezdir**; `05-test-protokolu.md` ile ilk yetkili erişimde doğrulanacak.

## 4. Geniş kapsam: az sayıda satıcıyla ne kadar fiyat?

```
yetkili satıcı S → Product V2 (S'nin kataloğu: contentId, barkod, varyant, kendi fiyatı)
               → Buybox(S'nin barkodları) → her barkod için kazanan fiyat (+ 2./3. anonim)
```

- S kendi kataloğundaki **her** ürün için, buybox'ı kimin kazandığından bağımsız olarak, Trendyol'da o
  barkodun kazanan fiyatını öğrenir. Dolayısıyla kapsam = S'nin **kendi teklifleri + kendi listelediği
  ürünlerin rakip kazanan fiyatları**. Bu, S'nin yalnızca kazandığı ürünlerden daha geniş.
- Kapsam **S'nin listelediği barkodlarla sınırlı.** Geniş katalog listeleyen satıcılar (distribütör,
  çok markalı elektronik/spor mağazaları) bu yüzden en değerli pilotlardır.
- Kazanan satıcının **kimliği bilinmez** (S değilse). Kart "Trendyol'daki en uygun teklif: X TL"
  diyebilir ama satıcı adı veremez; bağlantı contentId sayfasıdır (buybox o sayfada gösterilir).
- **Kör noktalar:**
  - aynı GTIN'in başka contentId'leri (2.3);
  - satıcıya özgü `TYB…` barkodlu teklifler (2.4), çünkü GTIN eşleşmez;
  - modada çok satıcılı uzun kuyruk (36 elbise, 32 satıcı).
- Kota: satıcı başına 200–600 istek/dk (yazma işlemleriyle ortak) → satıcının kendi operasyonunu
  aksatmamak için ManiCepte sorguları düşük öncelikli ve kotanın küçük bir payıyla sınırlı tutulmalı.

Eşleştirme (`price-enrichment.ts` sırası): contentId (satıcı kataloğundan) → barkod/GTIN → productUrl
→ model kodu → başlık. Buybox teklifi `store="Trendyol"`, `priceBasis="buyboxPrice"`; kazanan S değilse
`seller=null`.

## 5. Bağımsız alternatifler (bu turda)

| Kaynak | Sonuç |
|---|---|
| Bright Data "Trendyol MAP Monitoring", Apify aktörleri, "T-Retail Scraper" eklentisi | Kazıma tabanlı, Türk konut proxy'si ile → **D** |
| GS1 Türkiye (barkod/GEPIR) | Ürün ve firma kimliği; **fiyat yok**. Kimlik doğrulamada yardımcı olabilir (başvuru gerekir) |
| Akakçe | Doğru ama kapsam eksik ve anlaşma gerekli (02) |
| Trendyol belgelerinde başka fiyat servisi | Yok (Settlements/Financials yalnızca satıcının kendi satışları) |

## 6. Sınıflandırma güncellemesi

| Yöntem | Sınıf | Gerekçe |
|---|---|---|
| Satıcı Product V2 (kendi teklifleri) | B | Ağ geçidi erişilebilir (401), kod hazır; satıcı onayı ve Trendyol gösterim şartı gerekli |
| Satıcı Buybox (kendi barkodları için kazanan fiyat) | B | Aynı; 2./3. fiyat anonim ve belgelenmemiş |
| Buybox ile satıcının satmadığı barkodlar | **Kapsam dışı** (yetki sınırı) | Belge "ürünlerinizin" diyor |
