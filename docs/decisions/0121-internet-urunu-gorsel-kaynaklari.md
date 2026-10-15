# 0121 — İnternet ürünü görsel kaynakları ve model ailesi eşleştirmesi

**Tarih:** 11 Ekim 2026
**Durum:** Kabul edildi. 0102 (görsel çözümleme) ve 0106'yı tamamlar.

## Bulgular (gerçek ürün sayfalarıyla, `web-search:image-probe`)
"iPhone 16 Pro 128 GB Siyah Titanyum" için gerçek mağaza sayfaları, bizim istemciyle:
- Teknosa, Hepsiburada, PttAVM: **HTTP 403** (bot engeli). Atlatılmaz; bu mağazalardan görsel alınamaz.
- Amazon.com.tr: 200 ama bot/doğrulama sayfası (genel "Amazon" başlığı ve logosu); ad eşleşmesi doğru olarak reddeder.
- Vatan Bilgisayar, MediaMarkt: 200; JSON-LD/`og:image` var, görsel yüklenir, ad eşleşir.
- Apple Türkiye: eski yapılandırma adresi kategori sayfasına yönleniyor (ürün sayfası değil).
Yani görselsiz kalmanın baskın nedeni mağaza bot engelidir; ürün sayfasına bağımlı kalmak tek başına yetmez.

Eşleştirme açığı: sözcük örtüşmesi "iPhone 16 Pro" ile "iPhone 15 Pro" ve "iPhone 16 Pro Max"
sayfalarını **aynı ürün** sayıyordu (yanlış ürün görseli riski).

## Karar
1. **Görsel kaynakları, sırayla:**
   A. Katalogdaki AYNI ürünün kendi feed'imizden gelen `primary_image_url`'i (sonuç sayfasındaki
      ürünler + `findCatalogImageCandidates` ile doğrudan katalog araması, `pg_trgm`, salt okunur).
   B. İzinli veri beslemesi / ürün görsel API'si: şu an entegre değil (aşağıya bak).
   C. Erişimine izin verilen mağaza ürün sayfası (JSON-LD `Product.image`, `og:image`); robots.txt ve
      401/403/429 saygıyla karşılanır, engel aşılmaz. Bir grup için en çok 4 teklif denenir;
      erişimi kapatan mağazaya aynı aramada bir daha gidilmez.
2. **Model ailesi kimliği** (`sameProductLine`): nesil sayısı ("16") ve sınıf sözcükleri
   (Pro, Max, Plus, Ultra, Mini, SE, FE...) kümeleri eşit olmalı; kapasite/RAM sayıları ayrı
   (varyant) değerlendirilir. Mağaza sayfası adı eşleşmesinde, katalog görselinde, satıcı gruplamasında
   ve katalog yinelenen tekliflerinde uygulanır.
3. **Katalog görselinde sıkı varyant:** renk/kapasite/beden iki tarafta da aynı ya da ikisi de boş.
   Renksiz ilana belirli renk fotoğrafı verilmez. Katalog görseli yoksa görselsiz kompakt kart kalır.
4. Görsel indirilmez, kopyalanmaz, saklanmaz; tarayıcı doğrudan kaynaktan yükler (0102).
5. UI: internet kartı + mağaza listesi tek sütunda akar (kart `height: 100%` yüzünden liste sonraki
   satırın/bilgilendirme metninin üstüne biniyordu); görselsiz kompakt kart satır boyuna uzamaz.

## Teknik/hukuki olarak elde edilemeyenler ve gereken
Bot engeli koyan büyük mağazaların (Hepsiburada, Teknosa, PttAVM...) görselleri bu yolla alınamaz ve
alınmamalıdır. Bunlar için **izinli kaynak** gerekir: affiliate ağı ürün beslemeleri (görsel
URL'si lisanslı), mağaza/marka ürün API'leri, GTIN/MPN ile lisanslı bir ürün görsel veritabanı
(ör. açık lisanslı katalog hizmetleri) ya da fiyat karşılaştırma ortaklarının partner API'leri.
Bu bir iş/hukuk kararıdır; kod tarafı kaynak eklenince `attachCatalogImages` aday listesine
bağlanabilir. Hotlink hukuki onaya tabidir (`docs/legal-review/`).
