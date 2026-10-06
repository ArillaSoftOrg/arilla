# Katalog 120M ölçek mimari denetimi — REV 2 (+ Ek B: Rev 3 uygulama durumu)

**Tarih:** 2026-10-07 · **Dal:** `feature/catalog-120m-architecture` · **Durum:** TASLAK — onay bekliyor. **REV 2: §R, §7–§13 ve Ek A güncel; §1–§6 Rev 1 metnidir ve §R.1'deki durumlarla birlikte okunmalıdır (geçersiz kalan bulgular orada işaretli).**
Kod, şema, üretim DB'si değişmedi; commit/push yok. Bu belge bir karar değildir; kabul edilen
maddeler ayrı `docs/decisions/NNNN` dosyalarına dönüşür (bkz. §9).

Kapsam: `merchant → offer → offer_variant → price_point`, `embedding`, `match_candidate`,
`similarity_edge`, `product`, `ingest_run`, resolve/search/similarity/enrich boru hatları.
İncelenen kod: `docs/schema.sql`, `services/ingest/{collect,resolve,similarity,enrich}`,
`packages/core/src/search/*`, `docs/decisions/{0005,0015,0016,0030,0037,0059,0062}`, `docs/ops.md`.

> **Sınırlar.** (1) Üretim DB'sine bağlanmadım: gerçek satır sayısı, indeks boyutu,
> `pg_stat_user_indexes` kullanımı ölçülmedi — §6'daki her "kaldır" maddesi önce ölçüm ister.
> (2) Admitad'ın gerçek feed şekli bilinmiyor (0012: "Admitad'a henüz başvurulmadı"); §5'teki feed
> varsayımları tahmindir. (3) Fiyat rakamları (Supabase, OpenSearch, R2) kaba büyüklük sırasıdır,
> doğrulanmadı. (4) `docs/architecture.md` CLAUDE.md'de anılıyor ama depoda yok.

---

## R. REV 2 — Güncel kodla uzlaştırma (2026-10-07)

**Okunan kaynak:** `feature/shopify-canonical-domains` (`git fetch --all --prune` sonrası), commit `5a21615` (chunk'lı toplama, ADR 0065 + migration 0050) **ve** `6ab8da2` (`price_point` = değişim olayı, tazelik = `last_seen_at`). Yalnız okundu (`git show`/`git diff main...`); branch değiştirilmedi, o worktree'ye dokunulmadı, hiçbir şey çalıştırılmadı, üretim DB'sine bağlanılmadı. Yerel Docker PG'de yalnız geçici şemada EXPLAIN denendi (§10.1), silindi.

**Aşağıdaki tablo Rev 1 bulgularının güncel kodda durumunu verir. Rev 1 metni (§1–§6) tarihsel olarak korunur; çelişen yerde bu bölüm geçerlidir.**

### R.1 Rev 1 bulgusu → güncel durum

| Rev 1 | İddia | Güncel branch'te (koddan doğrulandı) | Durum |
| --- | --- | --- | --- |
| I1 | Tek işlem/koşu; hata = tüm iş kaybolur; resume yok | `collect/pipeline.py`: `CHUNK_OFFERS=100`, `flush()` her chunk'ta `_write_progress` + `conn.commit()` (chunk+checkpoint atomik); kesilirse `partial` + `checkpoint.resumable`; `_claim_resumable` (24 sa pencere); `--max-attempts 3`. Gerçek üretim kanıtı: 42 dk'da kopan koşu düzeldi | ✅ **GEÇERSİZ (çözülmüş)** |
| I4 | Satır satır SQL (teklif başına 2, varyant başına 5 ifade) | `writer.py`: `write_batch` `unnest` ile chunk başına ~9 ifade; varyantlar 2.000'lik dilimlerde | ✅ **GEÇERSİZ** — ama bkz. R.2: hız hâlâ RTT'ye bağlı |
| I3 | Her koşuda her offer için `price_point` | `dedupe_price_points=True` (toplu koşu): fiyat/liste/stok önceki satırla aynıysa satır yazılmaz; `price_point` = değişim olayı (0065, `6ab8da2`); okuyucular (`getPriceHistory`, `getVariantPriceHistory`, `product_price_stats`) buna taşındı | ✅ **GEÇERSİZ** (kullanıcı linki yolu hâlâ her çözümlemede nokta yazar — küçük hacim) |
| S8 | `product_price_stats` yüzdeliği gözlem sayısına dayalı; değişim-yalnız geçmişte bozulur | `similarity/prices.py`: süre-ağırlıklı, `carry_forward`, pencere öncesi son olay, `seen_until` | ✅ **GEÇERSİZ (çözülmüş)** |
| Madde "emsal: variant_price_event" | — | Hâlâ doğru; varyant fiyat/stok olayları değişim-yalnız | ✔ |
| I7 | Retry/backoff, dead-letter yok | Retry: koşu düzeyinde yeniden deneme (`--max-attempts`, 30 sn × deneme) **var**. Dead-letter/`ingest_reject` **yok**: reddedilen kayıtlarda yalnız 5 örnek `error_text`'e düşüyor | ⚠️ **KISMEN** |
| I8 | Merchant izolasyonu/çift koşu kilidi yok | `pg_try_advisory_lock(4301, merchant_id)`; ikinci koşu `refused:run_in_progress` | ✅ **GEÇERSİZ (çözülmüş)** |
| I5 | Bellekte `seen_offer_ids` + `ANY(list)` | `deactivate_missing` artık `last_seen_at < observed_at` (liste yok) — **çözüldü**. Ama `seen_external_ids` (feed içi tekrar) ve devralmada `_already_written` (tüm `external_id`'ler `set`) **hâlâ bellekte** | ⚠️ **KISMEN** |
| I2 | Her satır her koşuda UPDATE; HOT yok | `UPSERT_OFFERS` hâlâ tüm kolonları yazıyor, `last_seen_at` her seferinde; fp/değişim algılama **yok**; bu 0065'in bilinçli tazelik sözleşmesi | ❌ **GEÇERLİ** (120M'de kritik, §7.2) |
| I6 | `xml_feed` `BytesIO(response.content)` ile tüm dosyayı belleğe alıyor | `xml_feed.py:82` aynı; branch bu dosyayı değiştirmedi | ❌ **GEÇERLİ** |
| I9 | `full_dump` pasifleştirme sanity kapısı yok | Hâlâ yalnız `status == "success"`; oran/bütünlük kapısı yok | ❌ **GEÇERLİ** |
| I10 | "Gevşek `last_seen_at`" önerisi | `last_seen_at` artık tazelik + devam + pasifleştirme sözleşmesi → öneri **tek başına bozucu** | 🔁 **GERİ ÇEKİLDİ** (§10.3) |
| S1–S2, S5–S7, S9–S12 | Arama O(N), trigram GIN, OFFSET, aggregate, `build_edges` | Branch bunlara dokunmadı. `similarity/pipeline.py` yalnız fiyat geçmişi sorgusunu LATERAL'e çevirdi (S7 kısmen iyileşti) ama hâlâ tüm ürünler için tek sorgu, Python'da gruplama | ❌ **GEÇERLİ** |
| S3, S4 | Çözümleyici: tam-katalog trigram aday + offer başına ~8 sorgu, satır satır | `resolve/batch.py` (branch `2403ab4`, ADR 0066 → **0068'e yeniden numaralanacak**): chunk (≤200 offer, tek merchant), ~12 toplu okuma + ~8 toplu yazma/chunk, SAVEPOINT yalıtımı, `--limit` varsayılanı hepsi. **Ölçülen:** üretim north-sails 1.723 offer 2.557 sn → **32,1 sn** (≈0,67 → **≈54 offer/sn**); yerelde 17.835 → 164 ifade; eski sürümle birebir eşit sonuç testi var | ✅ **round-trip/satır-satır KISMEN ÇÖZÜLDÜ.** Hâlâ geçerli: aday üretimi tam-katalog trigram (ADR'ye göre sunucuda ~10–15 ms/offer; ~100k offer civarında ayrı iş) ve görsel ANN |
| §0/1 "toplama yolu 1–2M'de bile sorun" | — | Güncel: tek akışta günlük tam geçiş ~3M offer'a kadar mümkün (uzak, 32/sn × 86.400); asıl sınır **çözümleyici 0,67 offer/sn** | ♻️ **GÜNCELLENDİ** (§7.3) |
| §4.3 / §6.2 "çift indeksi şimdi kaldır" | PK ile aynı kolonlar → gereksiz | DESC indeksi kodda adıyla anılıyor; sorgu şekilleri karma sıralı; deney eşdeğer plan gösterdi ama üretim telemetrisi yok | 🔁 **GERİ ÇEKİLDİ** (§10.1) |
| §4.2 `ingest_batch` | Yeni checkpoint tablosu | `ingest_run.checkpoint` JSONB + `updated_at` bunu kapsıyor | ❌ **GEREKSİZ** (§10.4) |
| §4.1 "`is_active` + `lifecycle` + `last_run_id` ekle" | — | `last_seen_at`+`is_active` sözleşmesi çalışıyor | ⏸ **ERTELENDİ** (§10.3) |

### R.2 Yeni kodun hâlâ sınırlı olduğu yerler (ölçülmüş/okunmuş)

* **Hız RTT'ye bağlı:** chunk=100 ve ~9 ifade → uzak Supabase'de ≈ 32 offer/sn ölçüldü. Günlük tam geçiş uzak/chunk-100 ile ~2,8M offer/gün'ü aşamaz. Bu bir hata değil, Shopify HTTP sayfa boyuna göre bilinçli ayar; dosya-tabanlı kaynakta parça boyu ve işçi konumu ayrı ayarlanmalı (B5).
* **Offer/varyant satırı her koşuda yeniden yazılıyor** (0065 sözleşmesi). 120M'de ~130–180 GB/gün ölü heap + WAL (§7.2).
* **Devam yeniden-akıtma ile:** kaynak baştan akıtılıp `last_seen_at = observed_at` olanlar atlanıyor; offer sayısı kadar bellek (`set`).
* **Çözümleyici (güncel):** toplu motor ile ≈54 offer/sn ölçüldü (eski ≈0,67). Aday üretimi hâlâ tam-katalog trigram/ANN; ADR kendisi ~100k offer'da ayrı iş diyor. Zincirin kritik halkası olmaya devam ediyor (§7.3).
* **Branch ve main birbirinden ayrık:** 0050 migration'ı ve ADR 0064/0065 numaraları çakışıyor (§9).

### R.3 Rev 2'nin kararları (özet)

1. 120M = kaynak offer; kanonik ürün 120M/60M/30M senaryolarıyla modellendi (§7).
2. Supabase auth/kullanıcı/rıza/admin/merchant metaverisi için kalır; katalog bugün taşınmaz, ayrılabilir sınırlarla (§13).
3. Görsel: DB'ye binary/base64 yok; kaynak URL tutulur; R2 yalnız mirror/cache; **tembel, popülerlik-tabanlı** (B12); 120M görsel baştan indirilmez.
4. Gemini: çevrimdışı-yalnız bugün korunur; eşzamanlı seçici çağrı **ancak** CLAUDE.md kural 1 + yeni ADR + KVKK değişikliğiyle (§8).
5. Admitad: şema tahmin edilmez; adaptör/eşleme katmanı; örnek feed bekleniyor (§12).
6. Hazırlık paketi: A grubu **şema değişikliği içermez** (§11).

---

## 0. (Rev 1) Önce bilinmesi gereken üç şey — ⚠️ madde 1 Rev 2'de kısmen geçersiz, bkz. §R.1

1. **Bugünkü toplama yolu 120M'de çalışmaz; ~1–2M offer'da bile sorun çıkarır.** Tek işlemde
   satır satır yazar, her koşuda her satırı yeniden yazar, her koşuda her offer için `price_point`
   ekler, bellekte `set` tutar. (§2)
2. **Arama istek yolu katalog boyuyla O(N) çalışır.** `bestOfferCte` tüm aktif offer'ları
   `DISTINCT ON` ile tarar; çözümleyici `product.title %% ...` ile tüm ürün başlıklarında trigram
   arar. 4,5 bin üründe 20 ms olan şey 120M'de dakikalar sürer. (§3)
3. **Önerdiğim hedef mimari CLAUDE.md'nin bazı satırlarıyla çakışıyor.** Kod yazılmadan önce
   CLAUDE.md güncellenmeli (kuralın kendi şartı). Liste §9'da. Ayrıca ikinci istekteki
   "Gemini istek yolunda" akışı kural 1 ve karar 0059 ile çelişiyor (§8).

---

## 1. Bugünkü durum — kısa envanter

| Alan | Bugün | 120M'de sorun |
| --- | --- | --- |
| `offer` | bigint PK, `(merchant_id, external_id)` unique, 4 kısmi indeks, `attributes_raw jsonb`, `image_hash text` (64 hex), `url`, `image_url`, `title_raw` | Satır ~0,9 KB + indeks ~0,23 KB; jsonb ve hex hash gereksiz yer kaplar; gtin/mpn/marka **skaler kolon değil** (jsonb/ham metin) → set-tabanlı eşleme yok |
| `offer_variant` | offer'a `ON DELETE CASCADE`, 2 olay tablosu (`variant_stock_event`, `variant_price_event`) | Varyant başına 4 round-trip; değişim denetimi için son fiyat sorgusu; offer silme = kaskad |
| `price_point` | Aylık RANGE partition, PK `(offer_id, observed_at)` **ve** aynı kolonlarda ikinci indeks | **Her koşuda her offer için satır** (writer.py: "fiyat değişmese bile yazılır"). İndeks çift |
| `embedding` | polimorfik (FK yok), `vector(768)` fp32, HNSW kısmi (`target_type='offer'`), offer başına 1 satır | ~7 KB/offer; Jina ölçümü 15–20 görsel/dk |
| `similarity_edge` | ürün çifti, iki yönlü, TOP_N=8 × 2 tür | `build_edges` **tüm vektörleri Python belleğine yükler** |
| `ingest_run` | koşu başına 1 satır, tek işlem | checkpoint/resume yok; hata → tüm koşu geri alınır |
| Arama | PG: trigram GIN ×2, `DISTINCT ON` best_offer, `OFFSET` sayfalama | O(N) |
| Redis | rate limit, sayaç, link çözümleme | truth store değil — doğru; kuyruk tasarımı henüz yok |
| R2 | yalnız medya (0062, içerik-adresli) | ham feed arşivi yok |
| Bağlantı | Supabase pooler (6543), `statement_timeout` yalnız admin sorgularında | toplu işlerde süre sınırı/ayrı rol yok |

---

## 2. Toplama (ingest) bulguları — ⚠️ Rev 1; I1, I3, I4, I8 çözülmüş, I5/I7 kısmen: bkz. §R.1

Dosya: `services/ingest/collect/{pipeline,writer}.py`, `sources/xml_feed.py`.

| # | Bulgu | Etki | Önerilen çözüm |
| --- | --- | --- | --- |
| I1 | **Tek işlem / koşu.** `run_ingest` bir `conn.commit()` ile bitirir; hata → `rollback`, tüm iş kaybolur | 10M offer'lık feed = saatlerce açık işlem: xmin ufku vacuum'u bloklar, WAL şişer, kesilen feed hiçbir şey bırakmaz, resume yok | Parça (chunk) başına commit; `ingest_run` altında `ingest_batch` checkpoint satırı `(run_id, batch_no, cursor, status)`. Yarım koşu **canlı kataloğu bozmaz** çünkü satır-düzeyi upsert idempotent ve pasifleştirme yalnız TAM koşuda |
| I2 | **Her satır her koşuda UPDATE.** `UPSERT_OFFER` tüm kolonları yazar, `last_seen_at` her seferinde değişir | Her koşuda 120M yeni tuple (≈108 GB ölü heap, ≈130 GB WAL/gün), HOT yok (fillfactor 100, `current_price` indeksli) | `offer_fp`/`content_fp` parmak izi; `ON CONFLICT DO UPDATE ... WHERE offer.offer_fp IS DISTINCT FROM EXCLUDED.offer_fp`. Değişmeyen satır **hiç yazılmaz** |
| I3 | ~~**`price_point` her koşuda her offer için.**~~ ÇÖZÜLDÜ (§R.1). Eski bulgu: Yorum: "sürekliliğin kendisi veridir" | 1×/gün: 120M satır/gün, 17 GB/gün, 6,3 TB/yıl. 4×/gün (`refresh_minutes=360`): 25 TB/yıl | Yalnız değişimde yaz (§4). `variant_price_event` zaten böyle (0037) — emsal var |
| I4 | **Satır satır SQL.** offer upsert + (varyant başına SELECT, UPSERT, son fiyat SELECT, olay INSERT) | ~300–800 satır/sn/bağlantı → 120M = ~67 saat/geçiş. Günlük geçiş mümkün değil | `COPY` → `UNLOGGED` stage tablo → tek set-tabanlı `INSERT ... ON CONFLICT ... WHERE fp farklı`. Hedef ≥ 5 000 satır/sn toplam |
| I5 | **`seen_external_ids` ve `seen_offer_ids` bellekte `set`.** `deactivate_missing` `id = ANY(list)` | 120M elemanlı dizi: bellek patlar, sorgu parametresi sınırı aşılır | Koşu damgası: stage'e yazılan anahtarlarla anti-join, ya da `offer.last_run_id`. `ANY(list)` yok |
| I6 | **`xml_feed._open`: `io.BytesIO(response.content)`.** "Akıtılıyor" yazar ama dosya önce **tamamen belleğe** iner | Çok GB'lık Admitad XML = OOM | `httpx.stream` → diske/R2'ye yaz → dosyadan `iterparse`. Aynı dosya R2 staging'e gider (§5) |
| I7 | **Retry/backoff, dead-letter yok.** Reddedilen kayıt sayılır, yalnız 5 örnek `error_text`'e girer | Hangi kaydın neden reddedildiği sonradan görülemez; kaynak izolasyonu zayıf | `ingest_reject` (run_id, source_ref, kod, kısa özet; aylık partition, 30 gün) + R2'de `rejects/` Parquet. Bağlantı/5xx için üstel geri çekilme, parça başına en çok N deneme |
| I8 | **Merchant izolasyonu yalnız `--merchant` CLI.** Eşzamanlı iki koşu için kilit yok | Aynı merchant'a çift koşu çakışır | `pg_advisory_lock(merchant_id)` ya da `merchant.ingest_lease_until` |
| I9 | **Tam dokümda yarım feed riski.** `full_dump` + `success` → pasifleştir. Ama "success" = hata yok, "feed eksiksiz" değil | Admitad CDN'i yarım dosya verirse (HTTP 200, kısa içerik) katalog sessizce kapanır | Pasifleştirme için **sanity kapısı**: `seen / önceki_tam_koşu ≥ eşik` (öneri %70) ve içerik uzunluğu/`</channel>` kapanış doğrulaması; geçmezse koşu `partial`, pasifleştirme yok |
| I10 | `offer.last_seen_at` her satırda güncelleniyor | Bkz. I2 | Gevşek `last_seen_at`: yalnız eskiyse (>7 gün) ya da durum değiştiğinde yaz; canlılık kanıtı snapshot kaydıdır (§4) |

**Parmak izi tasarımı.** İki 64-bit hash (xxh3/blake2b-8):

* `content_fp` = norm(title, brand, category, url, image_url, gtin, mpn, seçilmiş öznitelikler) — nadir değişir (~%0,5/gün).
* `offer_fp` = (price, list_price, currency, in_stock, shipping_*) — sık değişir (~%3–5/gün varsayım).

İki ayrı hash, fiyat güncellemesinin içerik yeniden işlemesini (resolve/embedding/arama dokümanı) tetiklemesini önler.
Normalizasyon `normalize.py`'nin çıktısı üzerinde hesaplanır (kaynağın ham baytı değil) — kaynak biçim değişse de anlam aynıysa hash aynı kalır; hash sürümü (`fp_version`) tutulur, normalizasyon değişince toplu yeniden hesaplama bilinçli olur.

---

## 3. Arama, çözümleme ve benzerlik bulguları — S8 çözülmüş (§R.1), diğerleri geçerli

| # | Bulgu | Neden 120M'de çöker | Çözüm |
| --- | --- | --- | --- |
| S1 | `bestOfferCte`: tüm aktif `offer` × `merchant`, `DISTINCT ON (product_id)` sırala | O(offer); ürün ön filtresi içeri itilemez | `product.best_offer_id` + `min_price` toplu işle tutulur (zaten `min_price` var). İstek yalnız ürün satırını okur |
| S2 | `product_title_trgm` + `product_title_fold_trgm` (GIN, 72M başlık) | İki GIN ≈ 2×~150 B/ürün (~21 GB), yazma yavaş, ortak kelimelerde aday patlar | Kullanıcı araması arama motoruna taşınır (§6.4); PG'den bu iki indeks Faz C'de kaldırılır. Yönetim/dahili arama için küçük yedek (ör. yalnız `brand_id`+prefix) |
| S3 | ~~Çözümleyici `BY_TRIGRAM` (tam `product`)~~ **KISMEN:** toplu motor tek sorguda ama hâlâ tam-katalog trigram | Her chunk için katalogda benzerlik; ~10–15 ms/offer (ADR 0068) | Deterministik blocking (§5.5); trigram yalnız blok içi |
| S4 | ~~Çözümleyici offer başına ~8 sorgu~~ **ÇÖZÜLDÜ** (chunk başına ~20 ifade, `resolve/batch.py`) | — | — |
| S5 | `OFFSET` — `search.ts:106,146`, admin listeleri | Derin sayfada O(offset) | Arama: `search_after`/imleç (motor tarafı). Admin: keyset `(created_at, id)`; admin liste sayfaları 120M'de zaten özet sayaç göstermeli (`COUNT(*)` yok) |
| S6 | `refresh_product_aggregates`: tüm `product ⟕ offer` GROUP BY, her gece | Tam tarama (72M × ...) | "Kirli ürün" kümesi (`product_dirty`) — yalnız offer fiyat/stok/aktiflik değişen ürünler yeniden hesaplanır |
| S7 | `PRICE_HISTORY`: 90 günlük tüm `price_point` + Python'da gruplama | Bellekte 100 M+ gözlem | Yalnız kirli ürünler, SQL'de pencere fonksiyonu; sonuç `product_price_stats`'a |
| S8 | **Yüzdelik hesabı gözlem sayısına dayalı** (`_percentile_of`) | Değişim-yalnız geçmişe geçince "gözlemlerin %'si" anlam değiştirir (sık değişen ürün ağırlık kazanır) | `compute` **zaman-ağırlıklı** (adım fonksiyonu) yeniden yazılmalı. Sahte indirim tespiti (`detect_inflated_list_price`) değişim dizisiyle zaten çalışır |
| S9 | `build_edges`: tüm vektörler Python sözlüğüne | 3,6M vektör × 768 × ~32 B ≈ 88 GB RAM; ~200–500 bin vektörde zaten sorun | Yalnız "baş" ürünler (embedding'i olan ve popüler) için; sunucu tarafı ANN, iş parça parça. Kuyruk ürünleri için kenar tablosu yok |
| S10 | `similarity_edge` tüm ürünler × 32 kenar | ≈ 346 GB (72M ürün) | Yalnız baş %5 → ≈ 9 GB. Kuyruğa arama motorunun kNN'i (§6.4) |
| S11 | `embedding` offer başına, fp32 768 | Hepsi: 840 GB; Jina hızı 9 yıl (§7) | Kademeli embedding (§6.5) |
| S12 | `create_from_offer`: eşleşmeyen her offer yeni `product` açar (0017) | Ürün sayısı ≈ offer sayısı; arama dokümanı ve slug sayısı katlanır | Karar korunur ama "tekil/long-tail ürün" için `product.kind` (`canonical`/`singleton`) düşünülmeli; `unique_slug` döngüsü (SELECT ile çakışma) → slug'ı `id` ile türet |

---

## 4. Veri modeli: hedef şema önerisi

**İlke:** PostgreSQL = *güncel operasyonel doğruluk*. Ham yük, uzun geçmiş ve arama indeksi dışarıda.

### 4.1 `offer` — hedef kolonlar (mevcut kolonlar silinmez; eklenir, sonra eski kaldırılır — kural 14)

```sql
-- EKLENECEK (hepsi NULLABLE ya da DEFAULT'lu; tek adımda güvenli)
ALTER TABLE offer
  ADD COLUMN brand_id       bigint REFERENCES brand(id),   -- resolve'da set-tabanlı JOIN
  ADD COLUMN gtin           text,                          -- jsonb'dan çıkarıldı
  ADD COLUMN mpn_norm       text,
  ADD COLUMN content_fp     bigint,
  ADD COLUMN offer_fp       bigint,
  ADD COLUMN fp_version     smallint,
  ADD COLUMN last_run_id    bigint,                        -- son tam koşu (ingest_run.id)
  ADD COLUMN lifecycle      smallint NOT NULL DEFAULT 1,   -- 1 active, 2 stale, 3 tombstone
  ADD COLUMN inactive_at    timestamptz,
  ADD COLUMN image_key      bytea;                         -- 16 B hash, text(64)'ün yerine
ALTER TABLE offer SET (fillfactor = 85);                   -- HOT güncelleme için yer
```

* `attributes_raw jsonb` → **kaldırılacak**; ham yük R2'de (`raw_ref`: parquet dosya + satır grubu/ofset). Çözümleme/arama için gereken az sayıda alan (renk, beden grubu, gtin, mpn, ürün tipi) skaler.
  Mevcut yazma kodu `attributes_raw`'a `gtin`, `gtin_source`, `identifiers_checked_at` ekliyor/koruyor (writer.py:57–67) — bu üçü skalere taşınır, geri kalan jsonb düşer. Eski kolon, kod dağıtımından sonra ayrı migration'da silinir.
* `image_hash text` (64 hex = ~68 B) → `image_key bytea(16)`; `offer_image_hash_idx` ~95 B → ~35 B/satır.
* `lifecycle`: `active → stale (N koşu görünmedi) → tombstone (inactive_at)`. Offer'lar **asla DELETE edilmez** (FK'ler zaten engelliyor: `price_point`, `click`, `match_candidate` → `offer`). Tombstone satırlar arama/ürün hesabından çıkar, geçmiş korunur.
* `is_active boolean` yaşam döngüsü dönemi boyunca `lifecycle = 1` ile aynı tutulur (geriye uyum), sonra kaldırılır.

### 4.2 Yeni tablolar

```sql
-- Koşu başına beklenen/alınan snapshot: canlılık ve "değişmedi" kanıtı.
-- Fiyat satırının yokluğu "fiyat değişmedi" demektir ancak bunu kanıtlayan snapshot kaydıdır.
CREATE TABLE source_snapshot (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  merchant_id    bigint NOT NULL REFERENCES merchant(id),
  ingest_run_id  bigint REFERENCES ingest_run(id),
  raw_uri        text   NOT NULL,          -- r2://...
  raw_sha256     bytea  NOT NULL,
  bytes          bigint, record_count bigint,
  is_complete    boolean NOT NULL DEFAULT false,   -- sanity kapısı geçti mi
  fetched_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, raw_sha256)         -- aynı dosya iki kez işlenmez
);

CREATE TABLE ingest_batch (                -- checkpoint
  ingest_run_id bigint NOT NULL REFERENCES ingest_run(id),
  batch_no      integer NOT NULL,
  cursor_value  text,                      -- dosya ofseti / son external_id
  status        text NOT NULL CHECK (status IN ('pending','done','failed')),
  attempts      smallint NOT NULL DEFAULT 0,
  rows_in int, rows_changed int, rows_rejected int,
  PRIMARY KEY (ingest_run_id, batch_no)
);

-- Deterministik blocking için tek arama noktası (gtin/mpn/model_key indekslerinin yerine).
CREATE TABLE product_identity (
  key_type   smallint NOT NULL,            -- 1 gtin, 2 brand+mpn, 3 brand+model_key+color
  key_value  text     NOT NULL,
  product_id bigint   NOT NULL REFERENCES product(id),
  PRIMARY KEY (key_type, key_value, product_id)
);

-- Kirli ürün kümesi: toplu işler tam tarama yerine yalnız bunu işler.
CREATE TABLE product_dirty (
  product_id bigint PRIMARY KEY, marked_at timestamptz NOT NULL DEFAULT now()
);

-- Medya (§6.7)
CREATE TABLE media_asset (
  image_key  bytea PRIMARY KEY,            -- sha256(kaynak URL normalize) ilk 16 B
  source_url text NOT NULL,
  r2_key     text,                         -- NULL = henüz mirror yok
  content_sha256 bytea, width int, height int,
  state      smallint NOT NULL DEFAULT 0,  -- 0 referans, 1 kuyrukta, 2 mirror, 3 başarısız
  first_ref_at timestamptz NOT NULL DEFAULT now(), last_ref_at timestamptz,
  fail_count smallint NOT NULL DEFAULT 0
);
```

`product_identity` için tek-yön: ürün oluşurken yazılır; offer eşleştirmesi tek `JOIN`.
`media_asset` aynı görseli kullanan çok offer için satır paylaşır (bugün her offer kendi `image_url`/`image_hash` kopyasını taşıyor).

### 4.3 Geçmiş: `price_point` değişim-yalnız

* Yalnız `offer_fp` fiyat/stok bileşeni değiştiğinde yaz; ilk görülmede yaz.
* **İlk satır anlamı değişir:** "bu fiyat şu andan itibaren geçerli". Süreklilik/boşluk tespiti `source_snapshot`'tan (offer o snapshot'ta görüldü mü) — satır yokluğu artık veri kaybı değil.
* ~~`price_point_offer_time_idx` PK ile aynı kolonlar → gereksiz~~ **REV 2: GERİ ÇEKİLDİ.** İkinci indeks `(offer_id, observed_at DESC)` ve kodda adıyla kullanılıyor; karma sıralı sorgular var. Bkz. §10.1 (deney + telemetri şartı).
* `variant_stock_event` / `variant_price_event`: aynı kalır; `offer_variant`'a `effective_price` eklenir → "son fiyat SELECT'i" gider.
* CLAUDE.md kural 4 ile uyum: yalnız INSERT kalır. **Çakışma noktası:** eski partition'ların R2'ye arşivlenip `DETACH`/`DROP` edilmesi DELETE değil DDL ama niyet olarak "silme". ADR gerekir (§9).

### 4.4 ID stratejisi

* **Bigint kalsın.** Dahili tüm tablolarda 8 B; UUID 16 B + rastgele btree yerleşimi (yazma amplifikasyonu, önbellek verimsizliği). `int4`'e inmek hizalama dolgusu yüzünden satır başına çoğunlukla bir şey kazandırmaz ve 2,1 milyar sınırı riskli: **yapılmaz**.
* `product.public_id uuid` (UNIQUE) **korunur** (dış kimlik). Yeni satırlar için `uuid_generate_v4()` yerine zaman-sıralı UUIDv7 (uygulama tarafında üretilir) düşünülebilir: 72M satırlık rastgele UUID indeksi (~3 GB) ekleme hatlarını kirletir. Düşük öncelik, geriye uyumlu (kolon aynı).
* `offer`, `variant`, olay tablolarında public kimlik **yok**; tıklama/ekran yolu `offer_id` bigint'i dışarı sızdırmamalı (mevcut davranış korunur).

---

## 5. Hedef veri akışı ve "hangi veri nerede" cevabı

```
Admitad (feed/API)
  │  httpx.stream, ETag/If-Modified-Since, sha256
  ▼
[1] R2 staging  r2://raw/admitad/<merchant>/<yyyy>/<mm>/<dd>/<run>.xml.gz   ← DEĞİŞMEZ
  │   + source_snapshot satırı (sha256 aynıysa iş biter)
  ▼
[2] Doğrulama   şema/alan, para birimi, fiyat aralığı, sanity kapısı (I9)
  │   reddedilenler → ingest_reject + R2 rejects/
  ▼
[3] Normalizasyon → Parquet (zstd) parçaları: r2://norm/<merchant>/<run>/part-0001.parquet
  │   her satır: external_id, content_fp, offer_fp, skaler alanlar
  ▼
[4] Değişim tespiti   önceki snapshot'ın (external_id, fp) Parquet'i ile sıralı birleştirme
  │   (Faz B: PG'de kapsayıcı indeksle okuma; Faz C: DuckDB/Polars ile PG'siz fark)
  ▼   yalnız değişen/yeni/kaybolan satırlar PG'ye
[5] PostgreSQL güncel durum (COPY → stage → set-tabanlı upsert, parça başına commit)
  │   offer, offer_variant, (fiyat/stok değişince) price_point/variant_*_event, product_dirty
  ▼
[6] Kanonik çözümleyici (küme-tabanlı blocking)  → product / product_identity / match_candidate
  ▼
[7] Arama indeksleme   outbox: değişen product_id'ler → indeksleyici → OpenSearch (versiyonlu indeks)
  ▼
[8] Geçmiş/analitik    price_point (PG, son 90–180 gün) → aylık Parquet → R2 (uzun dönem)
  ▼
[9] Medya mirroring    popülerlik sinyali → kuyruk → R2 (yalnız talep edilenler)
```

### "120M Admitad kaydı geldiğinde hangi veri hangi sistemde yaşar?"

| Veri | Yaşadığı yer | Neden / not |
| --- | --- | --- |
| Ham feed baytı (XML/CSV/JSON) | **R2** `raw/` — gzip, 7 gün sıcak, sonra Parquet'e dönüşmüş haliyle | PG'ye yığılmaz; yeniden işleme/denetim için |
| Normalize edilmiş satır (tam) | **R2 Parquet+zstd** `norm/` — haftalık tam, günlük delta | Fark hesabı ve yeniden oynatma |
| Güncel offer durumu (fiyat, stok, url, skaler öznitelik, fp, yaşam döngüsü) | **PostgreSQL** `offer` | İstek yolu ve tıklama atfı buradan |
| Offer'a ait büyük/serbest öznitelikler, açıklama | **R2** (`raw_ref` ile bağlı) | jsonb PG'de bırakılmaz |
| Kanonik ürün, marka, kategori, kimlik anahtarları | **PostgreSQL** | Küçük, ilişkisel, bütünlük gerekir |
| Eşleştirme adayları, insan kararları | **PostgreSQL** (`match_candidate`) | Küçük hacim, denetim |
| Fiyat/stok **değişim** olayları — son 90–180 gün | **PostgreSQL** aylık partition | Fiyat grafiği, `product_price_stats` |
| Fiyat/stok olayları — daha eski | **R2 Parquet** (aylık), gerekirse sonra ClickHouse | Kural 4 + ADR: önce arşiv doğrulanır, sonra partition düşer |
| Kullanıcı araması için doküman (ürün başına) | **OpenSearch** (türetilmiş; PG'den yeniden kurulabilir) | Truth değil; alias+versiyon |
| Arama facet/sıralama girdileri (min fiyat, offer sayısı, satıcı güveni, popülerlik) | PG'de hesaplanır, outbox ile indekse gider | Hesap tek yerde (core), indeks yalnız taşır |
| Embedding (kademeli: baş %5 ya da talep edilenler) | **PostgreSQL/pgvector** (halfvec, kısmi HNSW) | Hedef ≤ ~10M vektör; üstü ayrıca konuşulur |
| `similarity_edge` | **PostgreSQL**, yalnız baş ürünler | Kuyruk: arama motorunun kNN'i / metin benzerliği |
| `query_resolution`, `query_interpretation`, `search_query_day` | PostgreSQL (mevcut, küçük) | Değişmez |
| Ürün görseli | Kaynak URL **PG** (`media_asset`); mirror **R2**; CDN önde | Yalnız talep edilen görsel mirror edilir (§6.7) |
| Rate limit, sayaç, oturum, kuyruk mesajı, kısa ömürlü önbellek | **Redis** | Truth değil; kaybolursa PG'den kurulur |
| Tıklama, dönüşüm, attribution | PostgreSQL (`click`, `conversion`) | Kural 8; hacim ayrı hesaplanır (§7) |

### 5.5 Eşleştirme: pairwise yok, deterministik blocking

Katman sırası (ilk eşleşmede durur; yalnız kalan kümeye bir sonraki katman uygulanır):

1. **GTIN/EAN (GS1 kontrol basamağı geçerli)** — `offer.gtin ⨝ product_identity(key_type=1)`. Mevcut `collect/identifiers.py` doğrulaması yeniden kullanılır.
2. **Marka + MPN** (norm) — `product_identity(key_type=2)`.
3. **Marka + model anahtarı + renk** — `model_key`/`color` (0005 renk düzeyinde kanonik kuralı korunur).
4. **SKU/vendor** — yalnız aynı merchant içinde (aynı SKU farklı mağazada kimlik sayılmaz).
5. **Blok içi benzerlik**: blok = (`brand_id`, `category_id`) (ya da marka bilinmiyorsa kategori + ilk anlamlı token); blok boyutu üst sınırlı (ör. 5 000). **Yalnız bu bloktaki** adaylar üzerinde trigram/embedding. Blok sınırı aşılırsa blok bölünür (renk, hacim) ya da `pending`'e düşer — asla tam katalog taraması yok.
6. Eşiği geçmeyen → yeni `product` (bugünkü 0017 davranışı).

Mevcut regresyon seti (CLAUDE.md: "eşleştirme için zorunlu") bu yeniden yazımda **önce** çalıştırılmalı; eşik/blok değişimi eski kararları bozuyorsa görünür olmalı. Skor/veto mantığı (`resolve/score.py`) aynen kalır; yalnız **aday üretimi** değişir.

---

## 6. Bileşen kararları

### 6.1 Partitioning karşılaştırması

| Tablo | Seçenek | Artı | Eksi | Karar |
| --- | --- | --- | --- | --- |
| `offer` | Bölme yok, fillfactor 85, ince satır | FK'ler (`click`, `price_point`, `match_candidate`…) değişmez; ~70 GB heap+idx, PG için sorun değil | Vakum/indeks inşası daha uzun | **Faz B: bölme yok** |
| `offer` | `HASH(merchant_id)` | Merchant başına izolasyon/detach | PK'ya `merchant_id` girer → **tüm FK'ler bileşik olur**; büyük merchant'larda çarpıklık | Reddedildi |
| `offer` | `HASH(id)`, benzersizlik `offer_source_key(merchant_id, external_id)` tablosunda | FK'ler `offer(id)`'ye aynı kalır; paralel vakum | `(merchant_id, external_id)` unique PG'de zorlanamaz → ayrı tablo; büyük yeniden yazım | **Faz C, yalnız ölçüm gerekirse** |
| `offer_variant` | offer'ı izler | — | — | offer ile birlikte |
| `price_point` | Aylık RANGE (mevcut) | Zaten var; arşiv için doğal | Aylık parça ~0,5–1 GB (değişim-yalnız) — küçük | **Koru**; gerekmedikçe günlüğe inme |
| `variant_*_event` | Aylık RANGE | Aynı | — | Faz B'de aylık partition'a çevir (mevcut tablolar bölünmemiş; yeni tabloya taşıma migration'ı) |
| `ingest_batch/reject` | Aylık RANGE, `DROP PARTITION` ile saklama | DELETE yok, şişme yok | — | Baştan bölünmüş oluşturulur |
| `embedding` | `LIST(model_version)` ya da `(target_type, model_version)` | Eski model = partition düşür; HNSW küçülür | Polimorfik hedef yapısı (0020) etkilenir | Faz B, embedding yeniden tasarımıyla |

**FK cascade / büyük DELETE riski.** `offer_variant`, `variant_*_event` `ON DELETE CASCADE`; `embedding`/`generated_content` silme tetikleyicileri (0014) satır başına çalışır. Bir merchant'ı kaldırmak = milyonlarca tetikleyici + kaskad + vakum yükü. Kural: **büyük DELETE yok** — offer'lar tombstone; kaldırma gerekirse `ingest` parça başına sınırlı `DELETE ... WHERE ctid IN (SELECT ... LIMIT 5000)` döngüsü ve `lock_timeout`; geçmiş (`price_point`) zaten engelliyor.

### 6.2 İndeks envanteri (satır başına kaba maliyet, ölçüm şart)

| İndeks | Boyut/satır | 120M'de | Öneri |
| --- | --- | --- | --- |
| `offer` PK | ~27 B | 3,2 GB | Kalır |
| `offer_merchant_external_uniq` | ~48 B | 5,8 GB | Kalır; `INCLUDE (offer_fp, content_fp)` ile **kapsayıcı** — değişim tespiti index-only |
| `offer_product_idx` (kısmi) | ~27 B | 3,2 GB | Kalır (resolve/best offer) |
| `offer_unmatched_idx` | küçük (yalnız `product_id IS NULL`) | — | Kalır; set-tabanlı çözümleyici bunu kullanır |
| `offer_image_hash_idx` (64 hex) | ~95 B | 11,4 GB | `image_key bytea(16)` + kısmi → ~4 GB; **ya da** `media_asset`'e taşı ve kaldır |
| `offer_active_price_idx` `(current_price) WHERE is_active AND in_stock` | ~27 B | 3,2 GB | **Muhtemelen kullanılmıyor** (arama `best_offer`'da `product_id` sırası); `pg_stat_user_indexes.idx_scan` ile doğrula, sıfırsa kaldır |
| `product_title_trgm` + `product_title_fold_trgm` | ~2×150 B | ~21 GB (72M ürün) | Faz C: arama motoru devralınca kaldır. Faz B'de **yalnızca fold olan** kalsın |
| `product_gtin_idx`, `product_model_key_idx` | ~30–40 B | ~5 GB | `product_identity` devralır; Faz B sonunda kaldır |
| `product_min_price_idx` | 27 B | 2 GB | Arama motoru filtreler; Faz C'de kaldır |
| `product_brand_idx`, `product_category_idx` | 27 B | 4 GB | Kalır (admin/dahili); izleyip karar |
| `price_point_offer_time_idx` | ~40 B | — | **REV 2: kaldırma önerisi geri çekildi**; telemetri olmadan karar yok (§10.1) |
| `embedding_target_idx` | ~40 B | — | `embedding_uniq` zaten `(target_type, target_id, …)` ile başlıyor → büyük ölçüde gereksiz; doğrula |
| `embedding_ann_idx` HNSW | ~3,6 KB/vektör (fp32) | tüm offer: ~430 GB | **Kademeli + halfvec** (§6.5) |

Toplam hedef: ürün+offer tabloları 120M'de ~265 GB → ~146 GB (bkz. §7), arama için ayrı ~370 GB (replikalı).

### 6.3 Vacuum / bakım / bağlantı

* `offer`: `autovacuum_vacuum_scale_factor = 0.01`, `autovacuum_vacuum_insert_scale_factor = 0.01`, `fillfactor = 85`; bayat `last_seen_at` güncellemeleri HOT olur (indekslenmeyen kolon).
* `product`: `product_dirty`'den gelen toplu güncelleme küçük parçalarla (≤ 10 000 satır/parça).
* Büyük parça işleri **ayrı DB rolü** (`arilla_ingest`) ve `statement_timeout`/`lock_timeout`/`idle_in_transaction_session_timeout` ile; `arilla_app` (istek yolu) 5 sn sınırı.
* **Pooler:** toplu işler **doğrudan bağlantı** (Supabase transaction pooler 6543 uzun `COPY` ve `LOCAL` ayarlarla sorun çıkarabilir); istek yolu pooler'da kalır. `max_connections` bütçesi: web 20–40 (pooler), ingest 8–16, resolver 4, indeksleyici 2.
* `pg_stat_statements` + `pg_stat_user_indexes` + bloat izleme (`pgstattuple_approx`) haftalık rapor → `docs/ops.md`.
* HNSW inşa/yeniden inşa için `maintenance_work_mem` ve `max_parallel_maintenance_workers` ayrıca ayarlanır (indeks belleğe sığmazsa inşa günlerce sürer).
* **Donanım gerçeği:** 120M offer + 72M ürün ile sıcak çalışma kümesi için PG ~64–128 GB RAM, ≥ 1 TB NVMe isteyen bir sunucu sınıfıdır. Supabase'in hangi planda bunu verdiği (ya da bunun için ayrı yönetilen/öz-barındırılan PG gerekip gerekmediği) **ayrı bir maliyet/risk karşılaştırması** ister; burada varsayılmadı.

### 6.4 Arama katmanı (OpenSearch sınıfı)

* **Doküman birimi: ürün** (kanonik), offer değil. Gövde: `title`, `brand`, `category_path`, `color`, `attributes` (az sayıda), `min_price`, `max_price`, `offer_count`, `in_stock`, `merchant_ids[]` (üst sınırlı), `best_offer{merchant_id, price}`, `trust` , `popularity`, `percentile`. ~3 KB/dokuman.
* **Neden ürün:** 120M offer değil ~72M ürün (varsayım) ve sonuç listesi zaten ürün. Facet "satıcı" için `merchant_ids` yeterli.
* **Türkçe:** `turkish` analiz zinciri + ASCII katlama (mevcut `foldedTitleExpr` davranışı) + `lexicon.synonym` → motorun synonym graph'ı **ya da** (tercih) sorgu genişletme `packages/core` içinde kalır (kural 6: iş mantığı core'da).
* **Boyut:** 61M aktif doküman → ~184 GB birincil, ~370 GB replikalı. 30–50 GB'lık parçalarla ~8 birincil parça, 3 veri düğümü + 3 küçük yönetici (kaba maliyet: ayda birkaç bin USD, doğrulanmadı).
* **Sürümlü indeks + alias:** `catalog_v{N}` + `catalog_read` / `catalog_write` alias'ları.
  Yeniden indeksleme: yeni `catalog_v{N+1}` PG'den **keyset** (`id > cursor`) ile doldurulur; kesim sırasında çift yazma (outbox `product_id` değişiklikleri hem eski hem yeniye); doğrulama (doküman sayısı ±%0,1, örnek sorgu paritesi, p95) sonrası `catalog_read` alias'ı **atomik** çevrilir; eski indeks 24 saat tutulur → anında geri dönüş. Kullanıcı araması hiç kesilmez.
* **Outbox:** `search_outbox(product_id, changed_at, version)` — PG'de, ürün değişince `product_dirty` ile aynı işlemde. İndeksleyici toplu çeker, `bulk` ile yazar; **dış sürüm** (`version_type=external`, `product.updated_at`/sayaç) eski mesajın yenisini ezmesini engeller. Başarısızlık → yeniden dene; PG gerçek kaynak.
* **Aynı anda:** yönetim araması ve `/ara` PG fallback'i **Faz C'ye kadar** kalır; arama motoru kapalıysa `/ara` bugünkü yola düşer (küçük katalogda) — 120M'de düşme yolu yok, bu yüzden motor HA (≥2 replika) zorunlu.
* **Kural çakışması:** TypeScript tarafı "veritabanından okur" (CLAUDE.md "Mimari sınır"); arama motoru üçüncü bir okuma kaynağı olur. Python indeksleyici arama motoruna yazar → "Python yalnız kuyruktan alır ve DB'ye yazar" cümlesi de değişir. Ayrıca "ayrı vektör DB yasak" yalnız vektör içindir; **ancak OpenSearch k-NN kullanımı** bu yasağın ruhuna dokunur → ayrı karar.

### 6.5 Embedding stratejisi

Ölçülmüş girdiler: Jina CLIP v2, 768 boyut, `img512-v1` ile ~4 000 token/görsel, plan 100k TPM → **~25 görsel/dk teorik, 15–20 pratikte** (hafıza notu 2026-09-24). `cost_micros` hâlâ 0 (fiyat bağlanmadı).

| Yaklaşım | 120M offer | Karar |
| --- | --- | --- |
| Tüm offer'a embedding | 4,8×10¹¹ token; 25 görsel/dk ile ~9 yıl; PG ~840 GB (fp32) | **Yapılamaz** |
| Tüm ürüne (72M) tek temsilci görsel | 2,9×10¹¹ token; hâlâ yıllar | **Yapılamaz (API ile)** |
| **Kademeli, talebe bağlı** | baş ~%5 ürün (3,6M) ≈ 14 milyar token | **Öneri** |
| Kendi GPU'muzda barındırma | Hesap kaba: tek GPU'da ~100–200 görsel/sn → 120M ≈ 7–14 GPU-günü; darboğaz **görsel indirme** (120M istek) | 0015 "kendi modelimiz yok" kararı ölçüyle yeniden açılabilir (karar metni buna izin veriyor); Faz C+ |

Kademeler:

* **T0 — varsayılan: embedding yok.** Aranabilirlik metin/facet ile.
* **T1 — çok-teklifli ürünler** (`offer_count ≥ 2`): kopya/eşleşme doğrulaması için ürün başına tek temsilci görsel.
* **T2 — popüler**: arama gösterimi/tıklama/görüntülenme/koleksiyon (creator) sinyalleri eşiği geçen ürünler; sinyal PG'deki sayaçlardan (`product_view`, `click`, `search_query_day`) beslenir ve **kuyruğa** iş bırakır (kural 1: istek anında model çağrısı yok).
* **T3 — kullanıcı yüklemesi eşleşmedi** → o ürün için talep kaydı (yine toplu işte embed edilir).
* Depolama: `halfvec(768)` (1,5 KB) ya da Matryoshka 256 boyut `halfvec(256)` (~0,5 KB); HNSW `m=16, ef_construction=64`; **baş ürünler** ve **kısmi indeks** (`WHERE target_type='product' AND model_version=...`). Hedef ≤ 10M vektör ≈ 35 GB indeks.
* Embedding **ürün düzeyine** taşınır (bugün offer düzeyi; 0016 kararı gerekçesi "her offer'ın kendi satırı" — ürün düzeyi eşleşme sonrası geçerli, eşleşme öncesi offer vektörü yalnız T1 çözümleyici adayları için geçici tutulur). Bu **0016'nın kısmen değiştirilmesidir**, ADR ister.
* `similarity_edge` yalnız T1+T2 ürünleri için; kuyruk için arama motoru kNN/benzer-başlık.
* İkili nicemleme (`bit(768)` + Hamming HNSW, ~96 B/vektör) ileride tüm ürünlere görsel arama açmak istenirse **yalnızca depolama** sorununu çözer; üretim maliyetini çözmez.

### 6.6 Geçmiş / analitik: ClickHouse mı, R2/Parquet mı?

Değişim-yalnız hacmi (%4 değişim varsayımı): 120M'de ~4,8M olay/gün ≈ 0,7 GB/gün ≈ 250 GB/yıl (PG, 2 indeksle). Bu PG için yönetilebilir; ClickHouse **şimdilik gereksiz** (ek operasyon yükü, kural: mikroservis/yeni altyapı eklememe ruhu).

* **Öneri:** PG'de son 90–180 gün (aylık partition); eskisi **R2 Parquet** (aylık dosya, `offer_id, observed_at, price, list_price, in_stock`). `product_price_stats` yalnız PG'deki pencereden.
* **ClickHouse'a geçiş tetikleyicisi:** çok yıllı geçmiş üzerinde interaktif analitik talebi (creator panelleri, fiyat trend raporları) VE değişim hacminin ≥ 50M olay/ay'a çıkması. O zaman R2 Parquet'ten yüklenir (`s3()` tablo fonksiyonu); karar o gün.
* Arşivleme sırası (kural 4 koruması): partition kapandı → Parquet yazıldı → **sağlama toplamı + satır sayısı doğrulandı** → ikinci kopya → ADR'de tanımlı süre bekle → `DETACH` → `DROP`. Geri dönüş: Parquet'ten yeniden yükle.

### 6.7 Medya

* Bugün: `offer.image_url` + `offer.image_hash` kopyası; R2 yalnız yüklenen/blog medyası (0062).
* Hedef: `media_asset` (kaynak URL → `image_key`); **mirror tembel ve popülerliğe bağlı**:
  1. Başlangıçta yalnız kaynak URL saklanır; arayüz kaynak URL'yi **doğrudan kullanmaz** (üçüncü taraf istek riski — kural: "üçüncü taraf CDN'den çekilmez"; kullanıcı IP'si merchant'a gider) → bu yüzden mirror'ı olmayan görsel için **yer tutucu + kuyruk** ya da kenarda görsel proxy'si (kendi alan adı, kaynak sunucudan çeken ve önbellekleyen) gerekir. Bu, §9'daki açık karar.
  2. Mirror tetikleyicisi: ürün detay görüntülenmesi, arama sonucunda üst-N görünürlük, koleksiyona eklenme, tıklama, T1/T2 embedding adayı.
  3. Anahtar `products/<sha256 ilk 32 hex>.webp` (0062 sözleşmesi aynen); aynı içerik tekil.
  4. Hız sınırı merchant başına (nazik indirme), `robots`/ToS saygısı, hata → `fail_count` + geri çekilme.
* Boyut: tümü (72M × ~60 KB WebP) ≈ 4,3 TB + 72M kaynak isteği; baş %2 ≈ 86 GB. Tümünü baştan mirror **önerilmez** (hukuki: merchant görsel hakları, teknik: indirme hızı).

---

## 7. Kapasite modeli (REV 2 — yeni toplama davranışına göre)

**Neyin değiştiği.** `price_point` artık değişim olayı (0065, doğrulandı). Rev 1'in "bugünkü" fiyat geçmişi sütunları geçersiz; geçmiş hacmi baştan "değişim-yalnız" hesaplanır. Ama **teklif/varyant satırları hâlâ her koşuda tamamen upsert ediliyor** (`UPSERT_OFFERS`/`UPSERT_VARIANTS`: tüm kolonlar, `last_seen_at` her seferinde). Bu 0065'in bilinçli sözleşmesi (tazelik = `last_seen_at`; devam ve pasifleştirme de ona bağlı). Tablodaki "fp-atlama" sütunu bu sözleşme değişirse oluşacak durumdur.

**Varsayımlar** (tahmin; ölçülenler işaretli):

* **N = kaynak offer** (120M = feed satırı/merchant offer; kanonik ürün DEĞİL). Ürün sayısı = N × r. Üç senaryo: **r = 1,0** (hiç birleşme yok; bugünkü 0017 davranışının en kötü hali), **r = 0,5**, **r = 0,25**.
* Satır boyutları: `offer` 0,9 KB heap + 0,23 KB indeks (`attributes_raw` üretimde **ölçülen** ortalama ≈ 395 B, azami 627 B — 0065); varyant 1,5/offer × 0,24 KB; `product` 0,6 KB + 0,6 KB (iki trigram GIN dahil). "İnce hedef": offer 0,45+0,12, varyant 1,0×0,18, ürün 0,45+0,33 (PG'de trigram yok).
* Fiyat/stok değişim oranı %4/gün (tahmin); `price_point` ≈ 104 B/satır (tek indeksle). Tam geçiş günde 1.
* **Ölçülen** hız: `north-sails-turkiye` 1.723 offer / 9.486 varyant / 54 sn ≈ **32 offer/sn** (uzak Supabase, RTT ≈ 158 ms, chunk 100, ~9 ifade/chunk). Yakın konumlu DB için 300/sn (chunk 100) ve 2.500/sn (chunk 5 000) **benim tahminim**, ölçülmedi.
* **Ölçülen** çözümleyici (güncel, `resolve/batch.py`): 1.723 offer / 32,1 sn ≈ **54 offer/sn** (üretim, geri alınan koşu; ADR 0068). Eski satır-satır motor 0,67 offer/sn idi.
* Arama dokümanı 3 KB, aktif %85, 1 replika. R2 ham: 1,2 KB/kayıt gzip (7 gün) + Parquet+zstd 250 B/kayıt (12 haftalık tam + 30 gün %5 delta).

### 7.1 PostgreSQL katalog çekirdeği (offer + varyant + ürün, indeks dahil, GB)

| Kaynak offer N | Bugünkü şema, r=1,0 / 0,5 / 0,25 | İnce hedef, r=1,0 / 0,5 / 0,25 |
| --- | --- | --- |
| 1M | 3 / 2 / 2 | 2 / 1 / 1 |
| 10M | 27 / 21 / 18 | 15 / 11 / 9 |
| 50M | 134 / 104 / 90 | 76 / 57 / 47 |
| **120M** | **323 / 251 / 215** | **184 / 137 / 113** |

Ürün sayısı 120M'de: 120M / 60M / 30M. (Rev 1'in "72M ürün" varsayımı r=0,6 idi; artık kullanılmıyor.)

### 7.2 Günlük yazma yükü

| N | Her satır her koşuda upsert (0065, bugünkü) — ölü heap/gün | + indeks (HOT olmazsa) | fp-atlama (%5 değişen) | Fiyat olayı/gün (%4) · GB/gün · GB/yıl |
| --- | --- | --- | --- | --- |
| 1M | ~1 GB | ~0 | 0,1 GB | 0,04M · ~0 · 2 |
| 10M | 11 GB | +4 | 0,5 GB | 0,4M · 0,04 · 15 |
| 50M | 53 GB | +21 | 2,7 GB | 2M · 0,21 · 76 |
| **120M** | **128 GB** | **+51** | **6,4 GB** | **4,8M · 0,5 · 182** |

(Varyant olayları ayrıca ≈ ×1,5.) Rev 1'in "6,3–25 TB/yıl fiyat geçmişi" riski **kapandı**. Kalan büyük yük: **her koşuda tüm offer/varyant satırının yeniden yazılması**. 120M'de günde ~130–180 GB ölü heap + WAL.

### 7.3 Hız / süre (tek akış, günlük tam geçiş)

| N | Ölçülen 32/sn (uzak, chunk 100) | Yakın DB, chunk 100 (300/sn, tahmin) | Yakın DB, chunk 5k (2.500/sn, tahmin) |
| --- | --- | --- | --- |
| 1M | 9 sa | 1 sa | ~7 dk |
| 10M | 3,6 gün | 9 sa | 1,1 sa |
| 50M | 18 gün | 1,9 gün | 5,6 sa |
| **120M** | **43 gün** | **4,6 gün** | **13 sa** |

Tek akışta günlük tam geçiş uzak/chunk-100 ile **~3M offer'dan sonra** (32/sn × 86.400 = 2,8M/gün) imkânsız. Yakın DB + büyük chunk ile ~50M'e kadar tek akışta mümkün; 120M'de paralel merchant akışı ve/veya fp-atlama şart.

**Çözümleyici (güncel):** toplu motorla ≈54 offer/sn: 1M yeni offer ≈ **5,1 saat**, 10M ≈ **2,1 gün**, 50M ≈ **10,7 gün**, 120M ≈ **25,7 gün** (tek akış; ölçülen oran 1.7k offer'lık tek merchant'ta, trigram maliyeti katalogla büyüyeceğinden ÜST SINIR DEĞİL, iyimser). Eski 0,67/sn ile 1M = 17 gün, 120M = 5,7 yıl idi — bu hesap geçersiz. Kritik yol olmaya devam ediyor, çünkü arama yalnız ürüne bağlı offer'ları görür (`search-sql.ts`: `o.product_id IS NOT NULL`); asıl ölçek sınırı tam-katalog trigram aday üretimidir (~100k offer'dan sonra ayrı iş).

### 7.4 Arama, benzerlik, embedding (kanonikleştirme oranına göre)

| N | r | Ürün | Arama dokümanı (aktif) | Arama indeksi birincil · replikalı | `similarity_edge` baş %5 · hepsi | Kademeli embedding %5 |
| --- | --- | --- | --- | --- | --- | --- |
| 10M | 1,0 / 0,5 / 0,25 | 10M / 5M / 2,5M | 8,5M / 4,3M / 2,1M | 26·51 / 13·26 / 6·13 GB | 1·48 / 1·24 / 0·12 GB | 2 / 1 / 0 GB |
| 50M | 1,0 / 0,5 / 0,25 | 50M / 25M / 12,5M | 42M / 21M / 11M | 128·255 / 64·128 / 32·64 GB | 6·240 / 3·120 / 2·60 GB | 8 / 4 / 2 GB |
| **120M** | 1,0 | 120M | 102M | **306 · 612 GB** | 14 · 576 GB | 20 GB (6M vektör) |
| **120M** | 0,5 | 60M | 51M | **153 · 306 GB** | 7 · 288 GB | 10 GB (3M) |
| **120M** | 0,25 | 30M | 26M | **76 · 153 GB** | 4 · 144 GB | 5 GB (1,5M) |

Embedding hâlâ hepsine yapılamaz: Jina ~4 000 token/görsel, 100k TPM → 25 görsel/dk (ölçülen 15–20). 120M görsel ≈ 9 yıl; r=0,25'te bile 30M ürün ≈ 2,3 yıl.

### 7.5 R2 ve işçi

R2 ham arşiv N'ye bağlı, r'ye değil: **1M ≈ 0,01 TB · 10M ≈ 0,12 TB · 50M ≈ 0,6 TB · 120M ≈ 1,4 TB**. Medya tamamı ≈ ürün × 60 KB (r=0,25 → 1,8 TB; r=1 → 7,2 TB) — **mirror edilmez**, tembel (§6.7).
İşçi: 120M için günlük tam geçişi 6 saat penceresinde bitirmek ≥ 5.600 satır/sn demektir. Yol "daha hızlı yazıcı" değil, **yazılan satırı %5'e indirmek** (fp-atlama) + parça boyunu kaynağa göre ayarlamak. Bu da tazelik sözleşmesinin değişmesini gerektirir (§10.3).

---

## 8. Arama istek akışı — Gemini politikası (REV 2)

**Hedef:** LLM-önce değil. Basit ad ve basit filtre → AI yok. Yalnız belirsiz/karmaşık sorguda, gerektiğinde Gemini; yapılandırılmış JSON; ürün ve fiyat gerçeği katalog/aramadan; aynı (normalize sorgu, kategori, locale, taksonomi sürümü) için doğrulanmış yorum varsa **önbellekten**, tekrar çağrı yok; ilk sıralama algoritmik, sonra isteğe bağlı AI rerank.

### 8.1 Bugünkü sözleşmeyle uyumlu olan kısımlar

| Adım | Durum |
| --- | --- |
| "iphone 17 pro max" → AI yok | ✅ Kademe 2 + `search()` (model adı eşleşmesi katalog/sözlüğe bağlı; eval setiyle doğrulanmalı) |
| "20 bin altı samsung telefon" → deterministik | ❌ **`price-patterns.ts` "bin/k" kalıbını bilmiyor.** Kod yalnız `\d[\d.]*` + `tl/₺/try` + `alt(ı\|ında)`; Shopify branch'inde de değişmedi. Politika çelişkisi yok; küçük, birim testli deterministik ekleme |
| Aynı sorgu için önbellek | ✅ `query_interpretation` kimliği `(query_norm, taxonomy_hash, model_version)`; `/ara` yalnız `accepted` satırı okur. `locale` bugün kimlikte yok (tek dil); çok dil gelirse eklenir |
| Seçenek tıklaması modele gitmez | ✅ 0030 (durum URL'de) |
| Sıralama algoritmik | ✅ `ranking.ts`; AI rerank sonra, **çevrimdışı** |

### 8.2 Çelişen kısım: "gerektiğinde eşzamanlı Gemini"

| | Bugünkü kural | Hedef davranış |
| --- | --- | --- |
| **CLAUDE.md kural 1** | "İstek yolunda model çağrısı yok." Tek istisna: yüklenen görselin embedding'i | Önbellek ıskalamasında, deterministik ayrıştırma sonuçsuz kaldığında, istek anında Gemini |
| **ADR 0059 §1** | "Gemini kullanıcı isteği sırasında hiçbir koşulda çağrılmaz." İstek yolunda model çağrısı **reddedilen alternatif** | Seçici çağrılır |
| **ADR 0059 §3, §6** | Aday = son 30 günde ≥3 arama **ve** ≥3 farklı gün; kaynak kullanıcıdan bağımsız toplu özet; modele yalnız bu özetten metin gider | Tek kullanıcının canlı sorgusu, ilk görülmede |
| **ADR 0030 §3, §7** | Seçenekler elle yazılmış kural sözlüğünden gelir; model **yorumcudur**, seçenek/ürün üretmez (enum'lar taksonomiden) | "Gemini yapılandırılmış soru/seçenek üretir": taksonomi enum'larından seçmek 0030'a uyar; serbest seçenek üretimi uymaz |
| **KVKK (docs/kvkk.md, LIA, m.9 sözleşmesi)** | Hukuki dayanak toplu, kimliksiz sorgu özetine kurulmuş; özel nitelikli veri süzgeci **toplu işte** çalışıyor; aydınlatma metinleri buna göre | Tek tek canlı sorgu yurt dışına gider; aktarım kapsamı ve risk (süzgeç yanlış-negatifi) değişir |
| **0059 §5** | Gemini hatası aramayı engellemez | Aynen korunmalı (zaman aşımı + deterministik düşüş) |
| **0059 sınırları** | Gün başına ≤100 sağlayıcı denemesi, `api_usage` kaydı | Canlı yolda ek: kullanıcı/IP hız sınırı (Redis), tek-uçuş kilidi, ayrı global bütçe kesicisi |

**Bypass yok:** bugün Gemini yalnız `interpret-queries` cron'unda ve yalnız uygun (toplu) sorgu için çalışıyor; bu rapor hiçbir şeyi değiştirmedi.

### 8.3 Eşzamanlı seçici Gemini için gereken (hepsi onay ister; hiçbiri yapılmadı)

1. **CLAUDE.md kural 1** güncellenir: ikinci dar istisna "sorgu anlama" — yalnız deterministik ayrıştırma + netleştirme çözemediğinde ve önbellek ıskalamasında; zaman aşımı ~1,5–2 sn; hata → deterministik yol; sonuç `query_interpretation`'a; her çağrı `api_usage`.
2. **Yeni ADR** (0059'u kısmen değiştirir): §1, §3/§6 (uygunluk eşiği canlı yolda uygulanamaz) ve sınırlar; hangi sorgunun canlıya gideceği kuralı; hassas-veri süzgeci **istek başına ve kapalı-başarısız** (şüphede gönderme).
3. **KVKK/LIA:** meşru menfaat değerlendirmesi ve m.9 aktarım sözleşmesi kapsamı "toplu özet"ten "canlı tekil sorgu"ya genişletilir; aydınlatma/gizlilik metni güncellenir; hukuk danışmanı yeniden onaylar. Kimlik (user/session/IP) modele **hiç** gitmez (0059 §6 aynen).
4. **Önbellek kimliği** `(query_norm, taxonomy_hash, model_version[, locale])` olmadan canlı yol açılmaz.
5. **Ayarlar:** Redis tek-uçuş kilidi, kullanıcı/IP başına dakika sınırı, günlük global kesici (mevcut 100/gün canlı yolda yetersiz → ayrı tavan), kesici açıkken deterministik yol. Mevcut arama hakkı/`ai_search_charge` (0047) ile ilişkisi okunmadı; ayrıca incelenmeli.

**Önerilen yol (kurallara uyumlu, "A+"):** İstek yolu bugünkü gibi. Çözümlenemeyen ya da belirsiz sorgu hemen deterministik sonuç + netleştirme alır ve **çevrimdışı kuyruğa** yazılır; eşik 0059'daki gibi ya da ayrı bir ADR ile düşürülür (ilk görülmede kuyruğa; işleme gün içinde sık koşuyla). Maliyet kullanıcı sayısıyla ölçeklenmez, hukuki çerçeve değişmez. Eşzamanlı yol ancak yukarıdaki beş madde birlikte onaylanırsa.

Arama motoruna geçince bu akış değişmez: `QueryObject` → core içinde motor sorgusuna çevrilir (kural 6).

---

## 9. CLAUDE.md'de önce güncellenmesi gerekenler (özet)

| Satır | Çakışan öneri | Gereken |
| --- | --- | --- |
| "TS yalnız DB'den okur; Python yalnız kuyruktan alır, DB'ye yazar" | Arama motoru (3. depo), Python indeksleyici, R2 arşiv yazımı | Mimari sınır + ADR (C) |
| Kural 4 | Partition arşivle→`DROP` | ADR: arşiv doğrulama zinciri (C) |
| Kural 3 / 0016 | Embedding ürün düzeyi + kademeli | 0016'yı kısmen değiştiren ADR (C) |
| Kural 1 / 0059 / 0030 | §8.3 | CLAUDE.md + ADR + KVKK; yoksa A+ |
| "Ayrı vektör DB yasak" | OpenSearch k-NN | Önerilmiyor |
| "Event bus yok" | `search_outbox` | ADR'de "PG outbox + Redis kuyruğu event bus değildir" yazılır (C) |
| Kural 14 | skaler kolonlar/jsonb sadeleştirme | Ekle → dağıt → kaldır |
| **Numaralandırma** | Aşağıda | Birleştirme öncesi karar |

**Numaralandırma (REV 3 — çözüldü/planlandı; ayrıntı `docs/decisions/README.md`):**

* **Migration `0050`:** ÇÖZÜLDÜ — Shopify dalı dosyayı `0051_ingest_run_checkpoint.sql` olarak yeniden adlandırdı ve `migrations/renamed.json` + `migrate.ts` ile üretim defter satırını tek işlemde taşıyor (SQL yeniden çalışmaz). Bu raporun önceki "0051 idempotent yeni dosya" önerisi **terk edildi** (aynı ada sahip ikinci dosya olurdu). Doğrulama: Ek B.2.
* **ADR numaraları:** `main`'de `0065-erken-erisim-sayaci` ve `0066-yapay-zekasiz-arama-fallback`; Shopify dalında `0064-shopify-kanonik-alan-adi`, `0065-chunkli-checkpointli-toplama`, `0066-toplu-eslestirme`. Çakışma 0065 ve 0066'da. Plan: Shopify tarafı 0065→0067, 0066→0068 (migration dosyalarına dokunmadan); bu dal ADR 0069'u alır. Kuru çalışma ve `pnpm check:adr` kanıtı Ek B.3.
* Bu raporun ADR taslaklarına numara verilmemişti; yalnızca fiyat parser'ı için 0069 alındı.

---

## 10. Hazırlık paketinin yeniden değerlendirmesi (REV 2)

Her madde için: şimdi gerekli mi · branch çözüyor mu · 120M için kesin mi · migration maliyeti · mevcut şemaya etkisi · geri alma · OpenSearch/ayrı katalog DB'ye taşınırken değeri.

### 10.1 Çift indeks `price_point_offer_time_idx` — **Karar: kaldırma önerisi GERİ ÇEKİLDİ**

**Tanımlar (kanıt):** PK = `(offer_id, observed_at)` (btree, ASC/ASC; `0003_price_history.sql`). İkinci indeks = `(offer_id, observed_at DESC)` (aynı dosya).

**Kullanım (kod):** `get-price-history.ts` ve `offer-price-days.ts` yorumları indeksi **adıyla** anıyor. Sorgular:
* `ORDER BY p.observed_at DESC LIMIT 1` (teklif başına, `offer-price-days.ts`);
* `LAST_PRICE_POINTS` (yazıcı, her chunk): `DISTINCT ON (offer_id) … WHERE offer_id = ANY(…) ORDER BY offer_id, observed_at DESC`;
* `PRICE_HISTORY` (stats): LATERAL `WHERE offer_id = o.id AND observed_at < since ORDER BY observed_at DESC LIMIT 1`.

`(offer_id ASC, observed_at DESC)` karma sırası ASC/ASC PK'nın ileri ya da geri taranmasıyla sağlanamaz; tam da DESC indeksinin sağladığı sıradır. Rev 1'de "aynı kolonlar = gereksiz" demem **tanımdan bakıp** vardığım yanlış sonuçtu.

**Deney** (yerel Docker PG16, geçici `audit_scratch` şeması, 1M satır; üretim ve yerel uygulama verisi dokunulmadı, şema silindi):

| Sorgu | İki indeksle | DESC indeks düşürülünce |
| --- | --- | --- |
| `LAST_PRICE_POINTS` (100 id) | Bitmap Index Scan (**DESC indeksi**) + Sort, 0,57 ms | Bitmap Index Scan (**PK**) + aynı Sort, 0,41 ms |
| `ORDER BY observed_at DESC LIMIT 1` | Index Scan (DESC indeksi) | **Index Scan Backward (PK)**, aynı maliyet |

Bu iki sorgu biçimi için PK ile eşdeğer plan kuruluyor; `LAST_PRICE_POINTS` zaten Sort ekliyor. **Bu üretim kanıtı değildir:** sentetik veri, teklif başına 5 satır, ısıtılmış önbellek; gerçek dağılım ve üretimdeki `idx_scan` sayıları ölçülmedi. `offer-price-days` LATERAL'ı ve `PRICE_HISTORY` biçimi denenmedi.

**Gerekli mi / premature mı:** Bugünkü katalogda tasarruf ihmal edilebilir. 120M'de değişim-yalnız hacminde ikinci indeks ≈ yılda ~7 GB. Yanlışsa fiyat grafiği sorguları plan değiştirir. **Premature; telemetri olmadan kaldırılmaz.**
**Migration/geri alma:** partition'lı tabloda `DROP INDEX CONCURRENTLY` ana tabloda desteklenmez → partition başına; geri alma = `CREATE INDEX` (kilit/zaman).
**Taşınma değeri:** arama motoru/ayrı DB geçişinde `price_point` PG'de kalır; karar telemetriyle o zaman. **Karar: A'dan çıkarıldı; yalnız ölçüm (Ek A).**

### 10.2 Autovacuum / fillfactor — **Karar: şimdi değil; B'de, bulk yüklemeden ÖNCE; sabit sayı değil formül/ölçüm**

**Tablo davranışı (kod):** `offer`: her koşuda **her satır UPDATE** (0065: tüm kolonlar, `last_seen_at`); DELETE yok (FK'ler engelliyor). Fiyatı değişmeyen satırda indeksli kolon değişmez (`current_price` kısmi indekste, `is_active` aynı, `image_hash` aynı) → **HOT uygun**, ama yalnız sayfada boş yer varsa. Varsayılan `fillfactor=100`: sayfalar dolu → çoğu güncelleme HOT olamaz, her koşuda 5 indekse yeni giriş yazılır. `offer_variant` aynı. `price_point` ve olay tabloları yalnız INSERT.

**Neden şimdi değil:** PG varsayılanları (`scale_factor=0,2`, `threshold=50`) küçük tabloda doğru. `fillfactor` yalnız **yeni yazılan sayfaları** etkiler; mevcut dolu sayfalar yeniden yazılana dek aynı kalır. Bu yüzden doğru an bulk yüklemeden önce (B). Şimdi ayarlamak mevcut küçük katalogda sıfır etki.

**Yöntem (ölçümle doldurulur):**

1. Ölç (Ek A, sorgu 3): `n_tup_upd`, `n_tup_hot_upd`, `n_dead_tup`, `last_autovacuum`, `autovacuum_count`, tablo boyu.
2. `hot_oranı = n_tup_hot_upd / n_tup_upd`. Düşükse ve indeksli kolon değişmiyorsa `offer`/`offer_variant` için `fillfactor` düşürülür. Her güncelleme yeni sürüm yazar; HOT budaması sayfa erişiminde yer açar; ihtiyaç duyulan boşluk, aynı sayfadaki satırların koşular arası biriktirdiği ölü sürüm oranıdır. Bu oran kod okunarak türetilemez → **85–90 yalnız başlangıç hipotezi**; HOT oranı hedefe çıkana dek ölçerek ayarlanır.
3. Vacuum tetiği: `scale_factor = D / n_live`, burada D tolere edilen ölü satır sayısı. Her tam koşu ≈ n_live ölü üretir; 0,2 varsayılanı koşudan sonra yine tetiklenir. Büyük tabloda sorun eşik değil **iş hacmi**: `autovacuum_vacuum_cost_limit`/`_delay`, işçi sayısı, `maintenance_work_mem` (120M'de eşik 24M satır, tam geçiş zaten aşar). Yani tuning = kapasite.
4. Salt-INSERT tablolar için `autovacuum_vacuum_insert_scale_factor` yalnız index-only scan kullanılan tablolarda anlamlı.

**Etki:** `ALTER TABLE … SET (fillfactor=…)` yalnız meta veri, kısa kilit. **Geri alma:** `RESET (fillfactor)`; etki yalnız yeni sayfalarda. **Taşınma değeri:** parametre PG'ye özgü; ayrı katalog DB'sinde yeniden belirlenir; ölçüm yöntemi taşınır.

### 10.3 `mpn_norm` · `content_fp` · `fp_version` · `last_run_id` · `lifecycle` · `inactive_at` — **Karar: şimdi hiçbiri**

| Kolon | Branch çözüyor mu | 120M'de | Karar |
| --- | --- | --- | --- |
| `mpn_norm` | Hayır; ama toplama MPN'yi **çıkarmıyor** (`attributes_raw`'da yalnız `gtin, sku, color, id`). Admitad'da MPN alanı var mı bilinmiyor | Bloklama için gerekebilir; **feed örneğine bağlı** | **B, örnek sonrası** |
| `content_fp`, `offer_fp`, `fp_version` | Hayır. `UPSERT_OFFERS` her koşuda tüm satırı yazıyor; yalnız `price_point` önceki satırla karşılaştırılıp atlanıyor | 120M'de **kesin** (§7.2: 128 → 6,4 GB/gün). 1–5M'de gerekmez | **B**: yazma yoluna girmeyen kolon ölü ağırlık; `fp_version` normalizasyon sözleşmesine bağlı (Admitad adaptörü yazılınca kesinleşir) |
| `last_run_id`, `lifecycle`, `inactive_at` | **Büyük ölçüde evet:** `last_seen_at` + `is_active`, `deactivate_missing` (`last_seen_at < observed_at`), devam (`last_seen_at = observed_at`) | `stale`/`tombstone` ayrımı değerli ama bugün `last_seen_at` yeterli | **C / ihtiyaç doğunca** |

**Önemli uzlaşmazlık — Rev 1'in "gevşek `last_seen_at`" önerisi geçersiz.** 0065 üç şeyi `last_seen_at`'e bağladı: tazelik/grafik bitişi, devam (`already_written`) ve pasifleştirme. fp-atlama (satıra hiç dokunmama) bu üçünü birlikte bozar. Büyük ölçekte alternatif **koşu kapsama kaydı** (bu snapshot'ta hangi `external_id`'ler vardı: staging/snapshot tablosu ya da R2 Parquet), `last_seen_at`'in gevşek aralıkla yazılması, devamın `checkpoint`'e yazılan **staging dosyası ofsetiyle**, pasifleştirmenin anti-join ile yapılmasıdır. Bu bir **tasarım kararı** (ADR); kolon eklemekle çözülmez. Taşınma değeri yüksek (ayrı katalog/arama katmanında snapshot kapsama modeli doğal), ama tasarım B'de, kolon A'da değil.

### 10.4 `ingest_batch` / `product_identity` — **`ingest_batch` gereksiz (branch çözdü); `product_identity` ertelendi**

* **`ingest_batch`:** Branch `ingest_run.checkpoint` JSONB + chunk başına atomik commit (0050/0065) + advisory lock + `partial/resumable` ile checkpoint ve devamı **çözdü**; ayrı tablo gereksiz. Kalan boşluk tablo değil **devam yöntemi**: `already_written` bugün `last_seen_at = observed_at` olan tüm `external_id`'leri belleğe `set` olarak çekiyor ve kaynağı baştan akıtıp atlıyor. Staging dosyalı Admitad için ofset-tabanlı devam gerekir (checkpoint JSON'una `staged_offset`). **Migration gerekmez.**
* **`product_identity`:** Çözümleyici toplu motorla (`resolve/batch.py`) round-trip yükünü kaldırdı (≈54 offer/sn); `product_gtin_idx` + `product_title_trgm` ile çalışmaya devam ediyor. Kalan darboğaz tam-katalog trigram aday üretimi (ADR'ye göre ~10–15 ms/offer, ~100k offer'da ayrı iş). `product_identity`, set-tabanlı bloklama yazılırken faydalı; şimdi tablo eklemek kullanıcısız şema. Feed alanları (GTIN/MPN doluluğu) bilinmeden anahtar türleri kilitlenmemeli. **B/C; feed örneği + aday üretiminin yeniden yazımıyla birlikte.**

### 10.5 Parmak izi yardımcısı — **Karar: şimdi değil**

Saf fonksiyon ucuz, ama (a) hangi alanların "içerik", hangilerinin "ticari" sayılacağı Admitad normalizasyonuna bağlı; (b) `fp_version` sözleşmesi tüketici olmadan sınanamaz; (c) yazma yolu §10.3'teki tazelik uzlaşmazlığı çözülmeden kullanılamaz. Ölü kod + erken kilit riski. **B'de, adaptör ve tüketiciyle birlikte.** Taşınma değeri yüksek (arama indeksinin "değişti mi?" kararı aynı hash'i kullanır): doğru sözleşmeyle yazılmalı.

---

## 11. ÜÇ GRUP — nihai plan

### A — NOW (küçük katalogda; şema değişikliği YOK)

| # | Madde | Neden | Etkilenen | Migration | Risk | Maliyet |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | **Salt-okunur telemetri sorguları** (Ek A): indeks kullanımı, HOT oranı, boyutlar, ölü satır, vacuum sıklığı, `pg_stat_statements`. Yerelde hemen; üretimde **senin onayınla** | Kalan her "kaldır/ayarla" kararı için kanıt | docs/ops.md'ye eklenebilir | Hayır | Yok (salt okunur) | Çok düşük |
| A2 | **Numaralandırma kararı** — Rev 3: migration tarafı Shopify dalında çözüldü; ADR planı ve denetimleri (`pnpm check:adr`, `pnpm db:lint-migrations`) bu dalda | Üretimde uygulanmış iki 0050 vardı | `packages/db`, `docs/decisions` | Hayır | — | Düşük |
| A3 | **Politika/ADR taslakları (yalnız metin)**: (i) Gemini seçici eşzamanlı yol (§8, A+ önerisi ya da kural 1/KVKK değişikliği), (ii) arama motoru + R2 arşiv için mimari sınır taslağı — uygulanmadan | "Önce CLAUDE.md, sonra kod" | docs | Hayır | Yok | Düşük |
| A4 | **"20 bin altı" / "35k" / "1,5 milyon" fiyat kalıbı** (`price-patterns.ts`, birim testli, deterministik) | 2. senaryon; AI gerektirmez; şema yok | `packages/core/src/search` | Hayır | Düşük | Düşük |

**A'da bilinçli OLMAYANLAR (Rev 1'den):** çift indeks düşürme, fillfactor/autovacuum, fp kolonları, `ingest_batch`/`product_identity`, parmak izi, boş yeni tablolar.

### B — BEFORE ADMITAD IMPORT

Önkoşul: **gerçek feed örneği** (§12). ✅ = örnekten bağımsız, ⚠️ = örneğe bağlı.

| # | Madde | Neden | Etkilenen | Migration | Risk | Maliyet |
| --- | --- | --- | --- | --- | --- | --- |
| B1 ✅ | **Kaynak adaptörü katmanı**: `RawRecord → NormalizedOffer` eşlemesi veri olarak (`feed_config.mapping`, mevcut `FieldMapping` + connector kaydı); format taşıması ayrı. Alan adı **tahmin edilmez** (0012) | Şema kilitlenmez; örnek gelince yalnız eşleme | `collect/mapping.py`, `connector.py`, yeni kaynak | Hayır | Düşük | Orta |
| B2 ✅ | **`xml_feed._open` gerçek akış**: `httpx.stream` → geçici dosya / R2 staging → dosyadan `iterparse` (`io.BytesIO(response.content)` branch'te de aynı, doğrulandı) | Çok GB feed = OOM | `collect/sources/xml_feed.py` | Hayır | Düşük | Düşük |
| B3 ✅ | **R2 ham staging + sha256**: aynı hash tekrar işlenmez; yarım indirme canlı kataloğa dokunmaz. Kayıt ilk sürümde `ingest_run.checkpoint` içinde (`raw_uri`, `sha256`, `bytes`); **ayrı tablo yok** | Yeniden oynatma, denetim, yarım-feed kanıtı | yeni `collect/staging.py`, Python R2 istemcisi (TS `storage/` anahtar şemasıyla uyumlu) | Hayır | Orta (yeni dış bağımlılık) | Orta |
| B4 ✅ | **`full_dump` pasifleştirme sanity kapısı**: önceki tam koşuya göre görülen sayı oranı + dosya bütünlüğü; geçmezse `partial`, pasifleştirme yok. Bugün yalnız `status == "success"` (branch'te doğrulandı) | Eksik ama HTTP 200 feed kataloğu sessizce kapatır | `collect/pipeline.py` (Shopify işinin dosyası; o iş birleşince) | Hayır | Düşük | Düşük |
| B5 ✅ | **Parça boyu kaynağa göre**: `CHUNK_OFFERS=100` uzak Shopify RTT'sine göre; dosya kaynağında DB'ye yakın işçiyle 2–20 bin; **işçi DB ile aynı bölgede** | §7.3: 32/sn → ~2.500/sn (tahmin, ölçülecek) | `pipeline.py` parametre | Hayır | Düşük | Düşük |
| B6 ✅ | **Devam yöntemi**: `already_written` ve `seen_external_ids` bellek setleri yerine checkpoint'te `staged_offset` | Milyonluk merchant'ta bellek | `pipeline.py` | Hayır | Orta | Orta |
| B7 ✅ (kısmen yapıldı) | **Çözümleyici aday üretimi (kritik yol):** toplu motor ≈54 offer/sn ile round-trip yükünü çözdü (`resolve/batch.py`); kalan: tam-katalog trigram/ANN yerine blok (GTIN/marka+MPN/model anahtarı), ~100k offer'dan önce. **Regresyon seti önce** (CLAUDE.md) | Arama yalnız çözümlenmiş offer'ı görür | `resolve/candidates.py`, `batch.py`, `products.py` | Belki (`product_identity`, feed'e bağlı) | **Yüksek** (eşleştirme kalitesi) | Orta–Yüksek |
| B8 ✅ | **Arama O(N) giderme:** `bestOfferCte` yerine `product.best_offer_id` (`min_price` zaten var). Eşik ~200–500k offer (4,5k üründe 20 ms ölçüldü; doğrusal ekstrapolasyon, ölçülmedi) | Aksi hâlde `/ara` saniyeler sürer | `search-sql.ts`, `similarity/pipeline.py` | Evet (`product.best_offer_id`) | Orta (eval seti + `search.integration`) | Orta |
| B9 ✅ | **`offer`/`offer_variant` fillfactor ve vacuum parametreleri** — A1 ölçümüne dayalı, **bulk yüklemeden önce** (§10.2) | Yeni sayfalar HOT'a uygun yazılır | `packages/db` | Evet (meta veri) | Düşük | Düşük |
| B10 ⚠️ | **Ölçeklenebilir değişim-algılama** (parmak izi + tazelik sözleşmesi ADR'si; snapshot kapsama): feed boyutu/sıklığı bilinince; ~3–5M offer altında gerekmeyebilir | §7.2 | `writer.py`, `pipeline.py`, fiyat/grafik okuyucuları | Evet | **Yüksek** | Yüksek |
| B11 ⚠️ | **Skaler tanımlayıcılar** (`gtin`, `mpn_norm`, `brand_id` offer'da): feed'de hangi alanlar varsa | Bloklama | `offer`, writer | Evet | Orta | Orta |
| B12 ⚠️ | **Tembel medya mirror işçisi + görsel sunum kararı** (kaynak URL → proxy/yer tutucu). 0065 zaten "ayrı, yeniden çalıştırılabilir aşama" dedi; yalnız popülerlik tetikleyicisi ve `image_url` olup R2 karşılığı olmayan seçim eklenir. DB'ye binary/base64 yok; 120M görsel baştan indirilmez | §6.7 | `enrich/images.py`, `storage/` | `media_asset` (kullanım örüntüsüne bağlı) | Orta | Orta |
| B13 ✅ | **Kademeli tranş:** 1–3 merchant, 10–100k offer; her tranşta `/ara` p95 + çözümleyici hızı + DB boyutu geçidi | Sürpriz yok | süreç | Hayır | Düşük | Düşük |

### C — AT SCALE

| Eşik | Madde | Tetikleyici ölçüt |
| --- | --- | --- |
| **~1M offer/ürün** | `variant_*_event`, `click`, ingest olay tablolarına aylık partition; keyset sayfalama (arama + admin `OFFSET`); kademeli embedding (halfvec, kısmi HNSW, popülerlik kuyruğu); `build_edges` akışlı + yalnız baş ürünler | `/ara` p95, boyutlar (A1) |
| **~5–10M** | **OpenSearch sınıfı arama** (yönetilen, ≥3 düğüm HA), outbox indeksleyici, versiyon+alias yeniden indeks; PG'den trigram GIN'ler ve `product_min_price_idx` kaldırılır; PG'siz fark (R2 Parquet karşılaştırması) hız yetmezse | PoC'de PG p95 hedefi tutmuyor; çözümleyici/toplama süre bütçesi aşılıyor |
| **~10–50M** | **Katalog DB'sini Supabase'ten ayırma** (§13): ayrı yönetilen PG (okuma replikası, PITR, NVMe/RAM); geçmişin R2 Parquet'e arşivi + sağlama zinciri (ADR, kural 4); `product_identity` + set-tabanlı bloklama tam; `price_point_offer_time_idx` kararı **telemetriyle** | RAM çalışma kümesi, vacuum yetişmiyor, Supabase plan/bağlantı/disk tavanı |
| **~50–120M** | `offer` HASH(id) bölme + `offer_source_key` (yalnız ölçüm gösterirse); (koşullu) ClickHouse (çok yıllı interaktif analitik + ≥50M olay/ay); (koşullu) kendi GPU embedding | §6 tetikleyicileri |

---

## 12. Admitad adaptör sözleşmesi ve örnek feed'de öğrenilecekler

**İlke:** hiçbir alan adı tahmin edilmez (0012). Katmanlar: **Taşıma** (HTTP/dosya; XML/CSV/JSON; akış; R2 staging) → **`RawRecord`** (kaynağa ait alanlar) → **Eşleme** (veri: `feed_config.mapping`) → **`NormalizedOffer`** (bize ait; mevcut) → yazıcı. Yeni format = yeni taşıma/eşleme; yazıcı ve şema değişmez. Mevcut `FieldMapping` + `connector.register` temel olarak yeterli; eksik olan akış (B2), staging (B3) ve gruplama (varyant).

**Örnek feed gelince öğrenilecekler:**

1. **Biçim/erişim:** XML/CSV/JSON; kodlama; sıkıştırma; tek dosya mı parça mı; kimlik doğrulama; `ETag`/`Last-Modified`; güncelleme sıklığı; tam dump mu delta mı; "silinen ürün" sinyali var mı.
2. **Kimlik:** satır kimliği (kararlı mı, merchant bazında tekil mi); `group_id`/varyant ilişkisi (her renk/beden ayrı satır mı); ürün URL'si; **affiliate/deeplink alanı** (kural 8); program/merchant kimliği.
3. **Tanımlayıcılar:** GTIN/EAN doluluk oranı; MPN; SKU; marka alanı (serbest metin mi kodlu mu); model alanı.
4. **Fiyat/stok:** fiyat biçimi (ondalık ayracı, para birimi alanı, vergi dahil mi); liste fiyatı/indirim; stok (bool/adet/metin); kargo; TRY dışı para birimi var mı (0031).
5. **İçerik:** başlık; açıklama (uzunluk → R2'ye mi); kategori (merchant ağacı → bizim taksonomi eşlemesi); görsel alanları (birden çok mu, çözünürlük, URL kararlı mı); renk/beden/malzeme öznitelikleri.
6. **Kalite/hacim:** kayıt sayısı; dosya boyutu (gzip/ham); tekrarlı satır oranı; bozuk satır oranı; en büyük merchant'ın payı; **iki ardışık günlük dosya farkı** (§7'nin %4 varsayımını doğrular); görsel URL'lerinin ayakta kalma oranı.
7. **Hukuki/ticari:** kullanım koşulları (görsel/veri yeniden yayını, önbellek/mirror izni), hız sınırı, robots/ToS (0042 yaklaşımı), komisyon alanı.

1.000 satırlık dilim + tam dosya istatistikleri yeterli; tam feed gerekmez.

---

## 13. PostgreSQL/Supabase katalog rolü ne zaman ayrılmalı?

Kapsam kararı: Supabase **auth, kullanıcı, rıza, admin, merchant operasyonel metaverisi** için kalır; katalog bugün taşınmaz, ama sınırlar ayrılabilir tasarlanır.

* **Sınır (bugünden):** katalog tabloları (`brand, category, product, offer, offer_variant, price_point, variant_*_event, embedding, similarity_edge, match_candidate, product_price_stats`; `ingest_run` ve `merchant` operasyonel taraf). Ayrılırsa kopacak **FK bağları** var: `click`, `saved_item`, `alert`, `collection_item`, `public_find`, `conversion` ürün/offer'a bağlı (`docs/schema.sql`). Ayırmadan önce bu bağlar için bütünlük stratejisi (0020'deki polimorfik/trigger deseni ya da kimlik eşleme) kararlaştırılmalı. Şimdilik: **katalog erişimi `packages/core/src/{search,product}` tek giriş noktası olarak kalır** (kural 6); yeni kod katalog tablolarını `apps/*` içinden okumaz.
* **Ayırma tetikleyicileri (ölçüt, tarih değil):** (1) sıcak çalışma kümesi (sıcak indeks + heap) Supabase planının RAM'inin ~%60'ını aşıyor (kaba kural, telemetriyle); (2) otomatik vacuum toplu koşuya yetişmiyor (`n_dead_tup` birikiyor, `last_autovacuum` gecikiyor); (3) toplu yazma pooler/bağlantı/IOPS tavanına çarpıyor ya da auth ve `/ara` gecikmesine yansıyor; (4) disk planı tavanı; (5) yedekleme/PITR süresi tolere edilemiyor.
* **Kaba ölçek eşikleri (bu raporun varsayımlarıyla; Supabase'in gerçek plan sınırlarını bilmiyorum, doğrulanmadı):**
  * katalog çekirdeği **~20–30 GB** (r=1,0'da ~10M offer; r=0,25'te ~15M) → ayırmaya **hazırlık**;
  * **~100–150 GB** (ince şemada r=0,5'te ~50M offer; bugünkü şemada r=0,5'te ~60M) → **fiilen ayrı yönetilen PG**;
  * 120M'de 113–323 GB + sıcak çalışma kümesi → ayrı sunucu sınıfı kaçınılmaz.
* **Arama ayrı altyapıda** (OpenSearch) PG'den **daha erken** ayrılır (~5–10M ürün); katalog DB'si daha geç.

---

## Ek A — Salt-okunur telemetri (üretimde yalnız onayınla; yerelde hemen)

```sql
-- 1) Boyutlar
SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) total,
       pg_size_pretty(pg_relation_size(relid)) heap, n_live_tup, n_dead_tup
  FROM pg_stat_user_tables
 WHERE relname IN ('offer','offer_variant','product','price_point','variant_price_event',
                   'variant_stock_event','embedding','match_candidate','similarity_edge','ingest_run')
 ORDER BY pg_total_relation_size(relid) DESC;

-- 2) İndeks kullanımı (sayaçlar son istatistik sıfırlamadan beri; süreyi not et)
SELECT s.relname, s.indexrelname, s.idx_scan, pg_size_pretty(pg_relation_size(s.indexrelid)) size
  FROM pg_stat_user_indexes s
 WHERE s.relname LIKE 'price_point%' OR s.relname IN ('offer','offer_variant','product','embedding')
 ORDER BY s.relname, s.idx_scan;
SELECT stats_reset FROM pg_stat_database WHERE datname = current_database();

-- 3) HOT oranı ve vacuum davranışı
SELECT relname, n_tup_upd, n_tup_hot_upd,
       round(100.0 * n_tup_hot_upd / nullif(n_tup_upd,0), 1) AS hot_pct,
       last_autovacuum, autovacuum_count, vacuum_count
  FROM pg_stat_user_tables WHERE relname IN ('offer','offer_variant','product');

-- 4) En pahalı sorgular (pg_stat_statements varsa)
SELECT calls, round(mean_exec_time::numeric,2) AS mean_ms, round(total_exec_time::numeric) AS total_ms,
       left(query, 140) AS q
  FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 20;

-- 5) Ortalama satır genişliği (varsayımları doğrular)
SELECT 'offer' AS t, avg(pg_column_size(o.*))::int AS bytes FROM offer o TABLESAMPLE SYSTEM (1)
UNION ALL SELECT 'attributes_raw', avg(pg_column_size(attributes_raw))::int FROM offer TABLESAMPLE SYSTEM (1)
UNION ALL SELECT 'product', avg(pg_column_size(p.*))::int FROM product p TABLESAMPLE SYSTEM (1);
```

Bu sorgular hiçbir şey yazmaz; üretimde çalıştırmadım.

---


## Ek B — Rev 3: uygulananlar, doğrulamalar ve bilinçli ertelenenler (2026-10-07)

Rev 2 korunur. Bu ek, A grubunun ne olduğunu, `origin/main` (PR #44/#46) ve Shopify dalının
**güncel** (`2403ab4`) gerçekliğiyle yeniden doğrulanmasını ve ne YAPILMADIĞINI kaydeder. Üretim
DB'sine bağlanılmadı, migration uygulanmadı, ingest çalışmadı, deploy/birleştirme yok.

### B.1 Güncel kodla uzlaşma — çözülmüş şeyler artık problem değil

| Konu | Durum (kodla doğrulandı) |
| --- | --- |
| Tek büyük işlem | ÇÖZÜLDÜ — chunk başına commit + atomik checkpoint (`collect/pipeline.py`, ADR 0065, yeni numara 0067) |
| Satır satır yazıcı | ÇÖZÜLDÜ — `write_batch` (`unnest`, ~9 ifade/chunk) |
| Her koşuda `price_point` | ÇÖZÜLDÜ — değişim olayı; tazelik `last_seen_at` |
| Retry/checkpoint/devam/advisory lock | ÇÖZÜLDÜ (koşu düzeyi); dead-letter yok, `xml_feed` hâlâ `BytesIO` |
| Satır satır çözümleyici (0,67 offer/sn) | ÇÖZÜLDÜ (round-trip) — `resolve/batch.py` ≈54 offer/sn (üretim ölçümü); tam-katalog trigram aday üretimi kalıyor |
| Migration `0050` çakışması | ÇÖZÜLDÜ (Shopify dalı: `0051` + `renamed.json`); bu dalın önceki `0051`/ADR 0066 önerisi geri çekildi |
| Hâlâ açık | Her koşuda tam offer/varyant satırı yeniden yazımı (§7.2), `xml_feed` akışı, `full_dump` sanity kapısı, arama O(N), 120M için R2 staging |

Etki: §7.3'te çözümleyici süreleri güncellendi (≈54/sn: 1M ≈ 5,1 sa; 120M ≈ 25,7 gün, iyimser).

### B.2 Migration `0051` son uzlaştırması

Gerçek `migrate.ts` + `renamed.json`, Shopify dalı `origin/main`'e birleştirilmiş atılabilir ağaçta.
Çalıştırıcı kimliği dosya adının tamamı (`schema_migration.filename` PK); sayısal önek ve checksum yok.
Hepsi yerel Docker PG16'da geçici veritabanlarında; silindi.

| Senaryo | Sonuç |
| --- | --- |
| Sıfırdan kurulum | 49 migration; sıra 0049 → 0050_early_access → 0051; yeniden çalıştırma "uygulanacak yok" |
| Üretim-öncesi defter: `0050_ingest_run_checkpoint.sql` kayıtlı (iki 0050 birlikte uygulanmış) | `--plan` taşımayı gösterir; `migrate` defter satırını `0051` adına **tek işlemde taşır, SQL çalışmaz**. Kanıt: önceden konan `COMMENT` sentinel'i yerinde kaldı (SQL çalışsaydı ezilirdi); şema imzası aynı |
| Üretim-şimdi: defterde zaten `0051` (taşınmış) | hiçbir şey bekleyen değil |
| Kolonlar var, defterde ikisi de yok | `0051` etkisiz çalışır (`ADD COLUMN IF NOT EXISTS`); şema imzası değişmez |
| Hiç checkpoint kolonu olmayan ortam | `0051` kolonları ekler; imza sıfırdan kuruluma eşit |
| Defterde hem eski hem yeni ad | **durur** ("Defter tutarsiz"); satırlar değişmez |
| Çıplak SQL yeniden çalıştırma (kolonlar var) | `ALTER/COMMENT` etkisiz; kolon türü/varsayılan imzası değişmez |

Dört ortamın `ingest_run` imzası (`information_schema.columns` özeti) aynı. Not: Shopify'ın `0051`'inde tür
denetimi yok; kolonlar üretimde zaten doğru türde olduğundan gerekmez, başka bir ortam için `\d ingest_run` yeterli.
Birleştirmedeki tek çatışma `migrations/README.md` satırlarıdır (docs).

### B.3 ADR numaralandırması

Karşılaştırma (`origin/main`, Shopify dalı, bu dal): 0065 ve 0066 iki ayrı kararda kullanılıyor
(`main`: erken erişim sayacı / yapay zekasız fallback; Shopify: chunk'lı toplama / toplu eşleştirme).
Migration geçmişine bağlı olmayan tarafın yeniden numaralanması önerildi: Shopify 0065→0067,
0066→0068 (21 dosya, 38 atıf; uygulanmış migration dosyalarına ve `renamed.json`'a dokunulmaz,
ADR başlığına "eski numara" notu). Bu dalda: ADR 0069 (fiyat parser), `docs/decisions/README.md`
tahsis tablosu, `pnpm check:adr`. Kuru çalışma atılabilir bir ağaçta yapıldı: Shopify ucu yeniden
numaralanıp `origin/main` birleştirilince ADR numaraları benzersiz, kalan 0065/0066 atıfları yalnız `main`'e ait.
**Shopify dalının dosyaları bu görevde DEĞİŞTİRİLMEDİ**; uygulama o dalın sahibine ait.

### B.4 Bu dalda uygulananlar

| Ne | Nerede |
| --- | --- |
| Fiyat parser genişletmesi, `filters.currency="TRY"`, bağlam kuralları + kural-belgeleyen testler (ADR 0069) | `search/price-patterns.ts`, `parse-query.ts`, `types.ts`, `clarification/compile.ts` |
| `/ara` akışında gerçek PostgreSQL entegrasyon testi (`resolveQuery → searchWithFallback → PG`), 17 test | `search/price-search.integration.test.ts` |
| Salt okunur telemetri: `pnpm db:catalog-telemetry`, sızıntı/hata temizleme, `pg_stat_statements` yoksa zarif atlama | `packages/db/scripts/catalog-telemetry.ts` (+ test) |
| `pnpm db:lint-migrations`, `pnpm check:adr` | `packages/db/scripts/lint-migrations.ts`, `scripts/check-adr-numbers.mjs` |
| Entegrasyon dosyalarını ardışık koşturma (ortak DB'de fixture'lar birbirinin sonucunu etkiliyordu) | `packages/core/vitest.integration.config.ts` (`fileParallelism: false`) |
| Admitad feed intake kontrol listesi | `docs/admitad-feed-intake.md` |
| Önbellek notu (`query_resolution` parser değişince temizlenir) | `docs/ops.md`, ADR 0069 |

Entegrasyon bulgusu: parser'ın önek işleçleri `max`/`min` içeriyordu; `iphone 17 pro max 60 bin altı` içinde
`max` (model adı) tüketiliyordu. Gerçek-akış testi yakaladı, işleçler çıkarıldı. Ayrıca eski `query_resolution`
satırları yeni ayrıştırmayı gizler (test kanıtlıyor): yayında tablo bir kez temizlenir (ops.md).

### B.5 Bilinçli olarak UYGULANMAYANLAR

| İş | Grup | Neden şimdi değil |
| --- | --- | --- |
| OpenSearch / arama motoru | **AT SCALE** (~5–10M ürün) | PoC ve HA; mimari sınır ADR'si |
| ClickHouse | **AT SCALE** (koşullu) | Değişim-yalnız hacim PG'de yönetilebilir |
| Ayrı katalog PostgreSQL | **AT SCALE** (~10–50M) | Supabase'te kalınır |
| `product_identity` | **BEFORE ADMITAD / AT SCALE** | Feed tanımlayıcıları bilinmeden anahtar türü kilitlenmez |
| Parmak izi/yaşam döngüsü kolonları | **BEFORE ADMITAD** (B10/B11) | Tazelik sözleşmesi (ADR 0067) önce karara bağlanmalı |
| Autovacuum / fillfactor | **BEFORE ADMITAD** (B9) | Telemetriye dayanır; bulk yüklemeden önce |
| Çift indeks düşürme | **AT SCALE**, telemetriyle | Kodda adıyla kullanılıyor |
| Tüm kataloğa embedding | **AT SCALE** (kademeli) | 25 görsel/dk |
| Tüm görselleri R2'ye mirror | **Yapılmayacak**; tembel mirror **BEFORE ADMITAD** | Hukuki + teknik |
| Eşzamanlı Gemini / KVKK / ADR 0059 | **Karar bekliyor** (§8.3) | Politika bypass yok; bu görevde dokunulmadı |
