# Fiyat keşfi ve fiyat zenginleştirme (2026-10-12)

Ürün keşfi (ad, görsel, bağlantı) çözüldü (bkz. `01-kanit-kaydi.md`). Bu belge yalnızca
**fiyat** sorusunu ele alır: Trendyol ürününün güncel fiyatını, Trendyol'un HTML'ine
bağlanmadan, yetkili biçimde öğrenmek.

## Test edilen kaynaklar

Tüm tarayıcı testleri normal ziyaretle yapıldı. Sunucu testleri dürüst UA ile yapıldı ve
her kaynağa en fazla 1 istek atıldı.

### Fiyat karşılaştırma platformları

| Kaynak | Resmî/izinli veri kanalı | Trendyol fiyatı var mı | Sunucudan (Node) | Kullanım koşulları | Sınıf |
|---|---|---|---|---|---|
| **Akakçe** | Yalnızca **içe** XML feed (mağaza → Akakçe); dışa API veya veri ortaklığı belgesi yok | **Evet**: iPhone 16 Pro 128GB Çöl Titanyum sayfasında 6 teklifin 2'si Trendyol (Akarsu İletişim **124.999,00 TL**, HALİÇ İLETİŞİM); teklif başına "Son güncelleme: 46 dakika önce" | **403** (Cloudflare) | "veritabanlarını, katalogları ve listeleri çoğaltmayacağını, kopyalamayacağını, dağıtmayacağını…" → izinsiz kullanılamaz | **C** (veri anlaşması) |
| **Cimri** | Yalnızca içe Google-XML feed | Ölçülemedi | — | — | **D**: gerçek tarayıcıda bile Cloudflare "Attention Required" sayfası; aşılmadı |
| **Epey** | Yok (robots: `/api/`, `/ara/` yasak; ürün sayfaları ve `sitemap/urun*.xml` serbest) | **Hayır**: iPhone 16 Pro sayfasında Idefix, PTT AVM, Hepsiburada (7), Getmobil var; Trendyol yalnızca filtre listesinde | sitemap 200 | — | **D** (Trendyol fiyatı yok) |

### Akakçe'de kod ile eşleştirme (gerçek)

| Ürün | Akakçe sayfası | Trendyol teklifi | Not |
|---|---|---|---|
| iPhone 16 Pro 128 GB Çöl Titanyum | `…iphone-16-pro-128-gb-col-titanyum-fiyati,760882078.html` | **124.999,00 TL**, satıcı Akarsu İletişim | Trendyol'un kendi liste JSON'undaki fiyat ve satıcıyla **birebir aynı** (çapraz doğrulama). Satırda Trendyol ürün kimliği yok; eşleşme başlık, satıcı ve fiyat üzerinden → orta güven |
| Adidas Samba OG **ID0478** | `…adidas-samba-og-id0478-…,775233135.html` | Görünen 15/28 teklifte yok (Boyner, idefix, Pazarama, Amazon, Hepsiburada) | Model kodu Trendyol başlığıyla eşleşiyor (yüksek güven); Trendyol teklifi görünmüyor |
| Nike Air Force 1 07 **CW2288-111** | `…nike-air-force-1-07-cw2288-111-…,1299978222.html` | Görünen 6/15 teklifte yok | Akakçe'nin moda bölümü (`/moda/*`) robots ile yasak |

### Diğer hipotezler

| Hipotez | Sonuç |
|---|---|
| Ürün kimliği, barkod veya GTIN ile eşleştirme | Trendyol sitemap'inde barkod yok; ürün sayfasındaki (Node 403) JSON-LD'de de GTIN görülmedi. Akakçe JSON-LD'si `ProductGroup` + `AggregateOffer` (6 teklif, 118.750–135.000 TRY) veriyor, GTIN vermiyor. **Model kodu** (ID0478, CW2288-111, B75806, Apple TU/A kodları) Trendyol başlıklarında sık geçiyor → mağazalar arası en güçlü eşleştirme anahtarı |
| Üretici fiyatı (adidas.com.tr, nike.com/tr, apple.com/tr) | Üreticinin kendi satış fiyatı; **Trendyol fiyatı değildir**. Gösterilecekse "Üretici fiyatı" olarak etiketlenmeli. Test edilmedi |
| Hepsiburada (eklentisiz CORS, ayrı çalışma) | Hepsiburada fiyatını verir, Trendyol fiyatını değil. "Diğer mağazalar" bölümünde etiketli gösterilebilir (B, hukuki onay gerekir) |
| Ücretli veya ücretsiz üçüncü taraf fiyat API'leri | Sovrn'de TR pazarı yok (D). Apify ve benzeri "Trendyol scraper" servisleri yerleşik (residential) proxy ile engel aşıyor → **kullanılamaz** (D, ilke) |
| Google Shopping, Bing | Herkese açık API yok veya kapandı (D) |

## Sonuç

- **Trendyol fiyatını Trendyol dışından öğrenmenin doğrulanmış tek kaynağı Akakçe.** Doğru
  fiyatı (124.999 TL) ve satıcıyı veriyor, teklif başına güncellik bilgisi var. Ama:
  sunucuya kapalı (403), kullanım koşulları veritabanının kopyalanmasını yasaklıyor, kapsamı
  tam değil (spor ayakkabıda görünen tekliflerde Trendyol yok). → **C: Akakçe ile veri anlaşması.**
- İzinsiz ve bugün çalışan bir Trendyol fiyat kaynağı **bulunamadı**. Fiyat uydurulmadı.

## Fiyat zenginleştirme mimarisi (kod: `price-enrichment.ts`)

```
ürün keşfi (sitemap dizini) → ürün kartı {store, storeProductId, title, url}
   → PriceProvider[] (paralel, zaman aşımlı, hatası kartı bozmaz)
      1. trendyol-direct   : liste/ürün JSON'u (Trendyol izni + bot izin listesi gerekir)
      2. aggregator-partner: Akakçe gibi anlaşmalı kaynak (Trendyol satırı + güncellik)
      3. other-stores      : Hepsiburada CORS, anlaşmalı feed'ler (yalnızca "diğer mağaza")
   → matchConfidence: exact (aynı mağaza + kimlik) > high (ortak model kodu)
                      > medium (başlık ≥%80 + depolama birebir) > low (atılır)
   → kurallar: TRY, pozitif tamsayı kuruş, ≤24 saat; Trendyol fiyatı yalnızca store="Trendyol"
   → kart: trendyolPrice | otherStores[] (etiketli) | "Fiyatı mağazada gör"
```

- Kalıcı depolama gerekmez: teklifler kısa ömürlü önbellekte tutulur (ör. 15–60 dk, sorgu anahtarıyla).
  Ürün kataloğuna geçilirse fiyat `price_point` hattına (değiştirilemez, INSERT) yazılmalıdır.
- Gösterim: kaynak ve zaman her fiyatta görünür ("Akakçe'den, 46 dk önce").
- 8 birim testi gerçek gözlemlerle yazıldı: Akakçe'deki Trendyol satırı → medium; ID0478 → high;
  256 GB ≠ 128 GB → low; başka mağaza fiyatı Trendyol fiyatı olmuyor.

## Başvuru listesi (fiyat için)

1. **Akakçe**: veri ortaklığı. İstenecekler: Trendyol teklifleri dahil ürün başına teklif listesi
   (mağaza, satıcı, fiyat, son güncelleme, mağaza ürün URL'si veya kimliği), API veya feed, ticari
   gösterim hakkı, atıf şekli. İletişim: sitedeki iş birliği sayfası (robots'ta `/isbirligi/`).
2. **Trendyol**: doğrudan fiyat (README'deki C başvurusu); en yüksek güven (exact).
3. Cimri ve Epey için ancak iş ortaklığı sorulabilir; Epey Trendyol fiyatı vermiyor.
