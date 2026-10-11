# 0102 — Gemini destekli internet ürün araması

**Tarih:** 11 Ekim 2026
**Durum:** Kabul edildi, **bayrak arkasında, üretimde kapalı**
(`WEB_SEARCH_ENABLED`; üretimde ayrıca `WEB_SEARCH_LEGAL_APPROVED`). Açılmadan
önce hukuki onay gerekir (aşağıda "Açmadan önce").

Kullanıcı metin ya da ürün bağlantısıyla (sohbetteki görsel de `/ara` metnine
iner) aradığında yalnızca katalogdaki değil, internetteki aynı ve benzer
ürünleri de görebilir; katalogda yeterli sonuç olsa bile daha uygun fiyat
görünebilsin. Bu karar CLAUDE.md kural 1'e altıncı istisnayı, kural 3 ve 8'e
birer not ekler.

## Karar

1. **Akış** (`searchWeb`, `packages/core/src/web-search/`): bayrak → sorgu +
   metin süzgeci → tek-uçuş kilidi → günlük bütçe ayırma →
   kişi limiti → Gemini (Google Search grounding + URL Context, tek deneme,
   14 sn) → atıf adreslerini çöz → doğrula → birleştir → Search Suggestions kontrolü.
   Katalog araması bunu **beklemez**: sayfa `startWebSearch` ile ikisini paralel
   başlatır, internet bölümü kendi `<Suspense>` sınırında, katalog
   sonuçlarından sonra akar. Katalog yeterli olsa da çalışır.
2. **Model.** `gemini-3.1-flash-lite` Google Search grounding için dokümanda
   **listelenmez** (URL Context için listelenir); bu akış ayrı, incelenmiş
   `WEB_SEARCH_MODEL = gemini-3.5-flash-lite` sabitini kullanır (ikisi için de
   listelenir). Grounding araçları `v1beta` Interactions uç noktasında
   belgelidir; bu istemci orayı kullanır, yorum istemcisi `v1`de kalır.
   Yapılandırılmış çıktı (`response_format`) araçlarla birlikte kullanılmaz
   (belgede onay yok): model JSON metin üretir, biz katı doğrularız.
3. **Sorgu.** Kaynaklar aynı sorguya iner (`buildWebSearchQuery`): metin;
   görsel için **katalogdaki** en yakın ürünün başlığı/markası; link
   aramasında çözümlenmiş ürünün başlığı/markası. Kullanıcının yüklediği
   görsel ve embedding'i, yapıştırdığı adres ve parametreleri, kimlik/oturum/IP
   **gitmez**. Sorgu `queryContentIneligibility` süzgecinden geçer (kişisel
   veri, sır, özel nitelikli veri, uzunluk). Link kaynağında üçüncü taraf sayfa
   başlığı modele gider (0090'ın sohbet-tercih akışından farklı olarak); bu
   başlık sınırlı, süzgeçli ve istemde "veri" olarak çerçevelenir, model
   çıktısı hiçbir eylem tetikleyemez ve her çıktı aşağıdaki doğrulamadan
   geçer. Hukuk bu farkı ayrıca onaylamalıdır.
4. **Doğrulama** (`parse.ts`). Bir aday ancak: adres güvenli genel https
   adresiyse (kimlik bilgisi, IP, özel ağ, standart dışı port, arama/sosyal
   alanları yok; izleme parametreleri atılır); adres aramanın **gerçekten
   döndürdüğü** (atıf) ya da URL Context ile okunan sayfalar arasındaysa;
   ürün sayfasıysa (model beyanı + bariz arama/liste yolu değil) gösterilir.
   **Fiyat** yalnızca sayfa URL Context ile başarıyla okunduysa ve modelin
   sayfadan kopyaladığı kanıt metni aynı TRY tutarını içeriyorsa "doğrulanmış"
   olur; aksi halde fiyat hiç gösterilmez, kartta "Fiyat mağazada" yazar.
   Stok da yalnızca okunan sayfada bilinir. **Görsel:** internet sonuçlarında
   görsel gösterilmez (kullanım hakkı belirsiz; uydurma yok).
5. **Atıf adresleri.** Gemini atıfları çoğu zaman Google'ın sabit yönlendirme
   adresidir. Gerçek hedef için **yalnızca** `vertexaisearch.cloud.google.com`
   `/grounding-api-redirect/` adresine `redirect: manual` ile istek atılır
   (sadece `Location` okunur, 3 sn, en çok 16). Hedef sunucuya hiçbir istek
   atılmaz; scraping, erişim engeli aşma yok. SSRF yüzeyi sabit bir Google
   adresiyle sınırlıdır.
6. **Birleştirme** (`merge.ts`). Marka, model kodu, renk, beden, kapasite
   karşılaştırılır: marka/model çelişir ve model "aynı" diyorsa elenir, "benzer"
   diyorsa alternatif; varyant çelişirse "benzer seçenek"; "aynı" beyanı
   kanıtsızsa benzere iner. Aynı ürünün farklı satıcıları tek grupta (en çok 5
   satıcı, fiyat sıralı, satıcı başına tek teklif); katalog mağazasından gelen
   ve başlıkça katalog sonucuyla örtüşen teklif atılır (yinelenen kayıt ve
   affiliate kaybı olmasın), **başka satıcıdaki aynı ürün kalır**. Sıralama:
   tam eşleşme → doğrulanmış fiyatlı → satıcı sayısı → düşük fiyat; yalnızca
   en ucuzla sınırlı değil.
7. **Saklama.** Sonuçlar katalog verisi **değildir** ve önbelleğe alınmaz/saklanmaz; veritabanına
   yalnızca `api_usage` izi yazılır.
8. **Çıkış.** Doğrudan mağaza adresi (bkz. revizyon); `click`/`web_exit_click` yok. Bağlantılar
   `nofollow noopener noreferrer sponsored`, yeni sekme.
9. **Bütçe ve limit.** Ayrı günlük bütçe `web_search` (300 deneme/gün,
   Europe/Istanbul, atomik Redis ayırma/kesinleştirme); kişi başına saatte 8,
   günde 30 gerçek çağrı (girişli hesap ya da IP özeti `pseudonymize("websearch")`);
   önbellek isabeti sayılmaz; tek-uçuş kilidi aynı sorguyu bir kez öder. Redis
   okunamazsa model çağrılmaz (fail-closed). Her çağrı `api_usage`'a
   (`operation = 'web_search_grounded'`) yazılır.
10. **Maliyet.** `gemini-3.5-flash-lite` için doğrulanmış fiyat kuralı yoktur;
    çağrılar `unpriced` (0, "fiyatlanmamış") yazılır, tutar uydurulmaz. Grounding
    ayrıca arama sorgusu başına faturalanır (Gemini 3+: ayda ilk 5.000 ücretsiz,
    sonra 1.000 sorgu başına 14 USD) ve token fiyatına dahil değildir. Açmadan
    önce `LLM_PRICE_RULES` kuralı ve arama ücreti için yönetim kalemi eklenmelidir.
11. **Başarısızlık.** Kapalı bayrak, süzgeç, limit, Redis/sağlayıcı hatası,
    geçersiz çıktı: katalog sonuçları aynen kalır. Gerçek hata (sağlayıcı/Redis)
    kısa bir not gösterir; limit/süzgeç/kapalı durumlarında hiçbir şey çizilmez.
12. **Arayüz.** Mevcut `ProductCard`: isteğe bağlı `sourceLabel` ("İnternetten"),
    `priceLabel` ("Fiyat mağazada"), `external`. İlerleme metni yalnızca arama
    sürerken ("İnternette alternatifler araştırılıyor"); gerçekleşmeyen adım
    gösterilmez. Bayrak kapalıyken davranış değişmez.

## Üretime hazırlık revizyonu (resmî dokümanlarla doğrulama)

Google Gemini API "Grounding with Google Search" şartları (ai.google.dev/gemini-api/terms) ve fiyat/API
sayfaları 11 Ekim 2026'da okundu; ilk sürümden şu değişiklikler yapıldı:

- **Önbellek kaldırıldı.** Şartlar grounded sonuçların önbelleklenmesini, çerçevelenmesini, analiz edilmesini
  ve bir veritabanına dönüştürülmesini yasaklar. Redis sonuç önbelleği silindi; maliyeti kişi limiti, günlük
  bütçe ve (kişi, sorgu) tek-uçuş kilidi sınırlar.
- **Search Suggestions zorunlu.** Sonuçlar yalnızca `search_suggestions` HTML'iyle birlikte, değiştirilmeden
  (betiksiz sandbox iframe) gösterilir; öneri gelmezse sonuç gösterilmez (`service.ts`).
- **Tıklama izleme ve ara yönlendirme kaldırıldı.** Şartlar grounded bağlantılarda tıklama izlemeyi ve araya
  yönlendirme/ara sayfa konmasını yasaklar. `/git/web/<token>`, `web_exit_click` tablosu ve migration
  (0063 olarak yeniden numaralanan) **silindi**; bağlantılar doğrudan mağazaya gider. CLAUDE.md kural 8'e
  istisna eklendi. Sonuç: bu özellik **migration gerektirmez**.
- **Maliyet.** `gemini-3.5-flash-lite` fiyat kuralı eklendi (0,30 / 2,50 USD, 1M token). Grounding arama
  ücreti (14 USD / 1000 sorgu, ayda 5.000 ücretsiz, Gemini 3+ ortak) token satırından **ayrı**
  `api_usage` satırında (`web_search_grounding_queries`, units = benzersiz sorgu sayısı) liste fiyatıyla
  yazılır; ücretsiz kontenjan hesaba katılmaz (üst sınır). Kur yoksa "fiyatlanmamış".
  Dokümanda 3.5 Flash-Lite için "Search grounding: ücretsiz katmanda yok, AI Studio'da denenebilir"
  notu var; ücretli katmanda (5.000 ücretsiz, sonra 14 USD) kullanılabilir.
- **Görsel.** İnternet sayfasından görsel alınmaz (hak ve kaynak doğrulanamaz). Tam eşleşmede aynı ürün
  katalogda varsa **katalogun** kendi görseli kullanılır (renk/beden/kapasite çelişirse hayır); aksi halde
  `ProductCard` notr yedek kutuyu gösterir.
- **Kapsam.** `/ara` (metin), `/ara/link`, sohbet metin/niyet sonuçları (görsel eki niyete dönüştüğü için
  dolaylı) ve sohbet link sonuçları. `/ara/gorsel` kalıcı yönlendirme olduğundan ayrı yüzey yok.
- **Gerçek API.** Doğrulanamadı (anahtar yalnızca Production'da, gizli). Bkz. "Açmadan önce".

## Reddedilen alternatifler

- Katalog satırı yazmak (`product`/`offer`): doğrulanmamış veriyi katalog gibi
  göstermek. Reddedildi.
- `click.offer_id`'yi nullable yapmak: tüm attribution/dönüşüm sorgularını ve
  geriye uyumluluğu etkiler. Ayrı defter seçildi.
- Sunucudan mağaza sayfası çekip fiyat okumak: scraping ve SSRF yüzeyi. URL
  Context (Google tarafı) kullanıldı.
- Yapılandırılmış çıktı + araç birlikte: belgede onay yok; metin JSON + katı doğrulama.
- Görsel kaynaklarını model/`og:image` ile göstermek: hak ve doğrulama belirsiz.

## Açmadan önce

- Hukuk onayı: arama sorgusu (ürün terimleri) ve link başlığı Google'a gider;
  `/gizlilik` ve `/kvkk-aydinlatma` güncellenmeli
  (`docs/legal-review/gemini-internet-aramasi-taslak.md`). Ardından
  `WEB_SEARCH_LEGAL_APPROVED=true` ve `WEB_SEARCH_ENABLED=true`.
- Migration gerekmez.
- Canlı doğrulama: **geliştirme ortamında `GEMINI_API_KEY` olmadığından gerçek
  API ile denenmedi.** `url_context_result` / `url_citation` alan adları
  dokümana göre yazıldı ve toleranslı okunur; ilk açılışta önizlemede gerçek
  yanıtla doğrulanmalı (yönlendirme adresi çözümü, fiyat doğrulama oranı).
  Alanlar beklenenden farklıysa güvenli taraf sonuç göstermemektir, yanlış fiyat değil.
- Arama önerileri (`search_suggestions`) gösterim şartı Google kullanım
  şartlarında ayrıca incelenmeli; bu sürüm o HTML'yi göstermez.

## Bilinen sınırlar

- Fiyat doğrulama bilinçli olarak tutucudur; çoğu sonuçta "Fiyat mağazada" çıkabilir.
- Sohbet ve ana sayfa görsel ekleri bu özelliği doğrudan çağırmaz; sohbetin
  "Tüm sonuçlar" bağlantısı `/ara` metin aramasına gider ve orada çalışır.
  `/ara/gorsel` yönlendirme olduğundan `visual` kaynağı (çekirdekte hazır,
  test edilmiş) şimdilik bir sayfaya bağlı değildir.
- `/ara/link` şu an `LINK_SEARCH_PUBLIC` ile kapalı; entegrasyon hazır, link
  araması açıldığında devreye girer.

## Ek (2026-10-11): mağaza sayfasından görsel

Önceki "internet sayfasından görsel alınmaz" kararı, ürün sahibinin isteğiyle
değiştirildi. Görsel öncelik sırası: (1) aynı ürün katalogda varsa **katalogun**
görseli; (2) yoksa, doğrulanmış mağaza ürün sayfasının JSON-LD `Product.image`
veya ürün işaretli `og:image` verisi. Kurallar (`web-search/store-image.ts`,
`safe-fetch.ts`):

- Ek Gemini çağrısı yok; yalnızca zaten doğrulanmış ürün bağlantıları okunur.
- Sayfa, sunucudan **SSRF-güvenli** okunur: yalnızca https, bağlantı anında DNS
  doğrulaması (özel/loopback/link-local ret, rebinding yok), elle ≤2 yönlendirme
  (her adımda yeniden doğrulama), ≤400 KB gövde, 3 sn zaman aşımı, sıkıştırma yok,
  çerez yok, açık `ManiCepteBot` User-Agent'ı. `robots.txt` ve 401/403/429
  saygıyla karşılanır, atlatılmaz.
- Görselin ilgili ürüne ait olması: sayfadaki ürün adı kartın ürünüyle
  eşleşmeli (kelime kapsaması + model kodu + varyant uyumu); aksi halde görsel yok.
  Görselin türü (jpeg/png/webp/avif/gif) ve boyutu (≤8 MB) başlıklarla denetlenir.
- Görsel indirilmez, saklanmaz, önbelleğe alınmaz; tarayıcı doğrudan mağazadan
  yükler (`no-referrer`). Sonuç yine katalog verisi değildir.
- Görsel bulunamazsa kart kompakt (görselsiz) çizilir.
- **Hukuki not:** mağaza görsellerinin hotlink ile gösterilmesi telif/kullanım
  koşulları açısından hukuki onaya tabidir (`docs/legal-review/`).
