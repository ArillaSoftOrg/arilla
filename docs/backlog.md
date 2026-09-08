# Görev listesi

Her görev bir Claude Code oturumu büyüklüğündedir. Sırayla gidilir; bir görev
kabul kriterlerini karşılamadan sonrakine geçilmez.

Her görev için: hangi belgeler okunacak, ne yapılacak, ne zaman bitmiş sayılır.

---

## Blok A — Temel (kod yazmadan önce)

### A1. Monorepo iskeleti
**Oku:** `CLAUDE.md`
**Yap:** pnpm workspace, `apps/web`, `packages/core`, `packages/db`,
`packages/ui`, `services/ingest`. TypeScript yapılandırması, lint, format.
`infra/docker-compose.yml` çalışır durumda.
**Bitti:** `docker compose up -d` dört servisi ayağa kaldırıyor, `pnpm build`
hatasız geçiyor.

### A2. Şema ve migration'lar
**Oku:** `docs/schema.sql`, `packages/db/migrations/README.md`
**Yap:** `schema.sql` dokuz migration dosyasına bölünür. Drizzle şeması ve tip
üretimi kurulur. `price_point` partition'ları için aylık üretim betiği yazılır.
**Bitti:** Boş veritabanına migration'lar sırayla uygulanıyor, Drizzle tipleri
üretiliyor, önümüzdeki 3 ayın partition'ları mevcut.

### A3. Tohum verisi
**Oku:** `docs/schema.sql`, `docs/glossary.md`
**Yap:** Geliştirme için sahte katalog: 3 merchant, 200 ürün, 400 offer,
beden varyantları, 60 günlük fiyat geçmişi, birkaç `similarity_edge`.
**Bitti:** `pnpm seed` çalışıyor, arayüz geliştirmesi gerçek feed beklemeden
başlayabiliyor.

---

## Blok B — Toplama hattı (Python)

### B1. Feed connector iskeleti
**Oku:** `docs/architecture.md` (Katman 1), `docs/schema.sql`
**Yap:** Connector arayüzü, XML feed okuyucu, normalizasyon, `offer` upsert,
`price_point` INSERT, `ingest_run` kaydı. Idempotent.
**Bitti:** Örnek bir XML feed dosyasından 100 offer yazılıyor, ikinci kez
çalıştırıldığında yeni satır oluşmuyor ama `price_point` bir satır daha alıyor.

### B2. Kullanıcı linki çözümleme
**Oku:** `docs/architecture.md` (Katman 2), `docs/decisions/0004`
**Yap:** URL parse, merchant tanıma, `robots.txt` kontrolü, schema.org JSON-LD
okuma, HTML ayrıştırma yedeği. Sonuç `discovery_source = 'user_link'` ile yazılır.
**Bitti:** Bir merchant ürün URL'si verildiğinde katalogda yeni bir `offer`
oluşuyor ve fiyat rotasyonuna giriyor.

### B3. Embedding üretimi
**Oku:** `docs/architecture.md`, `docs/decisions/0003`
**Yap:** Görsel indirme, hash, embedding üretimi, `embedding` tablosuna yazma.
`model_version` her satırda. Tekrar eden görseller hash ile atlanır.
**Bitti:** 200 tohum ürünün embedding'i üretilmiş, aynı görsel iki kez
işlenmiyor.

### B4. Eşleştirme
**Oku:** `docs/architecture.md` (Katman 3), `docs/schema.sql`
**Yap:** Katmanlı eşleştirme (gtin → metin → görsel → öznitelik),
`match_candidate` yazımı, eşik üstü otomatik kabul.
**Bitti:** Farklı merchant'lardaki aynı ürün birleşiyor. **Regresyon test seti
zorunlu:** bilinen 30 eşleşme ve 30 eşleşmeme örneği.

### B5. Benzerlik ve fiyat istatistikleri
**Oku:** `docs/architecture.md`, `docs/search.md`
**Yap:** Gecelik `similarity_edge` üretimi (visual, semantic), gecelik
`product_price_stats` hesabı (min/medyan/yüzdelik/sahte indirim sinyali).
**Bitti:** Her ürün için en az 5 alternatif kenarı var, fiyat istatistikleri
dolu.

---

## Blok C — Çekirdek (TypeScript)

### C1. Sorgu ayrıştırıcı
**Oku:** `docs/search.md`
**Yap:** Sorgu nesnesi tipi, `lexicon` tabanlı ayrıştırıcı (kademe 2),
`query_resolution` cache'i, netleştirme mantığı. Model çağrısı **yok** —
kademe 3 sonraki görevde.
**Bitti:** "3000 tl altı siyah spor ayakkabı 42 numara" doğru sorgu nesnesine
çevriliyor. Birim testli.

### C2. Arama ve alternatif
**Oku:** `docs/search.md`, `docs/schema.sql`
**Yap:** `search()`, `findAlternatives()`, `compareMerchants()` fonksiyonları.
Üç sıralama sekmesi. **İstek yolunda model çağrısı yok.**
**Bitti:** Tohum veriyle üç sekme farklı sıralama döndürüyor.

### C3. Attribution
**Oku:** `docs/schema.sql`, `docs/events.md`
**Yap:** `click` kaydı, deeplink üretimi, 302 yönlendirme. `api_usage` yazımı.
**Bitti:** Her çıkış `click` satırı üretiyor, `click_id` deeplink'te taşınıyor.

---

## Blok D — Web (MVP-0)

### D1. Tasarım sistemi
**Oku:** `docs/design.md`, `docs/brand.md`, `docs/decisions/0007`, `0009`
**Yap:** Renk belirteçleri (iki tema), IBM Plex Sans depodan servis, tipografi
ölçeği, temel bileşenler (buton, girdi, kart, rozet, boş durum).
**Bitti:** Tema sistem tercihini takip ediyor, elle geçiş çalışıyor, font
Türkçe ve tabular testinden geçiyor.

### D2. Ana sayfa ve arama
**Oku:** `docs/pages.md`, `docs/copy.md`, `docs/search.md`
**Yap:** `/`, `/ara`, netleştirme çubuğu, üç sekme, iskelet yükleme, boş sonuç.
**Bitti:** Metin araması uçtan uca çalışıyor, tüm metinler `copy.md`'den.

### D3. Ürün sayfası
**Oku:** `docs/pages.md`, `docs/copy.md`
**Yap:** `pages.md` içindeki 12 bölüm, sırasıyla. Mağaza listesi kargo dahil
toplama göre sıralı.
**Bitti:** Fiyat farkı, fiyat konumu cümlesi, alternatifler ve fiyat grafiği
görünüyor.

### D4. Görsel arama ve link öneki
**Oku:** `docs/routes.md`, `docs/kvkk.md`
**Yap:** Fotoğraf yükleme, hash cache, kullanıcı başına günlük limit, kök
catch-all link çözümleme, bilinmeyen ürün bekleme ekranı.
**Bitti:** Fotoğraf yüklenince sonuç geliyor, ham dosya kalıcı saklanmıyor,
limit çalışıyor.

### D5. Yönetim ekranları
**Oku:** `docs/pages.md`, `docs/routes.md`
**Yap:** `/yonetim/eslestirme` (klavye kısayollu), `/yonetim/sozluk`.
**Bitti:** Kuyruk onaylanabiliyor, sözlüğe eklenen satır aramayı anında
etkiliyor.

### D6. SEO temeli
**Oku:** `docs/sitemap.md`
**Yap:** Meta etiketler, schema.org yapılandırılmış veri, `robots.txt`,
sitemap üretimi, ince sayfalara `noindex`.
**Bitti:** Ürün sayfası zengin sonuç testinden geçiyor, sitemap üretiliyor,
eşiği geçmeyen ürünler haritada yok.

---

## Blok E — Hesap (MVP-1)

### E1. E-posta ile giriş
**Oku:** `docs/decisions/0006`, `docs/copy.md`, `docs/kvkk.md`
**Yap:** Token üretimi (hash'li, tek kullanımlık, 15 dk), oran sınırı, oturum
çerezi, `/giris` akışı. Yerelde Mailpit.
**Bitti:** Giriş uçtan uca çalışıyor, token log'a düşmüyor, hesabın varlığı
mesajlardan anlaşılmıyor.

### E2. Kaydetme, alarm, geçmiş
**Oku:** `docs/pages.md`, `docs/schema.sql`
**Yap:** `/kaydettiklerim`, `/alarmlar`, `/gecmis`, giriş modali (3. sorgudan
sonra), alarm tetikleme işi ve e-postalar.
**Bitti:** Fiyat düşünce e-posta gidiyor, geçmiş silinebiliyor.

### E3. Hesap ve KVKK akışları
**Oku:** `docs/kvkk.md`
**Yap:** `/hesap`, rıza tercihleri, veri indirme (JSON), geçmiş silme, hesap
silme (click kayıtları kimliksizleştirilir).
**Bitti:** Silme gerçekten siliyor, indirme çalışıyor, rızalar
`user_consent`'e yazılıyor.

### E4. Keşfet ve fırsatlar
**Oku:** `docs/routes.md`, `docs/pages.md`
**Yap:** `discovery_slot` günlük üretimi, curated havuz yükleme aracı,
`/kesfet`, `/firsatlar`.
**Bitti:** Izgara her gün değişiyor, curated ve organik ayrı başlıklarda.

---

## Blok F — Creator (MVP-2)

### F1. Creator profili ve koleksiyonlar
### F2. Affiliate hesap bağlama ve kazanç paneli
### F3. Takip ve creator feed'i

Bu blok MVP-1 metrikleri doğrulandıktan sonra detaylandırılır. Şimdiden
bölmek erken.

---

## Paralel işler (kod dışı)

Bu üçü kodla paralel yürür ve kod tarafını bloke eder:

| İş | Bloke ettiği görev |
| --- | --- |
| Merchant feed erişimi (Faz 0) | B1 gerçek veriyle çalışamaz |
| Embedding modeli seçimi | B3 |
| Alan adı + SPF/DKIM/DMARC | E1 üretimde çalışamaz |
| 300 ürünlük curated havuz | E4 |

---

## Kurallar

- Bir görev bitmeden sonrakine geçilmez.
- Şema değişikliği gerektiren her iş önce migration ile başlar.
- Yeni mimari karar `docs/decisions/` altına yazılır.
- Kabul kriteri karşılanmadıysa görev bitmemiştir; "sonra düzeltiriz" yok.
