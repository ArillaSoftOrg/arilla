---
paths:
  - "services/ingest/**"
---

# Ingest (Python) kuralları

- Python hiçbir HTTP endpoint'i sunmaz ve TypeScript'i çağırmaz; kuyruktan iş
  alır, PostgreSQL'e yazar.
- Migration üretmez; şema `packages/db`'nin sahipliğindedir.
- Toplama idempotent: aynı feed iki kez işlenince sonuç değişmez
  (`(merchant_id, external_id)` unique).
- Her model çağrısı `api_usage` tablosuna yazılır. AI çıktıları bir kez üretilip saklanır.
- `similarity_edge` burada toplu işle doldurulur.
- Eşleştirme mantığı için regresyon test seti zorunludur; eşik değişikliği
  bu setle doğrulanmadan yapılmaz.
- Scraping birincil kaynak değildir: feed, API, affiliate ağı.
