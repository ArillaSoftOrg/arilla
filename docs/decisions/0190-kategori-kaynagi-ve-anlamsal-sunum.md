# 0190 — Kategori kaynağı sözleşmesi ve anlamsal sunum (varsayılan kapalı)

Durum: **kabul**. Migration yok. `SEMANTIC_SEARCH_MODE=on` olmadıkça arama sonucu değişmez.
Kategori kaynağı sözleşmesi bu PR ile canlıdır.
İlgili: 0066, 0171, 0178, 0181, 0189.

## Bağlam

- Kategori filtresinin **kaynağı yoktu**. Örneğin sohbette modelin tahmin ettiği kategori
  (`intent.category`) kesin filtre oluyordu. Bu filtre, kategorisiz ya da yanlış kategorideki
  ürünü dışlıyordu.
- Strateji seçici (0189) kaynağı bilmeden kullanılamıyordu.
- Anlamsal arama yalnız gölge kipindeydi. Gölge hataları sessizce yutuluyordu
  (`.catch(() => null)`).
- Üretim durumu (13 Kasım 2026, salt okunur):
  - 12,26 milyon ürünün 102.729'unda vektör var (%0,84).
  - `product_text_embedding` üzerinde HNSW yok.
  - Jina 403 dönüyor ("Insufficient balance").
  - Kategori sözlüğü (`lexicon.kind='category'`) boş. Sözlükte yalnız 1.108 eş anlamlı var.
  - Kategori filtresi bugün pratikte yalnız IntentV2 H kipinden geliyor. Bu kipteki 10 yolun
    hepsi katalogda mevcut.
  - 2.664.245 yayındaki ürün kategorisiz.

## Karar

### 1. Kategori kaynağı (`QueryFilters.category_source`, `category_hint`)

| Kaynak                   | Nereden                                                                   | Metin araması                                   | Anlamsal seçici | Kategorisiz ürün |
|--------------------------|---------------------------------------------------------------------------|-------------------------------------------------|-----------------|------------------|
| `explicit_ui`            | URL `kategori` (güvenli biçim + katalogda var)                            | Kesin; **gevşetilmez**                          | `explicit`      | Dışlanır         |
| `explicit_text_verified` | Sözlük ayrıştırıcısı, IntentV2 H, netleştirme derleyicisi                 | Kesin; üst kategoriye gevşer (0066)             | `explicit`      | Dışlanır         |
| `inferred`               | `category_hint`: model kategorisi (`intent.category`), IntentV2 R ipucu   | Yalnız sıralama (×1,15 dengeli skor); dışlamaz  | `inferred`      | Aday kalır       |
| `none`                   | —                                                                         | Kısıt yok                                       | Kategori yok    | Normal           |

- **Kaynağı yazılmamış `category_path` (`legacy`):**
  - Metin aramasında bugünkü gibi kesin filtredir (geriye uyum).
  - Anlamsal seçicide **açık sayılmaz** (`inferred`).
  - `RESOLVER_VERSION` 3→4: önbellek satırları bir kez yeniden ayrıştırılır ve kaynak yazılır.
- **Doğrulama (`prepareSearchFilters`):**
  - `explicit_text_verified` yol kategori ağacında yoksa ipucuna düşer. Böylece sıfır sonuç
    yerine sıralama sinyali olur.
  - Ağaç okunamazsa bugünkü davranış korunur.
- **URL değeri:**
  - Yalnız `[a-z0-9-/]` biçimi ve katalogda var olan yol kabul edilir. Diğer değerler yok sayılır.
  - Sayfalama, sekme ve konuşma bağlantıları değeri taşır.
- **Arayüz:** Bu turda kategori seçme bileşeni eklenmedi. Yalnız URL ve API sözleşmesi var.

### 2. Ortak arama alanı (`search-domain.ts`)

`/sohbet?q=` (eski `/ara` yüzeyi) ve sohbet (`searchByIntent`) aynı sırayı kullanır:

1. `prepareSearchFilters`
2. `searchWithFallback` (değişmedi)
3. `serveSemantic`

IntentV2 ve metin araması değişmedi. Misafir sohbeti yalnız metin araması kullanır; misafir için
ücretli çağrı yapılmaz.

### 3. Anlamsal sunum (`SEMANTIC_SEARCH_MODE=on`)

**Koşullar.** Her koşul ayrı denetlenir; biri tutmazsa sonuç metin aramasının **aynısıdır**
(aynı dizi):

1. Mod `on`.
2. Sayfa 1 ve `balanced` sekmesi.
3. Metin sonucu boş değil.
4. KVKK süzgeci.
5. Aktif indeks TS'de sorgulanabilir (0181).
6. Envanterde **hazır** ve model/boyut/sürüm uyumlu indeks.
7. Seçici `global_hnsw` ya da `exact_btree` döndürür.
8. Sağlayıcı sağlıklı. Anahtarın tanımlı olması yetmez:
   - 401/402/403 devreyi 15 dakika açar.
   - 429 devreyi 1 dakika açar.
   - Art arda 3 geçici hata devreyi 30 saniye açar.
9. Günlük tavan (`SEMANTIC_SERVING_DAILY_CAP`, varsayılan 5.000) aşılmamış.

**Ücretli çağrı.** Yalnız 1–9 tuttuktan sonra yapılır ve `api_usage`'a yazılır (kural 9).
Otomatik bakiye yükleme yoktur.

**`legacy_postfilter` istek yolunda hiç çalışmaz.** HNSW'siz global KNN tam taramadır:
102 bin satırda 32 ms, 12 milyonda saniyeler sürer. Kategori filtresiyle de eksik sonuç verir
(E3-d.1). Bugünkü üretimde HNSW yok. Bu yüzden mod açılsa bile filtresiz sorguda anlamsal aday
çalışmaz.

**İndeks envanteri.** Migration yok; envanter `pg_index`'ten okunur. Bir indeks şu koşulların
hepsini sağlamalıdır:

- `hnsw` yöntemi, `embedding` kolonu, `halfvec_cosine_ops` opclass.
- Kolon tipi `halfvec(<boyut>)`.
- Koşul **tam olarak** `model_version = '<model>'`.
- Adı `_v<N>` ile biter ve beklenen sürüme (`SEMANTIC_INDEX_VERSION`, varsayılan `1`) eşittir.
- `indisvalid && indisready && indislive`.

`btree_category` = `product(category_id)` üzerindeki tek kolonlu B-tree.

**Kategori istatistiği.** `cap + 1`'de kesilen sınırlı sayım (250 ms zaman aşımı, 10 dakika
önbellek). Tablo ya da toplu iş gerekmedi.

**SQL şablonları** (0189 yöntem (b): sabit şablon):

- `global_hnsw`:
  - `model_version` sabit metin olarak yazılır (dar desenle doğrulanır). Böylece kısmi HNSW genel
    planda da seçilir.
  - KNN penceresi ve `ef_search` = 150.
- `exact_btree`:
  - Kategori **parametredir**.
  - En fazla `exactMaxRows + 1` (2.001) vektör karşılaştırılır. Havuz taşarsa hata verilir;
    eksik sonuç döndürülmez.
- Kategori yolu iki şablonda da ayrıca güvenli biçimle doğrulanır, çünkü `LIKE` jokeri (`%`, `_`)
  parametre olarak da sızar. Entegrasyon testi bunu yakaladı.
- Kısmi kategori HNSW'si ve binary üretilmez. `product_text_embedding`'de kategori kolonu yok;
  eklemek migration ister.

**Füzyon.**

- `fuseForQuery` kullanılır (gölge ve çevrimdışı değerlendirmeyle aynı).
- Metin sonucu **hiç düşmez**. Tür uyuşmazlığıyla füzyondan çıkan ürün sona eklenir.
- En fazla 8 yalnız-anlamsal ürün eklenir. Bu ürünlerin kartı metin aramasının aynı süzgeciyle
  kurulur (fiyat, kategori, görünürlük): `cardsForProducts`.

**Hata ve geri alma.**

- Her hata yakalanır; sonuç metin aramasıdır.
- Yapısal günlük satırı (`semantic_serving`) yalnız sabit neden, strateji ve sayıları içerir.
  Sorgu metni, ürün kimliği ve anahtar içermez.
- Süreç içi sayaçlar tutulur.
- **Geri alma tek bayrakla yapılır:** `SEMANTIC_SEARCH_MODE=shadow` ya da `off`.

### 4. Gölge hataları

`record` hatası, `error` sonucu ve beklenmeyen hata artık `semantic_shadow_error` yapısal satırı
ve süreç içi sayaç üretir. Satır yalnız hata sınıfını içerir (`pg_42501`, `rangeerror`, …);
mesaj içermez.

## Ölçüm

Yerel ölçüm, ayrı geçici veritabanı, 102.729 sentetik halfvec(768) vektör (üretimdeki sayı):

- **Plan seçimi:**
  - Planlayıcı kısmi HNSW'yi `LIMIT 40/120/400` için seçti.
  - Küçük test tablosunda B-tree + Sort seçebilir. CI testi bu yüzden sorgu **biçimini**
    `enable_seqscan/enable_sort = off` ile denetler.
- **Gecikme:**

  | Sorgu                | p50     | p95     |
  |----------------------|---------|---------|
  | HNSW k150 / ef150    | 8,7 ms  | 14,0 ms |
  | HNSW k400 / ef400    | 19,8 ms | 25,5 ms |
  | HNSW'siz tam tarama  | 32 ms   | 38 ms   |

- **HNSW kurulumu:** seri, 114 saniye. Docker `/dev/shm` 64 MB olduğu için paralel kurulum
  başarısız oldu.
- **Kalite (Recall/NDCG) bu turda ölçülmedi:**
  - Sentetik vektörle anlamsız.
  - 528 etiket eksik.
  - Anlamsal kalite **doğrulanmış değildir**.

## Reddedilen

- **Kaynağı bilinmeyen yolu açık saymak:** Tahmin, kesin filtre gibi uygulanırdı.
- **HNSW yokken global tam taramayı istek yolunda çalıştırmak:** Kontrolsüz tarama olurdu ve
  eksik sonuç verirdi.
- **Envanter için yeni tablo ve migration:** `pg_index` yeterli ve tek doğruluk kaynağı.
- **Model adını parametre yapmak:** Genel planda kısmi HNSW kullanılamaz. Test bunu gösteriyor.
- **İkinci sayfada ya da fiyat sekmesinde füzyon:** Sayfalama ve fiyat sırası bozulurdu.

## Etkinleştirme önkoşulları (ayrı insan kararı)

1. Jina bakiyesi ya da başka sağlayıcı (kullanıcı kararı; otomatik yükleme yok).
2. Üretimde `CREATE INDEX CONCURRENTLY ... USING hnsw ... WHERE model_version = '<model>'`.
   - İndeks adı `_v1` ile biter.
   - Migration süreciyle ve kilit/yedek denetimiyle kurulur.
   - 102 bin satır için küçük. 12 milyonda RAM'e sığmaz (E3-b).
3. Gölge ölçümle eksik sonuç ve gecikme kontrolü. Ardından `SEMANTIC_SEARCH_MODE=on`.
