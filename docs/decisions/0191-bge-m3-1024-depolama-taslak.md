# 0191 — BGE-M3 1024 boyutlu urun metin vektoru depolamasi (TASLAK)

**Durum:** Taslak. Uretimde uygulanmadi. Migration dosyalari `packages/db/migrations/` altina
henuz KONMADI: dagitim hatti klasordeki her dosyayi uygular. Kabulden sonra ayri PR, CI, yedek
dogrulamasi ve insan risk onayiyla eklenir.

## Baglam

- E4 (13 Kasim 2026): BGE-M3 (`bge-m3-5617a9f6`, revizyon 5617a9f6, CLS, L2, 1024 boyut) uretim
  sunucusunda (KVM 4) ayri, sinirli bir CPU konteynerinde gercek urun basliklariyla calistirildi.
- 1024 boyutlu vektorlerin uretim tablosu yok. Ciktilar simdilik `enrich.offline_embed` dosya
  kontrol noktalarindadir (float16, `content_hash`, `source_hash`, urun kimligi).
- Agirlik: sabit revizyonda yalniz pickle `.bin` vardi; `enrich.convert_safetensors` ile yalitilmis
  ortamda safetensors'a donusturuldu, bit duzeyinde esit, `derived-manifest.json` ile dogrulanir.

## Karar (onerilen)

1. `product_text_embedding_d1024` tablosu: `product_text_embedding` (0105) sozlesmesiyle ayni,
   `embedding halfvec(1024)` ve `STORAGE PLAIN` (E3-d: vektor satir icinde, TOAST'a gitmiyor).
2. `embedding_index` CHECK kisitlari yeni tabloyu ve 1024 boyutu kabul edecek sekilde genisler.
3. HNSW ayri `kind: concurrent` migration'da, YUKLEMEDEN SONRA, modele kismi ve sabit yuklemli:
   genel planda da dogru indeks secilir (E3-d.1).
4. Dosya kontrol noktalari tabloya `enrich.offline_embed import` (yazilacak) ile alinir: parca
   SHA-256'si ve kanarya kaydi dogrulanir, `content_hash` urunun guncel metniyle eslesmeyen satir
   alinmaz (metni degismis urun yeniden gomulur), yazim WAL geri basincina (0134) uyar, kullanim
   `api_usage`'a aktarilir (kural 9).

## Taslak: 0114 (`kind: schema`)

```sql
-- kind: schema
CREATE TABLE IF NOT EXISTS product_text_embedding_d1024 (
    product_id    BIGINT        NOT NULL REFERENCES product(id) ON DELETE CASCADE,
    model_version TEXT          NOT NULL CHECK (model_version ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
    text_version  SMALLINT      NOT NULL CHECK (text_version > 0),
    content_hash  BYTEA         NOT NULL CHECK (octet_length(content_hash) = 16),
    source_hash   BYTEA         NOT NULL CHECK (octet_length(source_hash) = 16),
    embedding     halfvec(1024) NOT NULL,
    embedded_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
    PRIMARY KEY (product_id, model_version)
);
ALTER TABLE product_text_embedding_d1024 ALTER COLUMN embedding SET STORAGE PLAIN;
CREATE INDEX IF NOT EXISTS product_text_embedding_d1024_hash_idx
    ON product_text_embedding_d1024 (model_version, content_hash);

-- Kisit adlari uretimde `\d embedding_index` ile dogrulanmali.
ALTER TABLE embedding_index DROP CONSTRAINT IF EXISTS embedding_index_storage_table_check;
ALTER TABLE embedding_index ADD CONSTRAINT embedding_index_storage_table_check CHECK (
    storage_table IN ('product_text_embedding', 'product_text_embedding_d384',
                      'product_text_embedding_d1024'));
ALTER TABLE embedding_index DROP CONSTRAINT IF EXISTS embedding_index_table_dims;
ALTER TABLE embedding_index ADD CONSTRAINT embedding_index_table_dims CHECK (
    (storage_table = 'product_text_embedding' AND dimensions = 768)
    OR (storage_table = 'product_text_embedding_d384' AND dimensions = 384)
    OR (storage_table = 'product_text_embedding_d1024' AND dimensions = 1024));
```

## Taslak: 0115 (`kind: concurrent`, yuklemeden sonra)

```sql
-- kind: concurrent
CREATE INDEX CONCURRENTLY IF NOT EXISTS product_text_embedding_d1024_hnsw_bge_m3_5617a9f6_v1
    ON product_text_embedding_d1024 USING hnsw (embedding halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 64)
    WHERE model_version = 'bge-m3-5617a9f6';
```

## Ayni PR'da gereken kod

- Kayit defteri `product_text_halfvec1024.table`; `enrich.products.TABLES`; `enrich.index`.
- TS `semantic-candidates.ts` tablo beyaz listesi ve `QUERYABLE_INDEXES` (parite testi). Sorgu
  tarafi (`remote_http` sorgu istemcisi) ayri karar; o gelmeden `online_query=false` kalir.

## Reddedilen

- Vektorleri 768 tablosuna Matryoshka ile kirpmak: recall 0,821 (karar 0183 olcumu).
- Bolumleme: E3-d.1 §6.
- HF topluluk safetensors donusum PR'lari: depo sahibince birlestirilmedi (bizim donusumle
  bit duzeyinde ayni oldugu yine de olculdu: 391/391 tensor).
