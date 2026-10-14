# Yeni erişim yöntemleri, ücretsiz Gemini URL Context ölçümü ve katalog tasarımı (2026-10-15)

Önceki 13 belge okundu. Çalışma ağacı temizdi ve `origin` ile eşitti; commit edilmemiş iş yoktu.
Yerel önbellekler (`<tmp>/manicepte-trendyol-*`, ~2 GB) korunuyor.

## 1. Bu turda denenen yöntemler

| # | Hipotez | Gerçek test | Sonuç | Sınıf |
|---|---|---|---|---|
| H14 | `sitemap_products_reviews*.xml` (önceki belgelerde yoktu) | 20 dosya, 6 sn aralık, dürüst UA, 403/429 yok. Her `<url>` = `…-p-<id>/yorumlar` + görseller. Dosyaların hepsi `</urlset>` ile kapanıyor | **505.640** benzersiz yorumlu ürün. Bunların **498.596**'sı (%98,6) 12 Ekim üretimindeki 8.129.695'lik dizinde. Ürünlerin ~%6,2'si. **Fiyat yok** | Talep sinyali (fiyat değil) |
| H15 | Yurt dışı vitrin sitemap'leri | `sitemap_index.xml` (lastmod 2026-10-14T16:39:01Z) 2.507 dosya listeliyor. TR dışındakiler: `ro` 526, `el` 429, `bg` 396, `en` 386, `rs` 201, `de` 29, `uk`, `sk`, `cs`, `pl`, `hu`. Örnek dosyalarda yapı TR ile aynı. `hreflang` ile `trendyol.ae` ve `trendyol.sa` karşılıkları var | Fiyat yok. Yurt dışı fiyatı Türkiye fiyatı değil | D |
| H16 | Trendyol geliştirici belgelerinde yeni bir servis (`llms.txt`, 262 satır, yeniden tarandı) | Webhook yalnız sipariş paketleri için. İhracat Merkezi, `getProductBase`, Stok-Fiyat ve Buybox servislerinin hepsi "mağazanızdaki ürünler" ile sınırlı | Başka satıcının fiyatını veren servis yok (04 §1 doğrulandı) | — |
| H17 | Brave Search API (kendi dizini, şema zengin sonuçlar) | Yalnız ikincil kaynaklar okundu. Şubat 2026'dan beri kullandıkça öde; aylık ~5 USD kredi ve kart gerekiyor | **Test edilmedi:** ücretli hesap gerektiriyor, onay yok | ? (onay gerekir) |
| H18 | Lisanslı veri sağlayıcıları (NielsenIQ, GfK, DataForSEO, Bright Data, Prisync…) | Arama yapıldı. Trendyol için bulunan tek şey Apify'daki kazıyıcılar ("Cloudflare'ı gerçek tarayıcıyla geçer") | Lisanslı Trendyol fiyat verisi sunan sağlayıcı **bulunamadı** | D |
| H19 | Trendyol Influencer programı (creator platformu) | influencer.trendyol.com: en az 30.000 Instagram ya da 10.000 TikTok takipçisi şartı; bağlantı uygulamada üretiliyor | Yalnız affiliate bağlantısı, veri yok | C (iş anlaşması) |
| H9 | Gemini URL Context, **ücretsiz katman** | §2: düzenek hazır, anahtarsız koşuda 0 istek | Ölçüm için ücretsiz anahtar gerekiyor | Ölçülecek |

## 2. Gemini URL Context: maliyetsiz doğrulama

### 2.1 Ücretsiz katman

Kaynak: ai.google.dev fiyat sayfası, son güncelleme 2026-10-14.

| Model | Ücretsiz katman | Google Search grounding (ücretsiz) | URL Context |
|---|---|---|---|
| `gemini-2.5-flash` | Var | **Günde 500 istek** (Flash-Lite ile ortak) | Ayrı ücret yok; girdi token'ı sayılır (ücretsiz katmanda ücretsiz) |
| `gemini-2.5-flash-lite` | Var | Aynı ortak kota | Aynı |
| `gemini-3-flash-preview` | Var | **Yok** | Aynı |

Faturalandırması **açılmamış** bir AI Studio projesinin anahtarı ücretli istek üretemez: kota dolunca 429 döner. Ücretsiz katmanın kendi koşulları da var:

- Google girdi ve çıktıları ürün geliştirmede kullanabilir; insanlar inceleyebilir.
- "Hassas, gizli ya da kişisel bilgi göndermeyin."
- AEA'daki kullanıcılara yalnız ücretli katmanla hizmet verilebilir.

Bu ölçümde yalnız herkese açık Trendyol ürün URL'leri gönderilir; kişisel veri yoktur.

Doğrudan uyan URL'ler:
- Ücretsiz katman, gerektirdiği hesap türü ve faturalandırmanın etkisi: ai.google.dev, "Billing", "Rate limits" ve "Pricing" sayfaları.
- Ücretsiz katman, Grounding ve Search Suggestions şartları: ai.google.dev/gemini-api/terms ("Unpaid Services" ve "Grounding with Google Search" bölümleri).

### 2.2 Şartlar ve ihlal riski

- **Search grounding sonuçları (Grounded Results):** Google şartlarına göre önbelleğe alınamaz, analiz edilemez, sendikasyonu yapılamaz. Yalnız Search Suggestions ile ve değiştirilmeden gösterilir. "Link"ler tarama ya da kazıma hedefi bulmak için kullanılamaz. Bu yüzden `search` kipinde betik yalnız **sayıları** yazar, sonucun kendisini saklamaz.
- **URL Context tek başına:** Şartlarda ayrı bir saklama kuralı yok. Belgeye göre araç önce Google'ın kendi dizin önbelleğine bakıyor, sayfa orada yoksa canlı okuyor. Trendyol robots.txt Googlebot'a ürün sayfalarını açıyor ve `Google-Extended`'i engellemiyor (Amazon TR'nin tersine).
- **Gri alan (dürüst değerlendirme):** Bizim sunucumuz bu sayfalarda Cloudflare'den 403 alıyor. Google üzerinden okumak, Trendyol'un bize kapalı tuttuğu içeriği başka bir istemciyle almak demek. Bu yüzden ayrım şöyle:
  - **Kabul edilebilir:** 20 istekle sınırlı, tek seferlik doğruluk ölçümü. Bu, 0102'de zaten kararlaştırılmış hattın doğrulamasıdır.
  - **Kabul edilemez:**
    - 8,1 milyon URL'yi URL Context ile okuyup kataloğa fiyat yazmak. Bu, Google'ı kazıyıcı olarak kullanmaktır; Trendyol kullanım koşullarını da aşar.
    - Sonucu `price_point`'a yazmak. Bu kural 3 ve 0102 istisnasıyla çelişir.
  - Üretimde kullanım, 0102'deki gibi yalnız sorgu anında, saklamadan ve `WEB_SEARCH_LEGAL_APPROVED` ile olur.

### 2.3 Düzenek (kod: `trendyol-landing/gemini-url-context.ts`, betik: `scripts/trendyol-gemini-probe.ts`)

- **Kapı:** `TRENDYOL_GEMINI_FREE_TIER=1` ve `GEMINI_FREE_TIER_API_KEY` gerekir.
  - Betik ana depo ve worktree'deki `.env.vercel`, `.env`, `.env.local` ve `apps/web/.env*` dosyalarından `GEMINI_API_KEY` değerlerini okur.
  - Anahtar bunlardan biriyle aynıysa çalışmaz. Karşılaştırma yalnız sha256 özetleriyle yapılır.
  - Anahtarsız koşuda 1 production anahtarı bulundu, karşılaştırmaya alındı ve **istek gönderilmedi**.
- **Ön kontrol:** `GET models/gemini-2.5-flash` ile anahtar doğrulanır; bu istek token harcamaz.
- **Çağrı:** `generateContent`, `temperature 0`, düşünme bütçesi 0.
  - `url` kipinde yalnız `url_context` aracı kullanılır.
  - `search` kipinde `google_search` ve `url_context` birlikte kullanılır.
  - İstekler arası 13 sn, tek deneme. İlk 429'da durur. Varsayılan en fazla 20, tavan 40 istek.
- **Ayrıştırma:** `urlContextMetadata.urlMetadata[].urlRetrievalStatus`, `groundingMetadata.groundingChunks`, `usageMetadata` (`toolUsePromptTokenCount` dahil) ve modelin JSON'u (`pages[].price.evidence`) okunur.
- **Doğruluk:** "Kanıt tutarı içeriyor" yalnız modelin kendi tutarlılığıdır; doğruluk ölçmez. Bu, `web-search/parse.ts`'deki "verified" tanımı için de geçerli bir sınırlamadır.
  - Doğruluk yalnız `compareWithTruth` ile ölçülür. Model fiyatı, aynı ürünün **gerçek tarayıcıda, normal ziyaretle, ±20 dk içinde** kaydedilmiş `page.*` katmanlarıyla karşılaştırılır.
  - Hangi katmana eşit olduğu kaydedilir: `discounted`, `selling`, `original` ya da `basket`.
- **Testler:** 11 sentetik birim testi. Yanıt biçimi belgeden alındı; ilk gerçek yanıtta `shape` ile kontrol edilecek.
- **Ölçüm seti:** `data/gemini-probe-set.json`, 20 ürün.
  - 10 referans ürün (03 §2.2, 07 §4): iPhone ×2, Samba ×2, AF1 ×2, elbise ×2, Sony ×2.
  - Yorumlu sitemap'ten 10 popüler ürün: iPhone 17, Galaxy Watch6, JBL 520BT, Philips airfryer, Tefal tava, LEGO 40460, Stanley, NB 327, Koton bluz, Puma.

### 2.4 Ölçüm protokolü (anahtar gelince)

1. Gerçek Chrome'da normal ziyaretle 20 ürün sayfasının fiyat nesnesi `truth.json` olarak kaydedilir: `selling`, `discounted`, `original`, sepet fiyatı, satıcı, stok ve zaman. Bu yaklaşık 10 dk sürer.
2. `--run --mode url` çalıştırılır: 20 istek, yaklaşık 5 dk.
3. `--compare <probe.json> --truth truth.json --set …` çalıştırılır. Çıktılar:
   - okunan sayfa oranı, fiyat dönen oran;
   - görünen fiyatla birebir eşleşme oranı;
   - eşleşilen katman dağılımı;
   - satıcı eşleşmesi, gecikme ve token.
4. İsteğe bağlı: `--mode search`, 20 istek. Trendyol URL'si dönen sorgu oranı ve doğru içeriğin (`contentId`) bulunma oranı ölçülür.
5. Toplam en fazla 40 istek; günlük 500'lük ücretsiz grounding kotasının %8'i.
6. Model çıktısı geçici klasördedir; karşılaştırmadan sonra silinir. Belgeye yalnız oranlar yazılır.

Başarı ölçütü: 20 ürünün en az 18'inde sayfa okunmalı ve görünen fiyat birebir eşleşmeli. Altında kalan sonuç, H9'un 0102 hattında güvenilir bir fiyat kaynağı olmadığını gösterir.

## 3. Doğruluk, güncellik ve izin değerlendirmesi (tüm kaynaklar, bugünkü kanıtla)

| Kaynak | Doğruluk (kanıt) | Güncellik | Kullanım izni | Kataloğa yazılabilir mi |
|---|---|---|---|---|
| Ürün sitemap'i (8,13 M) | Kimlik ve görsel doğru. 20 liste sayfasında %99,86 kapsam | 8 saatte bir üretim. 16 saatte %2,53 değişim | robots serbest. Kullanım koşulları "izinsiz kopyalanamaz, yeniden yayımlanamaz" diyor | Hukuki görüşe kadar yalnız iç keşif dizini olarak |
| Yorumlu ürün sitemap'i (505 bin) | Kimlik doğru | Aynı üretim | Aynı | Öncelik sinyali olarak (iç kullanım) |
| Satıcı Partner API'si (V2, Stok-Fiyat, Buybox) | **Ölçülmedi** (anahtar yok). Alan anlamları hipotez (05 T2) | Sorgu anı; `sellerModifiedDate` | Satıcının yazılı onayı gerekli. Trendyol'un gösterim şartı belirsiz | **Evet**: `merchant_api` olarak, onaydan sonra |
| Gemini URL Context | **Ölçülecek** (§2.4) | Dizin önbelleği; bayat olabilir (belge uyarıyor) | Google şartları ve Trendyol kullanım koşulları; gri alan (§2.2) | **Hayır**: yalnız sorgu anında gösterim (0102) |
| Akakçe | Doğru (iPhone 124.999 çapraz doğrulandı). Kapsam eksik | Teklif başına "x dk önce" | Veritabanı kopyalama yasak; anlaşma şart | Anlaşmayla |
| Gerçek tarayıcı gözlemi | Yer gerçeği | Anlık | Yalnız araştırma ve doğrulama | Hayır |

## 4. Katalog tasarımı (0111/0113 modeliyle uyum)

Şema bu belgede **değişmez**. Migration yalnız `packages/db`'de, onaylanmış bir kararla yazılır. Aşağıdakiler eşleme ve öneridir.

| Trendyol kavramı | Tablo | Anahtar / kural |
|---|---|---|
| Trendyol (pazaryeri) | `merchant` (tek satır) | — |
| Satıcı (`merchantId`) | `seller` | `(merchant_id, external_id = merchantId)`; ad kimlik değildir |
| Satıcının o content'teki teklifi | `offer` | `external_id = "<contentId>:<merchantId>"`; `seller_id` dolu. Fiyat satıcıya göre değiştiği için offer satıcı başınadır; aynı contentId'nin satıcıları aynı `product`'a bağlanır |
| Beden/barkod | `offer_variant` | `(offer_id, external_id = barcode ya da variantId)`. `gtin` yalnız GS1 kontrolünden geçen barkod. `TYB…` kodları `identity_observation.is_valid=false` |
| Renk grubu (`groupId`) | `product` (renk düzeyi kanonik, 0005) | groupId ürün değil, gruplamadır; `attributes_raw.trendyolGroupId` |
| Barkod / model kodu | `product_identity`, `identity_observation` | GTIN → `canonical_variant`; marka+MPN → `product`. Barkod birden çok contentId'de görülebildiği için (04 §2.3) çelişki `hold` olur |
| Fiyat (satıcı API'si) | `offer.current_price` + `price_point` (INSERT) | `price` = `salePrice`, `list_price` = `listPrice`. `priceSeenByCustomer` H1 doğrulanmadan `price` olmaz |
| Kampanya, sepet, kupon | `price_verification.discount_conditions` / `coupon_conditions` | Katman ayrı saklanır; matematikten kampanya çıkarılmaz |
| Buybox kazanan fiyatı (satıcı anonim) | Mevcut tabloya **uymaz** | Başka satıcının fiyatı bu offer'ın fiyatı değildir. Öneri: ayrı append-only `marketplace_buybox_observation (offer_variant_id, buybox_price, buybox_order, has_multiple_seller, observed_at, provider)` |
| Sitemap keşif kaydı (fiyatsız) | `offer`'a **yazılmaz** | `offer.in_stock NOT NULL DEFAULT TRUE`, fiyatsız kaydı stokta gösterir. Aday dizin ayrı tutulmalı. Öneri: `listing_candidate (merchant_id, external_id, url, title_slug, image_url, first_seen_gen, last_seen_gen, has_reviews)`; arama yalnız bağlantı amaçlı ve hukuki görüş sonrası |
| Besleme / üretim | `feed_source` (network `trendyol_sitemap`, durum `discovered`, **active değil**), `source_snapshot` = sitemap üretimi (`lastmod`), `ingest_chunk` = dosya | Deaktivasyon `missing_from_snapshot` yalnız **iki ardışık** üretimde yoksa. Çöl Titanyum örneği: iki üretimde yoktu, üçüncüde vardı |
| Doğrulama | `price_verification` (`provider='trendyol_seller_api'`, `source_kind='merchant_api'`) | Gemini sonucu buraya **yazılmaz** (Google şartları). `source_kind` CHECK'i de bunu kabul etmiyor; bu doğru |
| Öncelik | `price_verification_request.priority` | Yorumlu ürün (H14) → yüksek öncelik; tıklanan/görüntülenen → `viewed` |
| Görsel | `offer.image_url` (adres) | Görsel dosyası saklanmaz; satıcı/Trendyol hakları |

Bu tasarımla sınırlar:
- Yalnız yetkili satıcıların teklifleri fiyatlı olur.
- Kapsam satıcı sayısıyla büyür; 3 satıcı ürünlerin %0,5'inden azını kapsar (06 §3).
- Diğer ürünler fiyatsızdır. "Fiyatı mağazada gör" nihai çözüm değildir; bu boşluğu yalnız Trendyol anlaşması kapatır.

## 5. Kullanıcıdan gerekenler

1. **Gemini ücretsiz anahtarı (H9):**
   - aistudio.google.com → "Get API key" → **yeni proje** oluşturun.
   - Faturalandırma **eklemeyin**; anahtarın proje satırında "Free tier" yazdığını kontrol edin.
   - Production projesinin anahtarını kullanmayın.
   - Worktree kökündeki `.env.trendyol-research` dosyasına yazın (git-ignore'lu, doğrulandı):
     ```
     TRENDYOL_GEMINI_FREE_TIER=1
     GEMINI_FREE_TIER_API_KEY=...
     ```
2. **Brave Search API (H17):** Kart ve kullandıkça öde gerektiriyor. Ancak açık onayla test edilir.
3. **Değişmeyen başvurular:**
   - Trendyol (ManiCepteBot erişimi, gösterim izni, ajans rolü);
   - pilot satıcı (yazılı onay ve anahtar; 05 protokolü);
   - Akakçe veri ortaklığı.

## 6. Sonraki adımlar

1. Anahtar gelince §2.4'ü uygulayın ve oranları bu belgeye yazın.
2. Yorumlu ürün setini katalog önceliği olarak kullanın: hangi markalar ve satıcılar yoğun? Satıcı pilotu için aday seçimi (08 §4).
3. Sonraki sitemap üretiminde (`trendyol-sitemap-snapshot.ts`) iki ardışık üretim kuralını ölçün: geçici kaybolma oranı nedir?
