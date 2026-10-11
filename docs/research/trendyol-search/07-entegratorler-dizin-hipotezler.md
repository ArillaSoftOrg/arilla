# Stok-fiyat servisi, entegratörler, dizin doğrulaması, yeni hipotezler (2026-10-12)

## 1. "Onaylı Ürün V2 Stok ve Fiyat" servisi

Kaynak: `docs/ürün-filtreleme-onaylı-ürün-v2-stok-ve-fiyat` (2026-08-07), OpenAPI
`filterApprovedProductsInventoryAndPrice` (2026-08-10). Bir alt ajan okudu.

| | Stok ve Fiyat | Onaylı Ürün V2 | Buybox |
|---|---|---|---|
| Uç nokta | `GET …/sellers/{id}/products/approved/inventory-and-price` | `GET …/products/approved` | `POST …/products/buybox-information` |
| Kapsam | "Onaylı **ürünlerinizin** yalnızca stok ve fiyat bilgisi" | mağazanızdaki onaylı ürünler | "ürünlerinizin" |
| İstek başına | `barcodes` ≤ **50**, `size` ≤ 100 | `barcodes` ≤ 50, `size` ≤ 100 | ≤ **10** barkod |
| Fiyat alanları | `salePrice`, `listPrice` (düz, tanımsız) | `price{salePrice, listPrice, priceSeenByCustomer*}` | `buyboxPrice`, (2./3. örnekte) |
| Diğer | `quantity`, `stockLastModifiedDate` (yalnızca stok değişince), `variantId`, `barcode`, `contentId` | başlık, görsel, `productUrl`, `supplierId`, durumlar, tarihler | `buyboxOrder`, `hasMultipleSeller` |
| Kota grubu (14 Eyl 2026 sonrası) | "Ürün Filtreleme" → **Read** 1.000–2.000/dk (çıkarım; sayfa bu uç noktayı adıyla saymıyor) | Read 1.000–2.000/dk | **Write** 200–600/dk |
| Fiyat değişim zamanı | yok | `sellerModifiedDate` (tarih filtresi var) | yok |

\* yalnızca belge örneğinde, tanımsız.

Anahtarsız erişim testi (Node, 1 istek): **401 `TrendyolAuthorizationException`**, Cloudflare engeli yok.

**Rol:** yetkili satıcının kendi fiyatlarını sık ve ucuz yenilemek (50 barkod/istek, okuma kotası).
`priceSeenByCustomer` ve buybox vermez. Değişen ürünleri bulmak için V2'nin `VARIANT_MODIFIED_DATE`
filtresiyle birlikte kullanılmalı.

## 2. Pazaryeri entegratörleri

| Entegratör | Belgelenmiş API | Trendyol'a özgü fiyat/kimlik | Kimlik doğrulama | Üçüncü taraf/partner | Sonuç |
|---|---|---|---|---|---|
| **Dopigo** | Var (dopigo.readme.io) | **Yok**: ürün başına tek `price` (Satış), `listing_price`, `barcode`; pazaryeri alanı yok | Kullanıcının Dopigo **e-posta + şifresiyle** uzun ömürlü token | Yok (OAuth/partner programı yok) | **D**: Trendyol fiyatı vermiyor; ManiCepte satıcı şifresi toplayamaz |
| Sentos, Ticimax, İdeasoft, Entegra | Herkese açık geliştirici belgesi **bulunamadı** (yalnızca kurulum ve bilgi bankası) | İdeasoft: pazaryeri fiyatı satış fiyatına oran uygulanarak üretiliyor (şablon) | — | — | Doğrulanamadı |
| Genel | Entegratörler satıcının **gönderdiği** fiyatı tutar; müşterinin gördüğü fiyatı (kampanya, sepet, buybox) tutmaz | | | | Çok satıcıyla entegre olmak veri paylaşım yetkisi değildir |

Sonuç: entegratör yolu, satıcı Partner API'sinin **daha zayıf** bir kopyası: aynı satıcı onayı gerekir,
Trendyol'un gösterdiği fiyatı vermez. Kapsamı artırmaz.

## 3. Ürün dizini doğrulaması (236/337 dosya, 5.691.144 ürün; indirme sürüyor)

| Ölçü | Değer | Yorum |
|---|---|---|
| Ürün kimliği (contentId) | 5.691.144, **hepsi benzersiz** | Sitemap ürün (content) başına bir URL; varyant ve satıcı ayrı URL değil |
| Adreslerdeki "marka" slug'ı | **165.774** farklı | **Gerçek marka sayısı değil** (önceki 158.899 de değil) |
| Trendyol marka sitemap'i | **20.089** marka sayfası | Küratörlü marka listesi |
| İkisinde ortak | 19.518 slug → **2.749.473 ürün (%48)** | Ürünlerin yarısından fazlası marka sitemap'inde olmayan slug'larda (satıcı etiketleri, `genel-markalar`, uzun kuyruk) |
| Tek ürünlü slug | 42.070 | |
| Birebir aynı marka+başlık slug'ı | 381.627 grup, **1.147.442 ürün** | Genel adlar (ör. `jabo-wedding-house/abiye` ×262) ve aynı ürünün ayrı content'lerle listelenmesi. Benzersiz **ürün** sayısı contentId sayısından küçük; slug ile tekilleştirme güvenilir değil |

Varyant (beden/renk) ve satıcı tekrarları sitemap'te görünmez: bir contentId birden çok satıcı ve
varyant barındırabilir (Samba: 7 satıcı, beden başına barkod). Buna karşılık aynı model birden çok
contentId'de olabilir (Sony WH-1000XM5: aşağıda 3 content; iPhone: Akakçe'de 2 Trendyol satıcısı, sayfada 1).

## 4. Gerçek fiyat referansı: Sony WH-1000XM5 (gerçek Chrome, 2026-10-11T23:44Z)

| contentId | Satıcı (merchantId) | Varyant | current = discounted = original | Etiketler |
|---|---|---|---|---|
| 312097758 | 105350 | Tek Ebat (Siyah) | **23.949 TL** | taksit |
| 802022106 | 1164603 | Tek Ebat (Mavi) | **16.999 TL** | eventdeal, kırmızı kampanya |
| 961213689 | 624588 | Tek Ebat | **30.699 TL** | taksit |

Aynı model üç farklı content'te, üç satıcıda, 16.999–30.699 TL arasında. "Sony WH-1000XM5'in Trendyol
fiyatı" tek değer değil; content + varyant (renk) + satıcı belirtilmeden fiyat söylenemez.

Beş test ürünü için referans set: 03 §2.2 (iPhone, Samba, AF1, elbise) + bu tablo (Sony) + 06 §2 (Samba 38,5 katmanları).

## 5. Hipotez kaydı

| # | Hipotez | Mekanizma | Kaynak | Erişim | Beklenen kapsam | Güncellik | Ticari şart | Gerçek test |
|---|---|---|---|---|---|---|---|---|
| H1 | Stok-Fiyat uç noktasıyla sık yenileme | Read kotası, 50 barkod/istek | Satıcı API | Satıcı onayı + anahtar | Satıcının kataloğu | Sorgu anı | Belirsiz (Trendyol'a sorulacak) | 401: erişilebilir ✔; veri testi anahtarsız yapılamaz |
| H2 | Entegratör API'leri üzerinden çok satıcı | Entegratörün ürün API'si | Dopigo/Sentos/… | Satıcı hesabı | Satıcının kataloğu | Satıcının gönderdiği fiyat | Belgesiz | Dopigo: Trendyol fiyatı yok, şifreyle token → **D** |
| H3 | Trendyol influencer/affiliate **ajans** ortaklığı (ManiCepte = creator platformu) | Admitad/Takefluence'ın sahip olduğu türden resmî ajans rolü | Trendyol Influencer ekibi | İş anlaşması | Potansiyel olarak geniş | ? | Sözleşme | Test edilemez; başvuru gerekir (**C**) |
| H4 | Google AMP önbelleği / üçüncü taraf önbellekler | Trendyol sayfalarının başka sunucudaki kopyası | Google vb. | — | — | — | — | **Kapsam dışı**: Trendyol bot kuralını başka bir kanaldan dolanmak sayılır; denenmedi |
| H5 | Google Merchant "price competitiveness" | Kendi ürünlerin için perakende referans fiyatı | Google | Merchant Center | Kendi ürünlerin | ? | Market Insights şartları | Trendyol fiyatı değil → **D** |
| H6 | Satıcı Buybox ile rakip kazanan fiyat | Kendi barkodlarının buybox'ı | Satıcı API | Satıcı onayı | Satıcının listelediği barkodlar | Sorgu anı | Belirsiz | 401 ✔; veri testi yok |
| H7 | Yüksek katalog satıcıları (1P "Trendyol" 968: 32.036 ürün) | Trendyol'un kendi perakende hesabı | Trendyol | İş anlaşması | 32 bin ürün | ? | Sözleşme | Satıcı API'si Trendyol 1P için geçerli mi bilinmiyor (**C**) |

## 6. Kapsam ve sonraki adımlar

- Sınıf A yöntem hâlâ yok. B: satıcı API'si üçlüsü (V2 + Stok-Fiyat + Buybox). C: Trendyol ile
  doğrudan veri/ajans anlaşması (H3, H7).
- Sonraki oturum:
  1. Dizin indirmesi bitince §3'ü 337 dosyayla güncelle; sorgu kapsamı (5 sorgu + rastgele 100 sorgu
     örneklemi) ölç.
  2. H3/H7 için Trendyol'a tek başvuru metni: (a) creator platformu olarak influencer/affiliate ajans rolü
     + ürün verisi, (b) entegratör olarak satıcı verisinin gösterim izni, (c) ManiCepteBot için liste
     sayfası erişimi.
  3. Sentos/Ticimax/İdeasoft/Entegra'dan belgelenmiş API olup olmadığını doğrudan sor (yalnızca bilgi).
