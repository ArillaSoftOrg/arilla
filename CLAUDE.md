# CLAUDE.md

Bu dosya her oturumda okunur. Kurallar tartışmaya açık değildir; bir kuralı
değiştirmek gerekiyorsa önce bu dosya güncellenir, sonra kod yazılır.

## Ürün

Türkiye pazarı için creator destekli AI alışveriş platformu. Kullanıcı fotoğraf,
ürün linki veya doğal dil ile arar; sistem aynı ve benzer ürünleri farklı
mağazalarda karşılaştırır. Creator'lar koleksiyon yayınlar ve affiliate gelir elde eder.

Detay: `docs/architecture.md`. Terimlerin tanımı: `docs/glossary.md`.

## Stack

- Web ve API: TypeScript, Next.js (App Router), React
- Toplu işler: Python 3.12
- Veritabanı: PostgreSQL 16 + pgvector
- Cache ve kuyruk: Redis
- Görsel depolama: S3 uyumlu obje deposu

## Mimari sınır — en önemli kural

TypeScript tarafı ile Python tarafı **birbirini asla çağırmaz.** Aralarındaki tek
iletişim kanalı PostgreSQL ve Redis kuyruğudur.

- Python: kuyruktan iş alır, veritabanına yazar. Hiçbir HTTP endpoint'i sunmaz.
- TypeScript: veritabanından okur. Python'a iş vermek için kuyruğa mesaj bırakır.

Bu kural bozulursa iki servis arası senkron bağımlılık oluşur ve mimarinin
tamamı anlamını yitirir.

## Değişmez kurallar

1. **İstek yolunda model çağrısı yok.** Tek istisna: kullanıcının yüklediği
   görselin embedding'i. O da `EmbeddingService` arkasından geçer ve görsel
   hash'i ile cache'lenir. Başka hiçbir yerde istek anında LLM veya model
   çağrısı yapılmaz.
2. **Benzerlik sorgu anında hesaplanmaz.** `similarity_edge` tablosu toplu işle
   doldurulur, istek yolu sadece okur.
3. **Her AI çıktısı saklanır.** Yorum özeti, kategori tahmini, öznitelik
   çıkarımı bir kez üretilir ve veritabanına yazılır. Maliyet katalog
   büyüklüğüyle ölçeklenir, kullanıcı sayısıyla değil.
4. **`price_point` değiştirilemez.** Sadece INSERT. UPDATE veya DELETE yazan
   kod reddedilir. Düzeltme gerekiyorsa yeni satır eklenir.
5. **Şemanın tek sahibi var.** Migration'ları yalnızca `packages/db` yazar.
   Python tarafı okur ve yazar ama migration üretmez.
6. **İş mantığı `packages/core` içindedir.** `apps/web`, `apps/mcp` ve ileride
   `apps/api` ince istemcilerdir. Bir iş kuralını app klasörüne yazma.
7. **Toplama işleri idempotent.** Aynı feed iki kez işlendiğinde sonuç
   değişmez. `(merchant_id, external_id)` üzerinde unique kısıt vardır.
8. **Her dış çıkış `click` kaydı üretir.** Merchant'a giden hiçbir link
   attribution kaydı olmadan oluşturulmaz.
9. **Her model çağrısı `api_usage` tablosuna yazılır.** Maliyet ölçülemiyorsa
   kontrol edilemez.
10. **Yüklenen görsel saklanmaz.** Embedding ve hash tutulur; ham dosya en fazla
    30 gün geçici depoda kalır. Detay: `docs/kvkk.md`.
11. **Seçilmiş içerik kullanıcı keşfi gibi etiketlenmez.** `public_find.source`
    ayrımı arayüzde korunur.
12. **Sponsorlu içerik her zaman rozetlidir.** Veritabanı kısıtı bunu zorunlu
    tutar, arayüz de gizleyemez.
13. **Tanımsız analitik olayı gönderilmez.** Olay adları `docs/events.md`
    içinde tanımlıdır.
14. **Migration'lar geriye uyumludur.** Önce kolon eklenir, kod dağıtılır, sonra
    eski kolon kaldırılır. Tek adımda kolon silen migration reddedilir.

## Kesinlikle yapılmayacaklar

- Scraping'i birincil veri kaynağı yapmak. Feed, API ve affiliate ağı kullanılır.
- Ayrı vektör veritabanı eklemek. pgvector yeterli; sınıra gelindiğinde ayrıca konuşulur.
- Mikroservis bölmek, Kubernetes, Kafka, event bus, GraphQL, CQRS eklemek.
- `localStorage` veya `sessionStorage` kullanımı olmadan çalışamayan bir akış kurmak.
- Elektronik kategorisini eklemek. Komisyon ekonomisi bu kategoride çalışmıyor.
- SEO rotalarında giriş modali göstermek. Bkz. `docs/decisions/0002`.
- Trend sayfalarını günlük değiştirmek. Günlük rotasyon yalnızca `/kesfet` içindir.
- Analitik yüküne veya hata kayıtlarına kişisel veri koymak.
- Sıralamada komisyon oranını belirleyici yapmak. Komisyon sadece eşit
  koşullarda ayrıştırıcıdır.

## Klasör yapısı

```
/apps
  /web          Next.js — public site, SEO sayfaları, creator profilleri
  /mcp          MCP sunucusu — ChatGPT ve diğer MCP istemcileri
/packages
  /core         iş mantığı: arama, alternatif bulma, attribution
  /db           şema, migration, tip üretimi. Şemanın tek sahibi.
  /ui           paylaşılan React bileşenleri
/services
  /ingest       Python — feed toplama, embedding, eşleştirme, benzerlik
/docs           bu belgeler
```

## Çalışma şekli

- Bir görev tek klasörle sınırlı kalmalı. Birden fazla klasöre yayılıyorsa
  görev çok büyüktür, böl.
- Şema değişikliği gerektiren her iş önce `docs/schema.sql` ve migration ile
  başlar, sonra kod yazılır.
- Yeni bir mimari karar alındığında `docs/decisions/` altına kısa bir dosya
  eklenir: karar, gerekçe, reddedilen alternatif.
- Test: iş mantığı `packages/core` içinde birim testli olmalı. UI testleri
  şimdilik zorunlu değil. **Eşleştirme mantığı için regresyon test seti
  zorunludur** — eşik değiştiğinde neyin bozulduğu başka türlü görülemez.

## Tema ve tipografi

Varsayılan açık tema, cihaz tercihi koyuysa koyu. İki tema da ilk günden
tanımlı. Renk belirteçleri `docs/design.md` içinde; hiçbir renk kod içine
gömülmez.

Font IBM Plex Sans, **depodan servis edilir**. Google Fonts veya başka bir
üçüncü taraf CDN'inden font, ikon veya betik çekilmez — kullanıcı IP'sini yurt
dışına aktarır. Bkz. `docs/decisions/0009-font.md`.

## Dil ve içerik

- Arayüz dili Türkçe. Kod, değişken adı, tablo adı, commit mesajı İngilizce.
- Kullanıcıya görünen metinlerde ALL CAPS kullanma. Türkçede büyük harf
  dönüşümü i/ı ve I/İ nedeniyle bozulur.
- "Satın al", "dupe" ve "ucuz" kelimeleri arayüzde geçmez. Karşılıkları
  `docs/glossary.md` içinde.
- Para birimi TRY. Fiyatlar kuruş cinsinden tamsayı olarak saklanır, asla float.
- Tüm zaman damgaları `timestamptz`, UTC.
