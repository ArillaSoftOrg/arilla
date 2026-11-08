# 0178 — Anlamsal arama: gölge ölçüm (`SEMANTIC_SEARCH_MODE=shadow`)

Durum: **kabul**. Migration 0108. CLAUDE.md kural 1'e yedinci istisna. İlgili: 0170 (pilot ve
ölçümler), 0177 (ürün metin vektörü), 0176 (tek arama yüzeyi `/sohbet`), 0062 (metin süzgeci),
0174 (iş sonucu), 0136 (arama olay kuyruğu tüketicisiz).

## Bağlam

- 0177 ile ürün metin vektörleri üretimde (P1: 19.992 ürün, 816 bin token, 2,04 TL).
- 0170'in hibrit ölçümleri taslak/AI etiketli ve 200–15.000 ürünlük yerel kümelerde yapıldı;
  gerçek kullanıcı sorgularında anlamsal adayın sonucu ne kadar değiştireceği bilinmiyor.
- Sonucu doğrudan değiştirmek (pilotun hibrit sağlayıcısı) ölçülmemiş riski kullanıcıya taşır;
  önce sonucu değiştirmeden gerçek trafikte ölçmek gerekir.

## Karar

1. **Mod:** `SEMANTIC_SEARCH_MODE` = `off` (varsayılan; başka her değer) | `shadow`. Sonuca karışan
   `on` bu kararın kapsamında değildir; gölge ölçümden sonra ayrı kararla gelir.
2. **Yer:** `/sohbet` katalog araması (`searchByIntent`), yalnızca varsayılan "seçilen" sekmesi
   (`semanticShadow: true`). Arama sonucu hesaplandıktan sonra, veritabanı işleminin **dışında**,
   **beklenmeden** başlar; kullanıcıya dönen sonuç ve gecikme değişmez. Ölçüm betikleri ve sekme
   değişimi ölçüm tetiklemez.
3. **Akış** (`packages/core/src/search/semantic/shadow.ts`): örneklem → metin süzgeci
   (`queryContentIneligibility`; kişisel/özel nitelikli veri, kimlik/sır benzeri ifade
   **sağlayıcıya gitmez**) → günlük tavan (`api_usage` sayımı) → sorgu vektörü (Jina
   `jina-embeddings-v3`, `retrieval.query`, 1,5 sn, tek deneme, süreç LRU önbelleği) → bağımsız
   anlamsal adaylar (`product_text_embedding`, metin aramasıyla **aynı** süzgeçler, görünürlük ve
   başlık korumaları; `statement_timeout` 1,5 sn) → pilotun kapısı (0,30 / 0,12 / 48), aksesuar ve
   tür koruması, RRF ile "açık olsaydı" ilk N.
4. **Kayıt:** `semantic_shadow_event` (0108), arama başına bir satır, **yalnızca sayısal**:
   sonuç (`measured`/`no_vector`/`ineligible`/`capped`/`error`), gerekçe sınıfı, metin sonuç
   sayısı, vektörü olan metin sonucu, aday sayısı, en iyi benzerlik, kapıdan geçen, anlamsal-yalnız,
   gösterilen N içinde ortak ve yeni giren ürün, gecikmeler, önbellek isabeti. Sorgu metni, özeti,
   oturum/kullanıcı ve ürün kimliği **yoktur**. Saklama 90 gün.
5. **Maliyet ve yük:** her gerçek çağrı `api_usage`'a (`semantic_query_embedding`, önbellek isabeti
   `units = 0`); `SEMANTIC_SHADOW_DAILY_CAP` (varsayılan 2.000 gerçek çağrı/gün),
   `SEMANTIC_SHADOW_SAMPLE_PERCENT` (varsayılan 100), aynı anda en fazla iki ölçüm (bağlantı havuzu
   aramaya kalır). Sorgu başına ~18 token: 2.000 sorgu/gün ≈ 36 bin token ≈ 0,09 TL/gün (**tahmin**).
6. **Hata:** her hata yutulur ve yalnızca sınıf adıyla kaydedilir; ölçüm aramayı hiçbir koşulda
   bozmaz.
7. **Kimlik kuralı:** benzerlik ürün kimliği kanıtı değildir; gölge ölçüm eşleştirmeye, sıralamaya
   ya da `similarity_edge`'e yazmaz.

## Ölçüm planı

- Kapsam şu an P1 kümesi (~20 bin ürün): `text_with_vector / text_count` düşük kalır; anlamsal
  aday da yalnızca bu kümeden gelir. Katalog yayıldıkça aynı ölçü kendiliğinden büyür.
- İzlenecek: `new_in_top_n > 0` oranı (sonuç ne sıklıkla değişirdi), metin sonucu 0 iken
  `semantic_only > 0` oranı (sıfır sonuç kurtarma), `best_similarity` dağılımı (kapı kalibrasyonu),
  `embed_ms`/`knn_ms` p95 (açık modun gecikme bütçesi), `ineligible` oranı.
- `on` kararı için ek olarak insan etiketli değerlendirme gerekir (0170 §"Sonraki pilot", madde 4).

## Reddedilen alternatifler

- **Doğrudan hibrit (`on`):** ölçülmemiş etki kullanıcıya gider; geri alma görünür olur.
- **Sorgu metnini saklayıp çevrimdışı karşılaştırmak:** KVKK; analitik/log kişisel veri içermez kuralı.
- **`search_outbox` tüketicisi:** 0136 tüketicisiz; gölge ölçüm istek anında, tek satır.
- **Ölçümü istek içinde beklemek:** gecikme bütçesi `/sohbet` için zaten sıkı; gölge mod gecikme eklemez.
