# 0181 — Embedding indeks yaşam döngüsü: boyuta göre tablo, gölge doldurma, atomik geçiş

Durum: **kabul**. Migration 0110. İlgili: 0177 (ürün metin vektörü), 0178 (gölge ölçüm),
0179 (veri seti), 0180 (sağlayıcı sözleşmesi ve kayıt defteri).

## Bağlam

Karar 0180 sonrasındaki durum:

- Hangi modelin hangi tabloya yazabileceği kayıt defterinde tanımlı. Ancak 768 dışındaki
  boyutlar için tablo yoktu.
- Aramanın hangi indeksi okuyacağı TS'de sabitti: `jina-embeddings-v3` ve `product_text_embedding`.
- Model değiştirmek kod değişikliği ve dağıtım istiyordu. Geri dönüş de aynı yoldan geçiyordu.

## Karar

1. **Depolama:** her boyutun kendi tablosu var. `product_text_embedding` (768) aynen kalıyor;
   `product_text_embedding_d384` aynı sözleşmeyle yeni eklendi.
   - Farklı boyutlar aynı kolona hiçbir zaman girmez: kolon tipi bunu reddeder.
   - HNSW indeksi her tablo için, yükleme bittikten sonra ayrı bir `kind: concurrent` migration
     ile kurulur.
   - 1024 ve üstü için tablo henüz yok. İhtiyaç olduğunda yeni migration ve kayıt defterinde aile
     tanımı eklenir.
2. **Durum tablosu `embedding_index`:** her hedef için durumlar şöyle ilerler:
   `building` → `shadow` → `active` → `retired`.
   - Kısmi unique indeks yüzünden hedef başına en fazla bir `active` satır olabilir.
   - Satırlar silinmez: `arilla_app` rolünde DELETE/TRUNCATE yetkisi yok. Rollback emekli
     satırı yeniden kullanır.
   - Tohum satırı bugünkü üretim indeksini kaydeder: `jina-embeddings-v3`, `active`.
3. **Gölge doldurma:** `enrich.products --model M` vektörü modelin kendi ailesinin tablosuna yazar.
   Aktif indekse ve aramaya dokunmaz.
   - Yerel CPU modeli (`local_onnx`) da aynı motoru kullanır: `--model-dir`, `--threads`.
     Çağrısı `api_usage`'a `cost_micros=0` ile yazılır (kural 9).
   - Yerel model çıktısı 0179 veri setine girmez; yeniden üretilebilir ve 768 boyutlu değildir.
   - `pilot` durumundaki modeller yalnızca yerel veritabanında çalıştırılabilir.
4. **Geçiş komutu `python -m enrich.index`:** `register`, `shadow`, `compare`, `activate`,
   `rollback`, `retire`.
   - Durumu değiştiren komutlar varsayılan olarak kuru çalışır; `--execute` gerekir.
   - Tek işlemde, danışma kilidi ve `FOR UPDATE` altında uygulanır: önce eski `active` →
     `retired`, sonra yeni → `active`.
   - Sonuç `job_run` kaydına yazılır (job `embedding_index`, karar 0174).
   - `activate` için şartlar:
     - satır `shadow` durumunda olmalı,
     - kayıt defterinde model üretime hazır olmalı (`active`/`shadow` ve lisansı doğrulanmış),
     - uygun ürünlerin en az `--min-coverage` kadarının (varsayılan %95) güncel vektörü olmalı.
   - `compare`, aktif indeks ile aday indeks arasında ilk-k komşu Jaccard örtüşmesini salt okunur
     ölçer.
5. **Okuma tarafı (TS, `search/semantic/active-index.ts`):**
   - Aktif satırı 60 saniyelik süreç önbelleğiyle okur. Geçiş en geç 60 saniyede görünür; bu
     sırada eski ya da yeni indeksten biri okunur, ikisi karışmaz.
   - Tablo adı ve boyut yalnızca beyaz listeden SQL'e girer. Satırlar `model_version` ile
     süzüldüğü için başka modelin vektörü hiçbir zaman karşılaştırılmaz.
   - Aktif model TS'nin sorgu vektörü üretemediği bir modelse (ör. yalnız Python'da çalışan yerel
     CPU modeli) gölge ölçüm `no_vector/unsupported_model` yazar. Sağlayıcı çağrılmaz.
   - Tablo okunamazsa (ör. migration öncesi) varsayılana düşer.
   - `SEMANTIC_EMBEDDING_MODEL` 0178'deki anlamını korur ve önceliklidir.
   - Kayıt defteri paritesini `active-index.test.ts` korur: Python JSON dosyası testte okunur;
     iki taraf çalışma zamanında birbirini çağırmaz.

## Davranış değişikliği

Yok:

- Tohum satır bugünkü sabit değerlerle birebir aynı.
- Gölge ölçüm (0178) kullanıcı sonucunu değiştirmez.
- `SEMANTIC_SEARCH_MODE=on` yoktur.

## Reddedilen

- **Tek tabloda boyutsuz `vector` kolonu:** HNSW boyutlu kolon ister ve boyutlar karışabilir.
- **Aktif indeksi ortam değişkeni ya da kayıt defteri dosyasında tutmak:** her geçiş dağıtım ister,
  geri dönüş de yavaşlar. Durum veritabanında, model tanımı kod incelemesinde kalır.
- **Geçişi TS'de (yönetim paneli) yapmak:** yazan tek yer Python işi olmalı. Panel ileride yalnızca
  okuyabilir.
- **OpenSearch, Qdrant, ayrı vektör veritabanı:** CLAUDE.md gereği yok.

## Açık

- Yerel CPU modeli aktif olursa sorgu vektörü istek yolunda yerelde üretilmesi gerekir. Bu,
  kural 1'e yeni bir istisna demektir ve ayrı karar ister. O zamana kadar böyle bir model yalnızca
  toplu iş ve gölge karşılaştırma içindir.
- d384 tablosu için HNSW yok. Tam katalog doldurulmadan önce ayrı bir `concurrent` migration
  gerekir.
