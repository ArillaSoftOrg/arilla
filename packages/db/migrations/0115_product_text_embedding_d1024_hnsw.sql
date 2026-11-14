-- kind: concurrent
-- 0115 — BGE-M3 (1024 boyut) kismi HNSW indeksi (karar 0195 §3, karar 0196).
--
-- Tek model icin (`bge-m3-5617a9f6`) kismi ve SABIT yuklemli indeks: model adi metin sabiti oldugundan
-- genel planda da dogru indeks secilir (E3-d.1). Anlamsal sunum (karar 0190) indeksi adinin `_v1`
-- sonekinden okur; m / ef_construction / opclass degisirse surum artar.
--
-- ef_construction = 200 (E4 taslagindaki 64 DEGIL): 160.017 gercek vektorde olculdu, recall@10 ef_search=150'de
-- 0,88 -> 0,92, ef=400'de 0,93 -> 0,96; boyut (394 MB) ve sorgu gecikmesi ayni, yalniz kurulum suresi artar.
--
-- ONKOSUL (dagitimdan ONCE insan onayli): vektorler `enrich.vector_import` ile yuklenmis ve `verify` temiz
-- olmali. Bos tabloda kurulursa sonraki yukleme her satirda indeks bakimi yapar (WAL ve sure katlanir);
-- bu yuzden bu dosya 0114'ten AYRIDIR ve yuklemeden sonra eklenir.
--
-- Bu migration hicbir modeli ETKINLESTIRMEZ: `embedding_index` satiri kurmaz, kayit defterindeki model
-- `disabled` kalir; sunum ayrica saglikli sorgu servisi ve gecen kanarya ister. Geri alma:
-- `DROP INDEX CONCURRENTLY IF EXISTS product_text_embedding_d1024_hnsw_bge_m3_5617a9f6_v1` (veri etkilenmez).
CREATE INDEX CONCURRENTLY IF NOT EXISTS product_text_embedding_d1024_hnsw_bge_m3_5617a9f6_v1
    ON product_text_embedding_d1024 USING hnsw (embedding halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 200)
    WHERE model_version = 'bge-m3-5617a9f6'
