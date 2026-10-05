# CLAUDE.md

Kurallar tartışmaya açık değildir; bir kuralı değiştirmek gerekiyorsa önce bu
dosya (veya `.claude/rules/`) güncellenir, sonra kod yazılır. Klasöre özel
kurallar `.claude/rules/` altındadır ve ilgili dosyalara dokunulunca yüklenir.

## Ürün

Türkiye pazarı için creator destekli AI alışveriş platformu: fotoğraf, ürün linki
veya doğal dil ile arama; aynı/benzer ürünleri mağazalar arası karşılaştırma;
creator koleksiyonları ve affiliate gelir. Detay `docs/architecture.md`, terimler
`docs/glossary.md` — gerektiğinde oku.

Stack: TypeScript/Next.js (App Router)/React · Python 3.12 toplu işler ·
PostgreSQL 16 + pgvector · Redis (cache + kuyruk) · S3 uyumlu görsel deposu.

## Mimari sınır — en önemli kural

TypeScript ve Python **birbirini asla çağırmaz.** Tek iletişim kanalı PostgreSQL
ve Redis kuyruğudur. Python kuyruktan iş alır, DB'ye yazar, HTTP endpoint sunmaz.
TypeScript DB'den okur, Python'a iş için kuyruğa mesaj bırakır.

## Değişmez kurallar

1. **İstek yolunda model çağrısı yok.** Tek istisna: yüklenen görselin embedding'i,
   `EmbeddingService` arkasından, görsel hash'i ile cache'li.
2. **Benzerlik sorgu anında hesaplanmaz.** `similarity_edge` toplu işle dolar, istek yolu okur.
3. **Her AI çıktısı saklanır** (özet, kategori, öznitelik): bir kez üretilir, DB'ye yazılır.
4. **`price_point` sadece INSERT.** UPDATE/DELETE yok; düzeltme = yeni satır.
5. **Migration'ları yalnızca `packages/db` yazar.** Python okur/yazar, migration üretmez.
6. **İş mantığı `packages/core` içindedir.** `apps/*` ince istemcidir.
7. **Toplama işleri idempotent.** `(merchant_id, external_id)` unique.
8. **Merchant'a giden her link `click` kaydı üretir.**
9. **Her model çağrısı `api_usage` tablosuna yazılır.**
10. **Yüklenen görsel saklanmaz.** Embedding + hash tutulur; ham dosya ≤30 gün geçici. `docs/kvkk.md`.
11. **Seçilmiş içerik kullanıcı keşfi gibi etiketlenmez** (`public_find.source`).
12. **Sponsorlu içerik her zaman rozetlidir** (DB kısıtı + arayüz).
13. **Tanımsız analitik olayı gönderilmez** (`docs/events.md`).
14. **Migration'lar geriye uyumludur.** Tek adımda kolon silen migration reddedilir.

## Kesinlikle yapılmayacaklar

- Scraping'i birincil veri kaynağı yapmak (feed, API, affiliate ağı kullanılır).
- Ayrı vektör DB, mikroservis, Kubernetes, Kafka, event bus, GraphQL, CQRS.
- Analitik yüküne veya hata kayıtlarına kişisel veri koymak.
- Sıralamada komisyonu belirleyici yapmak (sadece eşit koşullarda ayrıştırıcı).
- Üçüncü taraf CDN'den font, ikon veya betik çekmek (`docs/decisions/0009-font.md`).

## Klasör yapısı

```
apps/web        Next.js — public site, SEO, creator profilleri
apps/mcp        MCP sunucusu
packages/core   iş mantığı: arama, alternatif bulma, attribution
packages/db     şema, migration, tip üretimi (şemanın tek sahibi)
packages/ui     paylaşılan React bileşenleri
services/ingest Python — feed, embedding, eşleştirme, benzerlik
docs            referans belgeler (otomatik okunmaz; gerektiğinde ara/oku)
```

## Çalışma şekli

- Görev tek klasörle sınırlı kalmalı; birden fazla klasöre yayılıyorsa böl.
- Şema değişikliği önce `docs/schema.sql` + migration ile başlar, sonra kod.
- Yeni mimari karar → `docs/decisions/` altına kısa dosya (karar, gerekçe, reddedilen alternatif).
- `packages/core` iş mantığı birim testli olmalı. Eşleştirme mantığı için
  regresyon test seti zorunlu. UI testleri şimdilik zorunlu değil.

## Dil ve veri

- Arayüz Türkçe; kod, değişken, tablo adı, commit mesajı İngilizce.
- Arayüzde "satın al", "dupe", "ucuz" geçmez (karşılıkları `docs/glossary.md`); ALL CAPS yok.
- Para TRY, kuruş cinsinden tamsayı — asla float. Zaman damgaları `timestamptz`, UTC.
