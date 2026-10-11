# 0101 — Gemini destekli internet ürün araması

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
   metin süzgeci → Redis önbelleği → tek-uçuş kilidi → günlük bütçe ayırma →
   kişi limiti → Gemini (Google Search grounding + URL Context, tek deneme,
   14 sn) → atıf adreslerini çöz → doğrula → birleştir → önbelleğe yaz.
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
7. **Saklama.** Sonuçlar katalog verisi **değildir**: veritabanına yazılmaz,
   `product`/`offer`/`price_point` oluşmaz. Yalnızca Redis önbelleği (6 saat;
   sonuçsuz 30 dk) ve `api_usage`. (Kural 3'e istisna: bu çıktı ürün başına
   değil sorgu başına, kısa ömürlüdür.)
8. **Çıkış** (kural 8). Katalogda `offer` olmadığı için `click` kullanılamaz
   (`offer_id NOT NULL`); `/git/web/<token>` imzalı token (HMAC, `SESSION_SECRET`,
   12 saat) → `web_exit_click` (migration 0062, append-only) → 302. Serbest
   `?url=` yok; token yeniden doğrulanır (kanonik, güvenli). Affiliate değildir,
   `click`/`conversion` akışı değişmez; kart bunu açıkça söyler. Bağlantılar
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
- Migration 0062 üretimde uygulanmış olmalı (kullanıcı uygular).
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
