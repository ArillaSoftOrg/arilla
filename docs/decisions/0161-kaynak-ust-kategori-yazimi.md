# 0161 — Kaynak üst eşlemesiyle yalnızca üst kategori yazımı (açık onaylı)

Durum: kabul edildi (31 Ekim 2026). Kullanıcı, `source_parent_map.tsv` içindeki `yuksek` eşlemelerin
**üst kategori** olarak ürünlere yazılmasına açıkça izin verdi. Bu, karar 0139 §7 (≥300 insan etiketi
ve Wilson alt sınırı ≥0,80) ile karar 0157'nin "hiçbir ürün kategorisi yazılmaz" kapısının bilinçli
ve **kapsamı sınırlı** bir istisnasıdır. Alt kategori yazımı bu kararın dışındadır.

## Bağlam

AliExpress'in 2.769.478 ürününün tamamında kaynak yolu (`offer.category_raw`) var, ama `product.category_id`
yalnızca 1.898 üründe dolu. Kategorisiz ürün kategori filtresinde ve kategori adıyla eşleşen aramada
görünmez. Karar 0157 275 kaynak yolunu üç duruma ayırdı: `yuksek` (202), `inceleme` (63), `eslesmedi` (10).
Kullanıcı hedefi: ürünlerin kullanılabilir olması için güvenilir üst kategoriyi yazmak, belirsizi
incelemeye bırakmak.

## Karar

1. **Kapsam:** yalnızca `yuksek` satırlar. `inceleme`, `eslesmedi`, haritada olmayan ve kaynak yolu
   olmayan ürünler **kategorisiz kalır**; sayılır (`parents-report`, `job_run` ayrıntısı), yazılmaz.
   **Alt kategori yazılmaz** (hibrit alt kategori AI ölçümünde ~%56 yanlış, karar 0157).
2. **Yeni komutlar** (`services/ingest/classify/parent_apply.py`): `parents-report` (yalnızca okur),
   `parents --confirm`, `parents-undo --confirm`.
3. **Yazma kuralları:** yalnızca `category_id IS NULL` ürünlerde, eski değerle koşullu güncelleme.
   Mevcut değer (insan, besleme, V5) asla ezilmez; arada başka yazar doldurduysa ürün atlanır ve
   `errors` olarak sayılır. Yalnızca `category_id` ve `updated_at` yazılır; fiyat, teklif, yayın durumu,
   `price_point` değişmez. Yayındaki ürün için `search_outbox` kaydı (`classified`) eklenir.
4. **Hedef doğrulaması:** eşlemedeki bir yol kategori ağacında yoksa hiçbir şey yazılmaz
   (`category_missing`).
5. **İz ve geri alma:** her yazım `product_classification`a `rule_version = 50` (V5=5, dinamik=6'dan
   ayrı), `category_basis = 'source'`, `detail = 'source_parent'`, `wrote_category = TRUE`,
   `confidence = 70` ile işlenir. Şema CHECK'i yeni bir `category_basis` değerine izin vermediği ve
   migration bu işin kapsamında olmadığı için ayrım kural sürümü + `detail` ile yapılır. `parents-undo`
   yalnızca bu satırları ve **hâlâ aynı değeri taşıyan** ürünleri `NULL` yapar; iz `source_parent_undone`
   olur. Başka yazarın sonradan değiştirdiği kategoriye dokunulmaz.
6. **V5 ile birlikte yaşama:** `products` koşuları bu işin yazdığı kategoriyi geri almaz
   (`_Row.parent_owned` atlanır); `--owned-only` seçimi `rule_version = 50` satırlarını dışlar. Ürün
   başına tek `product_classification` satırı olduğundan, V5 koşusunun bu ürünlerde markayı
   sınıflandırması şimdilik **yapılmaz** (iz korunsun diye); bu kısıt marka sınıflandırması toplu
   açılırken yeniden ele alınır.
7. **Altyapı yeniden kullanımı:** `product_classification_state` (kural 50, `scope = merchant:<slug>`),
   ürün kimliğiyle kontrol noktası, `--batch/--max-batches/--max-seconds/--sleep-ms/--rescan`, WAL
   geri basıncı (karar 0134; çıkış kodu 3), `catalog_build` ve çift çalışma kilidi (çıkış kodu 4),
   parti başına tek kısa işlem, kilit zaman aşımında yeniden deneme.
8. **Gelecekteki ürünler:** kontrol noktası kimlikle ilerlediğinden aynı komut sonradan gelen ürünleri
   da kapsar. Zamanlayıcıya **eklenmedi** (zamanlayıcıları değiştirmek ayrı karar); komut elle ya da
   sonraki bir kararla zamanlanır. İnceleme yolundaki ürünler imlecin gerisinde kalır; harita
   güncellenirse `--rescan` yeniden tarar.

## Ölçüm (karar 0157'den; AI etiketi, insan etiketi DEĞİL)

400 ürünlük örnekte `yuksek` kaynak üst kategorisi: 274 üründe 224 doğru (**%81,8**). Dört eşleme
istisnası bu örneğe bakılarak düzeltildiği için ölçüm **örnek içi ve iyimserdir**. Yanlışların çoğu
satıcının ürünü yanlış AliExpress kategorisine koymasından gelir. Beklenen yazım sayısı üretimde
`parents-report` ile ölçülür; örnekte ürünlerin ~%68'i `yuksek` yoldaydı (tahmin, kesin sayı değil).

## Etkiler ve açık noktalar

- **Görünürlük:** Hedef düğümlerin çoğu karar 0153 gereği `is_discoverable = FALSE`. Arama ve
  kategori süzgeci bu bayrağa bakmaz; ürünler kategori adıyla eşleşen sorgularda ve `category_path`
  süzgecinde görünür. Sitemap, keşfet akışı ve trend/veri zekâsı yüzeylerine girmezler. Bayrak
  **açılmadı**; hangi dalın ne zaman açılacağı ayrı karar (hassas dallar dahil).
- **`classify lexicon --apply`** bu karara dahil değildir ve ayrı kararla açılır: sözlük V5 yollarına
  (eski düğümler) bakar, katı kategori filtresi üst düğümlerdeki ürünleri kapsamayabilir. Açmadan önce
  `/ara` ve `/sohbet` için canlı doğrulama gerekir.
- İnsan etiketi yok: doğruluk %81,8 AI ölçümüdür; yanlış yerleşim olabilir ve geri alınabilir.

## Reddedilen alternatifler

- **Alt kategori yazmak:** ölçümde %56 yanlış (karar 0157).
- **`category_source_map`i `confirmed` yapmak:** AI önerisini insan onayı gibi gösterirdi; V5 yolu
  başlık/marka kararına da karışırdı.
- **Yeni `category_basis` değeri + migration:** bu işin kapsamı dışında; kural sürümü ve `detail` aynı
  geri alınabilirliği sağlıyor.
- **Zamanlayıcıya eklemek:** zamanlayıcı değişikliği ayrı onay gerektirir.
- **`is_discoverable`i açmak:** sitemap/keşfet etkisi var; ayrı karar.
