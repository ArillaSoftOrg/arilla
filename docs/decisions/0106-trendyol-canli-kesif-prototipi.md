# 0106 — Trendyol canlı ürün keşfi prototipi (Faz 1)

Durum: **prototip, üretime bağlı değil.** İstek yoluna, Gemini/Jina/sohbet/arama
akışlarına, veritabanına ve Redis'e dokunmaz. Hiçbir şey saklanmaz.

## Karar

`packages/core/src/live-discovery/` altında, model kullanmayan, kendi kodumuzla
çalışan bir keşif prototipi var. Terminal aracı:

```
pnpm --filter @arilla/core live-discovery "iPhone 16 Pro 128 GB"
```

Akış: robots.txt → sitemap kategorisi → kategori sayfasındaki JSON-LD `ItemList`
→ (eşleşme yoksa) ürün sayfalarındaki `isRelatedTo` bağlantıları → eşleşen ürünün
sayfasında JSON-LD `Product/ProductGroup` ile doğrulama. Open Graph yedektir.

Kurallar kodda zorunlu (testli): her istekten önce robots.txt; arama yolu
(`/sr?q=`) asla istenmez; dürüst `User-Agent`; en az 2,5 sn aralık; en çok 14
istek; 403/429 ya da bot-doğrulama sayfasında **tüm tarama durur**, yeniden
denenmez, aşılmaya çalışılmaz; CAPTCHA/proxy/stealth yok; doğrulanamayan fiyat
(para birimi yok, sayı değil) ve görsel üretilmez, `missing` alanında belirtilir;
sorgu eşleştirmesi "16 Pro"ya "16 Pro Max", farklı depolama ve yenilenmiş ürün
döndürmez.

## Bulgular (2026-10-12 incelemesi)

### robots.txt (`User-agent: *`)
- `Disallow: /sr?`, `/sr/`, `/sr$`, `/*?q=`: **arama sayfası tüm botlara yasak.**
  "Sorguyu Trendyol'a sor, sonucu oku" biçimi izinli değil; bu yüzden kullanılmadı.
- Kategori (`*-x-c<id>`), marka (`*-x-b<id>`) ve ürün (`*-p-<id>`) sayfaları ve
  `sitemap_categories.xml` / `sitemap_brands.xml` / `sitemap_products*.xml`
  yasak değil. `/fiyat-gecmisi`, `/sepetim`, `/giris`, `?siralama=`, `?filtreler=`
  vb. yasak. Crawl-delay tanımlı değil.

### Veri
- Ürün sayfası: `ProductGroup/Product` JSON-LD → ad, görsel (`cdn.dsmcdn.com`),
  `offers.price`, `priceCurrency=TRY`, `availability`, `itemCondition`, nitelikler,
  `isRelatedTo`. Satıcı adı JSON-LD'de yok; `merchant` alanı "Trendyol" (pazaryeri).
- Kategori sayfası: JSON-LD `ItemList` (ad, görsel, fiyat) ama **yalnızca ilk 36
  ürün**; `?pi=2` aynı sayfayı döndürüyor (ikinci sayfa JS ile yükleniyor, çağırmadık).
  iPhone kategorisinde 189 ürün var; ilk 36'da "iPhone 16 Pro 128 GB" **yoktu**.
- Sitemap'te model düzeyinde kategori yok; ürün sitemap'leri yüzlerce dosya, tek
  sorgu için indirilemez.

### Kullanım koşulları (`/kullanim_kosullari`)
Site materyalinin (teknik veriler, kod, yazılım dahil) "önceden izin alınmadan ve
kaynak gösterilmeden **kopyalanamayacağı, çoğaltılamayacağı, yeniden
yayımlanamayacağı, dağıtılamayacağı**" ve sitenin bir kısmının başka sitede izinsiz
kullanılamayacağı yazıyor. Bu, ürün verisini saklayan/yeniden sunan bir üretim
akışı için **yazılı izin gerektirir**.

### Canlı çalıştırma sonucu
- Elle (curl, ~25 istek, 2-3 sn arayla) robots.txt, iki sitemap, bir kategori
  sayfası, iki `?pi=` denemesi ve iki ürün sayfası **200** döndü; JSON-LD
  fiyat/görsel/stok gerçekten okunabildi (ör. "Apple iPhone 16 Pro Max 256GB Çöl
  Titanyum", 149999.00 TRY, InStock).
- Ardından yazılan otomatik araç (Node `fetch`) ilk kategori isteğinde **HTTP 403**
  aldı. Talimat gereği tarama durduruldu; başlık/istemci taklidi, yeniden deneme
  ve başka bir aşma yapılmadı. Sebep (IP/ritim, TLS parmak izi ya da bot koruması)
  doğrulanmadı.
- Sonuç: **test sorgusu için canlı, otomatik ürün keşfi doğrulanamadı; araç 0
  ürün buldu.** Başarı iddia edilmiyor.

## Gerekçe

Arama yasak olduğu için izinli yüzeyle (sitemap + kategori + ürün sayfası) keşif
denendi. Bu yüzey tek başına sorgu odaklı değil: kategori ilk sayfası ve ilişkili
ürün grafiği rastgele alt küme verir. Dolayısıyla "iPhone 16 Pro 128 GB" gibi
belirli bir model için güvenilir bulma garantisi yok.

## Üretime uygun hâle getirmek için gerekenler

1. **Hukuki:** Trendyol'dan yazılı izin ya da resmî yol: affiliate ağı ürün
   feed'i / Trendyol iş ortaklığı API'si. CLAUDE.md zaten "scraping birincil kaynak
   olamaz, feed/API/affiliate" diyor; bu prototip bu kuralın yerine geçmez.
2. **Erişim:** 403'ün nedeni belirlenmeli; izin/feed yoksa canlı tarama kapanmalı.
3. **Veri yaşam döngüsü:** Sonuçlar katalog verisi olarak saklanacaksa mevcut
   `offer`/`price_point` hattından (değiştirilemez, ingest idempotent) geçmeli;
   saklanmayacaksa karar 0102'deki internet sonucu kuralları (etiket, `click`
   istisnası, "gelir ortaklığı kapsamında değil") ayrıca uyarlanmalı.
4. **Mimari:** Tarama Python/ingest tarafında kuyruktan çalışmalı; istek yolunda
   canlı HTTP taraması olmaz (değişmez kural 1-2).
5. **Kapsam:** Model düzeyinde keşif için feed ya da ürün sitemap'inin çevrimdışı
   indekslenmesi (izinle) gerekir; kategori ilk sayfası yetmez.
6. Satıcı adı ve gönderim bilgisi için ürün sayfası dışı kaynak gerekebilir.

## Reddedilen alternatifler

- `/sr?q=` arama sayfasını okumak: robots.txt yasağı.
- Header/TLS taklidi, proxy, headless tarayıcı ile 403'ü aşmak: erişim kısıtını
  aşma; kapsam dışı.
- Gemini/Serper/Perplexity grounding: görev açıkça dışladı.
