# 0180 — Embedding sağlayıcı sözleşmesi ve model kayıt defteri

Durum: **kabul (PR-A)**. Migration yok. İlgili: 0015 (sağlayıcı), 0155 (yerel e5 ONNX),
0174 (iş sonucu), 0177 (ürün metin vektörü), 0178 (gölge ölçüm), 0179 (veri seti).

## Bağlam

- Embedding şu an iki hosted modelle üretiliyor: `jina-clip-v2` (teklif görsel/metin, `embedding`,
  `vector(768)`) ve `jina-embeddings-v3` (ürün metni, `product_text_embedding`, `halfvec(768)`).
  Model kimliği, görev, boyut ve token tahmini kod sabitlerindeydi.
- İleride yerel CPU (e5-small, BGE-M3) ya da uzak GPU/API (Qwen3-Embedding, Qwen3-VL vb.)
  modellerine geçmek isteniyor. Bu modellerin boyutları farklı (384, 1024, 1536+). Bunlar
  768'lik tablolara **karışırsa** kosinüs araması sessizce anlamsız sonuç verir.
- Yerel ONNX gömme altyapısı karar 0155 ile zaten var (`classify/suggest/model.py`; sabit
  revizyon, SHA-256 doğrulaması, torch yok).

## Karar

1. **Model kayıt defteri** `services/ingest/enrich/model_registry.json` dosyasıdır; yükleyicisi
   `enrich/registry.py`'dir. Her model için şunlar tutulur:
   - `id` (yazılan `model_version`), sağlayıcı, kaynak/revizyon
   - lisans ve `license_verified`
   - kipler, boyut, normalizasyon, `max_input_tokens`, `chars_per_token`
   - ön işleme sürümü, görev/önek, `index_family`, durum (`active|shadow|pilot|disabled`)

   Yükleyici katıdır: bilinmeyen ya da eksik alan, tanımsız aile, çift kimlik, ailesiyle
   uyuşmayan boyut veya üretime hazır olmayan varsayılan hata verir.
2. **İndeks ailesi** bir tablo ile bir boyutun eşidir. Bir model **yalnızca kendi ailesinin**
   tablosuna yazar (`require_writable`).
   - Tablosu olmayan aile (`table: null`) yazılamaz; bunun için önce migration gerekir.
   - `enrich.products` başlarken bu denetimi yapar. Uyuşmazlıkta veritabanına hiç dokunmadan
     `failed/incompatible_index` sonucuyla çıkar.
3. **Seçim** öncelik sırasıyla: `--model`, sonra `ENRICH_PRODUCT_TEXT_MODEL`, sonra kayıt
   defterindeki varsayılan.
   - Üretimde yalnızca `active`/`shadow` durumundaki ve lisansı doğrulanmış modeller seçilebilir.
   - `pilot` modeller yalnızca `enrich.pilot`'ta kullanılabilir, `disabled` modeller hiç.
4. **Sağlayıcı sözleşmesi** `enrich/providers.py`'dedir.
   - Ortak arayüz `TextEmbeddingProvider`: `model_version`, `text_batch_size`, `embed_texts`.
     Amaç (passage/query) çağrı başına değil, sağlayıcı kurulurken seçilir.
   - Uzak API: mevcut `JinaEmbeddingClient`. HTTP, retry ve 429 davranışı değişmedi.
   - Yerel CPU: `LocalOnnxTextProvider`, 0155'teki `OnnxEmbedder`'ı sarar.
     - Model dizinindeki sürüm kayıt defterindeki `id` ile aynı değilse yükleme reddedilir.
     - Parti boyutu en fazla 256, iş parçacığı sayısı `threads` ile sınırlıdır.
5. **Vektör kapısı** `validate_batch`'tir. Her yazımdan önce sonuç sayısını, boyutu, sonlu
   değerleri ve birim normu denetler.
   - Kapıyı geçemeyen parti `EmbeddingInvalid` olur. Bu bir `EmbeddingError`'dur: parti yazılmaz,
     ardışık hata sayacına girer.
   - Çağrının maliyeti yine `api_usage`'a yazılır (kural 9).
6. **Metin hazırlama v2** `enrich/text_prep.py`'dedir.
   - Sabit alan sırası: marka, başlık, model, kategori, özellikler, açıklama.
   - Her parça hangi kaynak alandan geldiğini (`Span`) taşır.
   - Tokenizer ya da `chars_per_token` ile ölçülen bir bütçeye göre kesilir.
   - Uzun metin örtüşmeli parçalara bölünür; her parça kendi sırası ve özeti ile gelir.
   - **Üretim yolu değişmedi:** `product_text.TEXT_VERSION=1` (marka + başlık). v2 yalnızca pilot
     ve gelecekteki indeksler içindir.
7. **Gözlem:**
   - `enrich_products` iş kaydının `detail` alanına `provider`, `embed_ms_p50/p95` ve
     `items_per_s` eklendi; yalnızca sayı içerir.
   - `python -m enrich.coverage` salt okunur çalışır ve model başına kapsamı verir.
   - `python -m enrich.pilot` yerel modelin gecikmesini, verimini ve tepe RSS'ini ölçer. Hiçbir
     şey yazmaz; `--from-db` yalnızca yerel veritabanıyla çalışır.

## Kayıttaki modeller

| id | sağlayıcı | boyut | durum | not |
| --- | --- | --- | --- | --- |
| `jina-clip-v2` | jina | 768 | active | teklif görsel+metin (0015) |
| `jina-embeddings-v3` | jina | 768 | active | ürün metni varsayılanı (0177) |
| `e5-small-int8-0bcc8ca76950` | local_onnx | 384 | pilot | MIT; lisans incelemesi kayda geçmedi; tablo `product_text_embedding_d384` (0181) |
| `bge-m3` | local_onnx | 1024 | disabled | ONNX yapısı yok, lisans doğrulanmadı |

## Reddedilen / ertelenen

- **OpenSearch, Qdrant, ayrı vektör veritabanı:** CLAUDE.md "ayrı vektör veritabanı ekleme"
  kuralı geçerli; pgvector sınırına gelinmedi.
- **Şimdi GPU servisi, BGE-M3 ya da Qwen:** ölçülmeden etkinleştirilmez. Adaptör noktası hazır.
- **Kayıt defterini veritabanına koymak:** model listesi kod incelemesinden geçmeli. Veritabanında
  yalnızca "hangi indeks aktif" bilgisi tutulacak (PR-B).
- **Tek tabloda çoklu boyut** (`vector` boyutsuz kolon): HNSW boyutlu kolon ister, ayrıca
  karışma riski yaratır.

## Sonraki adımlar

Aşağıdakiler karar 0181 ile aynı PR'da uygulandı (migration 0110, `enrich.index`,
`search/semantic/active-index.ts`).

- **PR-B (`packages/db`, migration 0110):**
  - `embedding_index` tablosu: `model_version`, `index_family`, `dims`, `target`, durum
    `building|shadow|active|retired`. Hedef başına tek `active` (kısmi unique).
  - Boyuta göre ayrı tablolar; HNSW ayrı bir `concurrent` migration ile kurulur.
- **PR-C (`services/ingest`):**
  - Kayıt defterinden hedef tabloya backfill (`enrich.products` motoru).
  - Gölge karşılaştırma (0178).
  - Aktif indeksi tek UPDATE ile atomik değiştirme; rollback = önceki satırı tekrar `active` yapmak.
- **PR-D (`packages/core`):** TS sorgu gömücüsü modeli ve tabloyu aktif indeksten okur; kayıt
  defteriyle parite testi eklenir.
