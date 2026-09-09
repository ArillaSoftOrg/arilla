# Mimari

## Tek cümle

Python toplu işleri veriyi toplar, zenginleştirir ve eşleştirir; PostgreSQL bu
işin sonucunu tutar; TypeScript istek yolu sadece okur. İki taraf birbirini
asla çağırmaz.

## Katmanlar

### 1. Toplama (Python, `services/ingest/collect`)

Veri edinme üç katmanlıdır. Sorgu anında internetten arama yapılmaz; kullanıcı
sorgusu her zaman kendi kataloğumuz üzerinde çalışır.

**Katman 1 — Toplu ve izinli (omurga).** Feed, API, affiliate ağ dökümü.
Katalog buradan dolar, fiyat geçmişi buradan birikir.

**Katman 2 — Kullanıcı tetikli tek URL çözümleme.** Kullanıcı katalogda olmayan
bir link yapıştırdığında sadece o sayfa getirilir. Kurallar: yalnızca kullanıcı
isteğiyle, yalnızca o URL, `robots.txt` dinlenir, önce sayfadaki yapılandırılmış
veri (schema.org JSON-LD) denenir, HTML ayrıştırma son çaredir. Sonuç
`discovery_source = 'user_link'` ile kalıcı olarak kataloğa yazılır ve o günden
sonra normal fiyat güncelleme rotasyonuna girer. Cache değil, katalog kaydıdır.

Bu sayede katalog talebe göre büyür: bütün internet değil, insanların gerçekten
karşılaştırdığı ürünler indekslenir.

**Katman 3 — Yoktur.** Toplu kazıma altyapıya girmez. Sorgu anında canlı kazıma
hem 3 saniyelik hedefi tutturamaz, hem bloklanır, hem de affiliate
programlarından çıkarılma sebebidir.

Her merchant için bir connector. Girdi bir XML feed, bir API veya bir affiliate
ağ dökümü olabilir; çıktı her zaman aynıdır.

Akış: connector → ham kayıt → normalizasyon → `offer` upsert → `price_point` INSERT.

- Zamanlanmış çalışır, `merchant.refresh_minutes` değerine göre.
- Idempotent: `(merchant_id, external_id)` üzerinde unique kısıt.
- Her koşu `ingest_run` tablosuna yazılır. Sessiz başarısızlık kabul edilmez.
- Fiyat değişmemiş olsa bile `price_point` yazılır. Sürekliliğin kendisi veridir.
- Varyant stoğu için tersi geçerli: `variant_stock_event` yalnızca durum
  **değiştiğinde** yazılır. Her koşuda yazılırsa tablo şişer.

**Bu katman ürün hazır olmasa bile çalışmaya başlamalıdır.** Fiyat geçmişi
geriye dönük üretilemez.

### 2. Zenginleştirme (Python, `services/ingest/enrich`)

- Görsel indirilir, hash'lenir, embedding üretilir → `embedding`
- Öznitelik çıkarımı (renk, malzeme, beden) → `product.attributes`
- Kategori sınıflandırma
- Yorum özeti → `generated_content`

Kural: `input_hash` değişmediyse yeniden üretilmez. Aynı içerik iki kez
işlenmez.

#### Embedding nereden gelir, nerede üretilir

Embedding'ler **barındırılan çok-kipli bir API'den** alınır (Jina CLIP v2);
kendi modelimizi çalıştırmıyoruz, altyapıda GPU servisi yok. Metin ve görsel
aynı vektör uzayına düşer, çıktı 768 boyuta kırpılır. Gerekçe ve reddedilen
alternatifler: `docs/decisions/0015-embedding-saglayici.md`.

Çağrı **iki ayrı yerden** yapılır ve bu ayrım kasıtlıdır:

| Ne | Nerede | Ne zaman |
| --- | --- | --- |
| Katalog görselleri ve metinleri | Python toplu işi (`services/ingest/enrich`) | Zamanlanmış; istek yolunun dışında |
| Kullanıcının yüklediği görsel | TypeScript istek yolu, `EmbeddingService` arkasından | İstek anında, görsel hash'i ile cache'li |

Katalog tarafı toplu iş olarak kalır çünkü maliyet katalog büyüklüğüyle
ölçeklenir, kullanıcı sayısıyla değil — bir kez üretilir, bin kez okunur.

İkinci satır `CLAUDE.md` 1. kuralın **tek istisnasıdır**: istek yolundaki tek
model çağrısı budur ve kuralın kendisi onu `EmbeddingService` arkasına ve
hash cache'ine bağlar.

**Bu, mimari sınırı bozmaz.** Python ile TypeScript birbirini çağırmıyor;
ikisi de aynı dış API'yi bağımsız olarak çağırıyor. Aralarındaki tek kanal
hâlâ PostgreSQL ve Redis kuyruğu.

Her iki çağrı da `api_usage` tablosuna yazılır (`CLAUDE.md` 9. kural):
ölçülmeyen maliyet kontrol edilemez.

### 3. Eşleştirme (Python, `services/ingest/resolve`)

Katmanlı, sırayla dener ve ilk kesin sonuçta durur:

1. `gtin` veya `mpn` eşleşmesi → doğrudan bağla
2. Normalize başlık + marka benzerliği (trigram)
3. Görsel embedding kosinüs mesafesi
4. Öznitelik uyumu

Sonuç `match_candidate` tablosuna skorla yazılır. Eşiğin üstü
`auto_accepted` — offer o ürüne bağlanır; altı `pending` olarak insan
kuyruğuna düşer ve **bağlanmaz**.

Renk, hacim, beden, model kademesi ve marka uyuşmazlıkları eşleşmeyi VETO
eder — skoru düşürmez, sıfırlar. Renk vetosu zorunludur çünkü `product` renk
düzeyinde kanoniktir: "Bilekli Bot Siyah" ile "Bilekli Bot Bej" başlıkta
neredeyse aynıdır.

**Hiçbir adaya ulaşamayan offer için yeni `product` açılır** ve offer ona
bağlanır; aksi hâlde feed'den gelen katalog hiç büyümezdi. Kategori yoktan
açılmaz, yalnızca mevcut bir yola bağlanır.

**Eşik değerleri `docs/decisions/` altında kayıtlıdır.** Yanlış "aynı ürün"
iddiası kullanıcı güvenini bir kerede yok eder; temkinli olmak pahalı değildir.

### 3b. Fiyat istatistikleri (Python, gece toplu işi)

`product_price_stats` doldurulur: 30/90 günlük min, medyan, güncel yüzdelik
dilim, düşüş sayısı ve sahte indirim sinyali. İstek yolu fiyat geçmişini asla
taramaz, sadece bu tabloyu okur.

**Tek istisna: ürün sayfasının fiyat grafiği.** Tek bir ürünün tekliflerine
sınırlı, 90 günlük, `offer_product_idx` ve `price_point_offer_time_idx`
üzerinden tam indeksli bir sorgu (sıralı tarama yok, `EXPLAIN` ile
doğrulanır). Kural asıl olarak katalog geneli veya sıralama amaçlı
tekrarlanan taramaları önlemek için var; tek ürünün sınırlı geçmişini sayfa
başına bir kere okumak bu riski taşımaz. Bkz. `docs/decisions/0019`.

Buradan doğan kullanıcıya dönük özellikler: "şu an son 90 günün en düşük
fiyatı", "son 3 ayda 12 kez daha ucuzdu", ve liste fiyatı indirimden hemen önce
yükseltilmişse nötr bir bilgi notu.

### 4. Benzerlik (Python, `services/ingest/similarity`)

Gece toplu işi. `similarity_edge` tablosunu doldurur. Dört tür kenar:

- `same` — aynı ürün, farklı merchant
- `visual` — görsel olarak benzer
- `semantic` — özellik ve kullanım amacı olarak yakın
- `substitute` — kullanıcıların gerçekte yerine seçtiği (tıklama ve dönüşüm
  verisinden öğrenilir; ilk aylarda boş kalır)

Bu tablo dolmadan alternatif önerisi çalışmaz. İstek yolu buradan başka
hiçbir yerden benzerlik okumaz.

### 5. Sunum (TypeScript, `apps/*` + `packages/core`)

`packages/core` içindeki fonksiyonlar tek gerçek uygulamadır. Üç ince istemci:

- `apps/web` — Next.js. SSR, SEO sayfaları, creator profilleri
- `apps/mcp` — MCP sunucusu. Araçlar: `visual_search`, `find_alternatives`,
  `compare_merchants`. İçinde iş mantığı yoktur, core'a delege eder
- `apps/api` — B2B, Faz 4. Aynı core'un dördüncü istemcisi

### 6. Attribution (TypeScript, `packages/core/attribution`)

Merchant'a giden her link `/git/:clickId` üzerinden geçer:

1. `click` kaydı yazılır (creator, user, session, offer, channel, fiyat)
2. Merchant'ın affiliate durumu okunur
3. Uygunsa `deeplink_template` ile takipli link üretilir
4. 302 yönlendirme

Dönüşümler merchant/ağ raporlarından günlük olarak çekilir ve `click_id`
üzerinden `conversion` tablosuna eşlenir.

## İstek yolu bütçesi

| İşlem | Model çağrısı | Kaynak |
| --- | --- | --- |
| Link yapıştırma | yok | `offer` lookup |
| Ürün sayfası | yok | `product` + `similarity_edge` |
| Metin araması | yok | trigram + `embedding` (önceden üretilmiş) |
| Görsel arama | **1** (sorgu embedding'i) | hash cache'ten dönebilir |
| Yorum özeti | yok | `generated_content` |

Görsel arama dışında istek yolunda model çağrısı yoktur. Bu kural gevşetilirse
birim ekonomisi çöker; gerekçe `docs/decisions/` altına yazılmadan
değiştirilemez.

## Ölçekleme

Binlerce eşzamanlı kullanıcı, stateless Next.js instance'ları + tek Postgres +
Redis ile karşılanır. Darboğaz sırası:

1. Görsel arama embedding üretimi → hash cache ve kullanıcı başına günlük limit
2. `similarity_edge` okuma → Redis cache, popüler ürünler için
3. Postgres okuma → read replica (gerektiğinde, önceden değil)

pgvector milyonlarca satırda HNSW indeksiyle yeterlidir. Ayrı vektör
veritabanı gerektiğinde ayrı bir karar olarak alınır.

## Ortamlar

- `local` — Docker Compose: Postgres, Redis, MinIO
- `staging` — üretimin küçük kopyası, gerçek feed'lerin bir alt kümesiyle
- `production`

Migration'lar staging'de çalışmadan production'a gitmez.
