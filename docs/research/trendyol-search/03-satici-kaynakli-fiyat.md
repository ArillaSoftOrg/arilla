# Satıcı kaynaklı Trendyol fiyatı (2026-10-12)

Hipotez: Trendyol fiyatının en güvenilir ve izinli kaynağı, ürünü satan **satıcının kendi
Trendyol Partner API'sidir**. Satıcı ManiCepte'yi entegratör olarak yetkilendirirse, ürünün
Trendyol'daki fiyatı contentId ve satıcı kimliğiyle **birebir** öğrenilebilir.

## 1. Resmî belge: "Ürün Filtreleme — Onaylı Ürün v2"

Kaynak: <https://developers.trendyol.com/docs/ürün-filtreleme-onaylı-ürün-v2> (güncelleme
2026-09-11), yetkilendirme, servis limitleri ve SSS sayfaları. Belgeyi bir alt ajan okudu;
alıntılar kısa tutuldu.

| Konu | Belgedeki bilgi |
|---|---|
| Uç nokta | `GET https://apigw.trendyol.com/integration/product/sellers/{sellerId}/products/approved` (stage: `stageapigw…`, IP yetkilendirmesi gerekir) |
| Kimlik doğrulama | Basic auth: satıcının **API Key / API Secret**'ı. Satıcı panelinde "Hesap Bilgilerim > Entegrasyon Bilgileri"; yalnızca master (admin) kullanıcı görebilir |
| User-Agent | Aracı firma: `"<SatıcıId> - <EntegrasyonFirmasıAdı>"` (alfasayısal, ≤30); kendi yazılımı: `"<SatıcıId> - SelfIntegration"`. UA yoksa 403 |
| Filtreler | `contentId`, `barcode`/`barcodes` (≤50), `stockCode`, `productMainId`, `status` (onSale…), tarih, `page`/`size` (≤100), `nextPageToken` |
| Varyant alanları | `variantId, supplierId, barcode, productUrl (…-p-<contentId>?merchantId=<supplierId>), onSale, stock{quantity}, price{salePrice, listPrice, priceSeenByCustomer}, stockCode, locked, archived, blacklisted, …` |
| `priceSeenByCustomer` | **Belgede tanımlı değil**; yalnızca örnek yanıtta (`salePrice 222, listPrice 222, priceSeenByCustomer 169`). OpenAPI şemasında yok |
| Kapsam | "Trendyol mağazanızdaki onaylı ürünlerinizi listeleyebilirsiniz" → yalnızca kimliği doğrulanmış satıcının ürünleri |
| Limit | Ürün okuma grubu: satıcı kademesine göre 1000–2000 istek/dk (14 Eylül 2026'dan beri) |
| Verinin üçüncü taraf gösterimi | **Belirtilmemiş.** Belge API'nin amacını "Trendyol mağazalarını kendi e-ticaret sistemlerine" bağlamak olarak tanımlıyor; entegratörler yalnızca UA kuralında geçiyor |

## 2. Gerçek testler

### 2.1 Sunucudan resmî API'ye erişim (Node, anahtarsız, 1 istek)

`GET …/sellers/724838/products/approved?contentId=857296094&size=1`, UA `724838 - ManiCepte`
→ **401 `TrendyolAuthorizationException`** (`server: cloudflare`).
**Sonuç:** HTML sayfalarının aksine (403) resmî API ağ geçidi Node'dan erişilebilir; yalnızca
satıcı kimlik bilgisi eksik. Taşıma engeli **yok**.

### 2.2 Referans fiyat seti (gerçek Chrome, Trendyol liste JSON'u, 2026-10-11T23:12Z)

Bunlar ileride satıcı API'si yanıtını doğrulamak için **yer gerçeği**dir. `merchantId` = API'deki `supplierId`.

| Sorgu | Ürün | contentId | Satıcı (merchantId) | Gösterilen fiyat | Liste (eski) fiyat |
|---|---|---|---|---|---|
| iPhone 16 Pro 128 GB | Apple iPhone 16 Pro 128GB Çöl Titanyum | 857296094 | 724838 (Akarsu İletişim, ürün sayfasından) | **124.999 TL** | 127.999 TL |
| Adidas Samba | adidas Samba OG Bej Spor Ayakkabı (ID0478) | 813659620 | 106871 | **3.999,50 TL** | 5.599,30 TL |
| Adidas Samba | adidas Samba OG Unisex Beyaz Sneaker | 5999429 | 106871 | 4.799,40 TL | 5.599,30 TL |
| Nike Air Force 1 | Nike Air force 1'07 beyaz ünisex Sneaker | 977783209 | 1082671 | 6.502,80 TL | 6.502,80 TL |
| Nike Air Force 1 | Nike Air Force 1 kadın çocuk sneaker FV5948-101 | 904143719 | 857840 | 2.700 TL | 2.700 TL |
| Siyah kadın elbise | SHEBARA Siyah Asimetrik Sandy Elbise | 1199153821 | 1057112 | 989 TL | 989 TL |
| Siyah kadın elbise | FLOWERİNG Kadın Siyah Kemerli Midi Elbise | 1157405825 | 317942 | 321,06 TL | 321,06 TL |

Gözlemler:
- iPhone'da gösterilen fiyat (124.999), liste fiyatından (127.999) farklı ve **Akakçe'deki Trendyol
  satırıyla aynı**. Hipotez: `salePrice ≈ 127.999`, `priceSeenByCustomer ≈ 124.999` (kampanya sonrası).
  **Doğrulanmadı**; gerçek bir satıcının API yanıtıyla karşılaştırılmalı.
- Akakçe'nin ID0478 sayfasında görünen tekliflerde Trendyol yoktu; Trendyol'da 3.999,50 TL. Akakçe kapsamı eksik.
- **Satıcı dağılımı**: elbise sayfasında 36 ürün **32 farklı satıcıdan**. Telefonda tek satıcı (Akarsu)
  buybox'ı tutuyor; Samba'da 106871 baskın (resmî mağaza olabilir, doğrulanmadı).

### 2.3 Satıcı XML ve veri akışları

- Akakçe/Cimri'ye giden satıcı XML'leri **satıcının kendi sitesinin** fiyatını taşır; Trendyol fiyatı
  entegrasyon yazılımında (İdeasoft, Ticimax, Sentos…) ayrı bir fiyat kuralıyla tutulur. Herkese açık şema
  ya da Trendyol URL'si/barkod içeren standart bir çıktı **bulunamadı**. → Satıcının mağaza fiyatı Trendyol
  fiyatı değildir; kullanılamaz (kural).
- Satıcı izin verirse, aynı veri zaten Partner API'den resmî biçimde gelir; XML'e gerek yok.

### 2.4 Diğer bağımsız kaynaklar

Apify "Trendyol Price Monitor", Trendcord (Discord), Telegram botları, OnuAl (eklenti): hepsi Trendyol'u
kazıyor; izinli kanal değil → **D**. Akakçe: doğru ama anlaşma gerekli ve kapsamı eksik (02 belgesi).

## 3. Kimlik eşleştirme modeli (kod: `price-enrichment.ts`)

| Öncelik | Anahtar | Kaynak | Güven |
|---|---|---|---|
| 1 | Trendyol **contentId** (+ `supplierId`, `variantId`) | URL `-p-<id>`; API `content.contentId` | exact |
| 2 | **barcode / GTIN** | API `variant.barcode` (sitemap'te yok) | exact |
| 3 | **productUrl** (yol kanonik) | API `variant.productUrl` | exact |
| 4 | Üretici **model kodu** (ID0478, CW2288-111, MYNF3TU/A) | başlıklar | high |
| 5 | Başlık belirteçleri (≥%80, depolama birebir) | başlıklar | medium |

Mağaza kuralı ayrıdır: exact eşleşse bile başka mağazanın fiyatı Trendyol fiyatı olmaz. Aynı contentId'de
birden çok Trendyol satıcısı varsa, keşifte görülen satıcının (`merchantId`) teklifi önce gelir.

## 4. Prototip: `trendyol-seller-api.ts`

- Yetkili satıcı listesi (`sellerId`, görünen ad, anahtar; gizli depodan) → contentId ile belgedeki uç noktayı çağırır.
- `onSale && !locked && !archived && !blacklisted && stok > 0` olan varyantlardan `PriceQuote` üretir:
  `store="Trendyol"`, satıcı, supplierId, barkod, variantId, productUrl, kuruş fiyat, **`priceBasis`**.
- Fiyat alanı varsayılanı `salePrice`; `priceSeenByCustomer`'ın anlamı doğrulanınca açılır.
- 401/403/429'da o satıcı atlanır; yeniden deneme yok. Anahtarlar loglanmaz.
- 7 birim testi (belgedeki örnek biçimle sentetik). **Gerçek satıcı verisiyle test edilmedi** (anahtar yok).

## 5. Çok satıcılı mimari

```
keşif (sitemap/liste) → kart {contentId, merchantId?}
   → satıcı kaydı: ManiCepte'yi yetkilendiren satıcılar (OAuth benzeri onboarding yok;
     satıcı API Key/Secret'ını panelden alıp ManiCepte'ye girer, UA "<id> - ManiCepte")
   → (a) merchantId kayıtlıysa doğrudan o satıcı; (b) değilse kayıtlı satıcılarda contentId araması
   → isteğe bağlı: satıcı başına artımlı senkron (dateQueryType=VARIANT_MODIFIED_DATE) ile
     contentId → teklif önbelleği (TTL'li; fiyat yalnızca sorgu anında doğrulanır)
   → enrichPrice: exact eşleşme, satıcı adıyla "Trendyol'da <Satıcı>: 124.999 TL · <zaman>"
```

Kapsam gerçeği: kayıtlı olmayan satıcının ürünü için fiyat **yoktur** (uydurulmaz). Kapsam, kayıtlı
satıcı sayısıyla büyür. Elektronikte birkaç büyük satıcı, modada ise çok sayıda küçük satıcı gerekir
(elbise örneğinde 36 ürün, 32 satıcı).

## 6. Sınıflandırma

| Yöntem | Sınıf | Neden |
|---|---|---|
| Satıcı Partner API (yetkilendiren satıcılar) | **B** | Teknik olarak çalışıyor (API Node'dan erişilebilir, 401 doğrulandı; kod hazır). Gereken: satıcının yazılı onayı + Trendyol'un entegratör/veri gösterimi şartlarının netleşmesi (belge sessiz) |
| `priceSeenByCustomer` anlamı | Açık | Gerçek satıcı yanıtı + Trendyol'da aynı anda görülen fiyatla karşılaştırma gerekli |
| Satıcı XML akışları | D | Trendyol fiyatı değil (satıcı sitesi fiyatı) |
| Kazıma tabanlı fiyat izleyiciler | D | İzinsiz |
| Akakçe | C | Anlaşma + eksik kapsam |

## 7. Sonraki adımlar

1. **Pilot satıcı**: 1–3 satıcıdan (ör. referans setteki 724838, 106871) yazılı onay ve API anahtarı;
   önce stage, sonra prod. Referans setle karşılaştır: `salePrice` / `priceSeenByCustomer` hangisi
   Trendyol'da görünen fiyat?
2. **Trendyol'a soru**: entegratör olarak alınan fiyatın ManiCepte'de (satıcı adıyla, Trendyol bağlantısıyla)
   gösterilmesi Partner Program şartlarına uygun mu? Yazılı yanıt.
3. **Satıcı onboarding ve KVKK**: anahtar saklama (şifreli gizli depo), iptal akışı, satıcı sözleşmesi.
4. Kayıt ölçütü: hangi satıcılar? Keşif dizininde sık görülen buybox satıcılarının (`merchantId`) sıklık
   analizi (liste sayfalarına erişim izni olmadan yalnızca tarayıcı örnekleminden yapılabilir).
