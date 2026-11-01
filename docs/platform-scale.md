# Çok kaynaklı katalog: ölçek analizi (karar 0163)

Hedef: 10M+ benzersiz ürün, birden çok platform, binlerce satıcı, çok sayıda teklif, fiyat geçmişi.
Bu belge **doğrulanmış bir kapasite iddiası değildir**; neyin ölçüldüğünü, neyin yalnızca hesaplandığını
ve neyin hiç bilinmediğini ayırır. Satır numaraları 31 Ekim 2026 itibarıyla `feature/multi-source-catalog-core`.

## 1. Ölçülen ve ölçülmeyen

**Ölçülen (kaynaklı):**

- Üretimde yaklaşık 2,77 M yayınlanmış ürün ve ~2,8 M teklif eklemesi var (`docs/decisions/0136-arama-olay-kuyrugu-tuketicisiz.md`
  satır 8-10). Yani gerçek yük şu an **~3M ürün mertebesinde**, hedefin %30'u.
- Yerel 1,04 M ürünlük katalogda `/ara` 33 sorgu: p50 94 ms, p95 887 ms, geçici yükte en kötü 3,6 sn
  (aynı belge, satır 20-23). Tek makine, tek kullanıcı; eşzamanlı yük ölçülmedi.
- Kapı (`catalog_build/gate.py:20-22`) ilk koşusunu 2,5 M satırda yaptı; tabloyu yeniden yazmamak için
  `foreign_blocked` satırları bilerek yazılmıyor.
- `search_outbox` satır boyutu yerelde ölçüldü: ~143 B/satır (0136 Ek A).
- Bu işte: saf Python hızı (bölüm 4). **Veritabanı içermez.**

**Ölçülmeyen (açıkça):**

- **10M ürün / 30M teklif hiçbir yerde doğrulanmadı.** Aşağıdaki GB ve satır/gün rakamları hesaptır,
  ölçüm değildir.
- 10M'luk `product` üzerinde GIN trigram sorgu süresi, HNSW (10M+ vektör) geri çağırma/gecikme/inşa süresi,
  `similarity` toplu işinin tam koşusu, aylık `price_point` bölümünün 30-60M satır/gün altında vacuum ve
  WAL davranışı, çoklu platformun aynı anda yazması, replikasyon (yedek aktif ama replika yok).
- Gerçek platform değişim oranı (günlük fiyat değişen teklif yüzdesi). Aşağıda varsayım olarak %5-15 alındı.
- Redis kuyruğu: katalog yazma yolunda değil (link çözümleme ve görsel işleri); 10M ölçeğinde yük ölçülmedi.

## 2. Darboğazlar (kanıtla, olasılık/etki sırasıyla)

Varsayımlar: 10M ürün, ürün başına ~3 aktif teklif = **30M aktif teklif**; 1-2 yenileme/gün.

### 2.1 `price_point` hacmi ve WAL (en yüksek risk, hesaplanmış)

`price_point` aya göre bölünmüş, PK `(offer_id, observed_at)` (`docs/schema.sql:359-366`). Satır başı
~64 B yığın + ~36 B PK indeksi ≈ **~100 B/satır** (tahmin; `pg_total_relation_size` ile doğrulanmalı).

| Yazma politikası (30M teklif) | satır/gün | GB/gün | satır/ay | GB/ay |
|---|---|---|---|---|
| Her yenilemede, 1x/gün | 30 M | ~3 | 900 M | ~90 |
| Her yenilemede, 2x/gün | 60 M | ~6 | 1,8 B | ~180 |
| Yalnız değişimde, %5 değişim | 1,5 M | ~0,15 | 45 M | ~4,5 |
| Yalnız değişimde, %15 değişim | 4,5 M | ~0,45 | 135 M | ~13,5 |

İki yazıcı **farklı** davranıyor, tutarsızlık kendi başına bir bulgu:

- `feeds/sync.py:300-306`: yalnız yeni/yeniden etkin/fiyat-liste-stok değişen teklif için yazar
  (change-only). Besleme yolu tabloyu şişirmez.
- `collect/writer.py:7-9,128-135`: **fiyat değişmese de her gözlemde** yazar ("süreklilik veridir").
  HB kotası (20k/gün) bunu sınırlıyor; kotasız bir platform (`registry.py`) bu yolu seçerse tablo
  yukarıdaki ilk iki satır hızıyla büyür.
- Karar gerekir: "değişmedi" gözlemi kaydı mı (kesintisiz seri, ağır) yoksa `last_seen_at` mı (hafif).
  `flow.ChangeFilter` ikincisini destekler (değişmeyen için yalnız `touch_seen`).

WAL: satır başı tahmini ≥1,5-2x (yığın + PK + tam sayfa yazımı; `wal_compression=zstd`, `docs/ops.md:272`
bunu azaltır). 30M satır/gün için yalnız `price_point`'ten **~5-6 GB WAL/gün**; üzerine `offer` güncellemeleri.
`wal_pressure` eşikleri: hedef 1 GiB, duraklama 1,5 GiB arşivlenmemiş WAL (`db/wal_pressure.py:122-124`),
`max_wal_size=16GB`. Arşiv hızı üretimin altındaysa iş saatlerce durur (`max_pause_s=3600`, satır 126).

### 2.2 `product` ve `offer` yazma amplifikasyonu (yüksek)

- `product` üzerinde ~16 indeks (`docs/schema.sql:119-147`), bunların **4'ü GIN trigram**: `product_title_trgm`
  (131), `product_title_fold_trgm` (135), `_try_trgm` (140), `_foreign_trgm` (143). Kısmi yüklemler
  (`publication_state`, `offer_count`) indekslenmiş kolon sayılır: bu kolonlar değişince satır başka GIN'e
  taşınır ve HOT güncelleme devre dışı kalır.
- `product_min_price_idx` (146) `min_price`'ı indeksler; her fiyat toplamı değişimi **HOT dışı** güncelleme
  = 16 indeksin tümüne yeni girdi. `offer` için aynı: ~13 indeks (`schema.sql:198-275`), `offer_active_price_idx`
  (269) `current_price` değişince HOT'u bozar. Eşik: 1-3M değişen teklif/gün, her biri 13+16 indeks yazımı.
- GIN `fastupdate` bekleme listesi toplu yazımda arka planda birikir; arama p95'ine yansıması ölçülmedi.
- `offer_unmatched_title_fts` (275) ayrı bir GIN; eşleşmemiş yığın büyüdükçe büyür.
- İlk inşa: 10M başlıkta 3 GIN (partial) + 1 HNSW'nin `CREATE INDEX` süresi ve bellek ihtiyacı bilinmiyor;
  üretimde `CONCURRENTLY` ve `maintenance_work_mem` ayarı gerekir.

### 2.3 Embedding ve pgvector boyutu (yüksek, hesaplanmış)

`embedding.vector vector(768)` (`schema.sql:416`) = 4·768+8 = **3.080 B**/vektör, satır ≈ 3,2 KB.

| Kapsam | vektör | ham yığın | HNSW (tahmin ~1-1,5x) |
|---|---|---|---|
| 10M ürün, 1 vektör | 10 M | ~32 GB | ~32-48 GB |
| 30M teklif, 1 vektör | 30 M | ~96 GB | ~96-145 GB |
| 30M teklif, görsel + metin | 60 M | ~192 GB | ~190-290 GB |

`embedding_ann_idx` yalnız `target_type='offer'` için (`schema.sql:420-422`): hedef 30M teklif ise 100+ GB
indeks; çalışma kümesi RAM'e sığmazsa ANN sorguları disk-bound olur. Bu, tek VPS için sert bir sınırdır.
Ek olarak embedding üretim maliyeti (Jina; görsel token maliyeti ve 100k TPM sınırı) katalogla doğrusal artar:
10M görsel embedding'in süresi/parası hesaplanmadı. HNSW'nin 10M+ ölçeğinde geri çağırma kalitesi (`ef_search`) ölçülmedi.

### 2.4 `similarity` toplu işi (yüksek, kod okumasıyla)

- `similarity/edges.py:76-86` (`FILL_CENTROIDS`): **tüm kataloğun ürün merkez vektörlerini tek ifadede TEMP
  tabloya** yazar. 10M ürün ≈ **~31 GB geçici tablo** + `avg(vector)` GROUP BY sıralaması. Parti parti değil.
- `edges.py:105-114`: ürün başına bir HNSW araması, `ANN_FETCH=60` (satır 49) → 10M·60 = 600M aday satırı
  taranır, `TOP_N=8` (satır 38) tutulur. HNSW sorgu başına ms düzeyi varsayılırsa 10M ürün için ~saatler-günler
  (varsayım; ölçülmedi). Her koşuda tam yeniden hesap: artımlı değil.
- `similarity_edge` büyümesi: ürün başına 8 kenar/tür → 80 M kenar/tür; satır ~56 B + PK + `similarity_lookup_idx`
  (`schema.sql:452-462`) ≈ ~130 B → **~10 GB/tür**; dört tür (`same,visual,semantic,substitute`) ile ~40 GB.
  Ürün çıkınca/değişince eski kenarların temizliği ayrı iş.

### 2.5 Kapı ve yayın taraması (orta)

Düzeltme: kapı **her parti için tüm tabloyu taramaz**; `id > after` ile anahtarlı ilerler (`gate.py:39-47`,
`LIMIT`). Gerçek maliyet: **her koşuda yayınlanmamış tüm ürünler bir kez** taranır (artımlı değil) ve her
satır `offer` + `feed_source_offer` LATERAL (`gate.py:55-67`) birleşimi yapar. 10M taslak için 2.000 parti
(5.000/parti); yazılan yalnız değişenler (`gate.py:84-86`), yani WAL maliyeti düşük, **okuma** maliyeti doğrusal.
`publish.py:39-52` `ready` satırlarını `FOR UPDATE SKIP LOCKED` ile alır; kısmi `product_unpublished_idx`
(`schema.sql:123`) bunu karşılar, ama kapının `IN ('draft','held','ready')` yükleminin aynı kısmi indeksi
kullandığı **EXPLAIN ile doğrulanmadı**. `feed_source_offer` (`schema.sql:2434-2445`) 30M+ satır, fillfactor 70.
`product_aggregate_values` (`schema.sql:203-226`) `count(DISTINCT merchant_id)` ile ürün başına birleşim; 
toplu yenilemede 10M ürünle maliyeti ölçülmedi.

### 2.6 Eşleştirme / çözümleyici (orta)

`resolve/candidates.py:45`: her eşleşmemiş teklif için `p.title % :title ... ORDER BY similarity()`;
`product_title_trgm` üzerinde. Yaygın üç-gramlı kısa başlıklarda GIN trigram aday sayısı patlar
(10M'luk tabloda ölçülmedi). Çok kaynaklı alımda eşleşmemiş teklif sayısı = yeni platformun tamamı;
bu yol kaynak başına bir kuyruk değil, ortak bir darboğazdır. `listing_only` kaynaklar bu yolu atlar (karar 0130).

### 2.7 `search_outbox`, Redis, arama (düşük-orta)

- `search_outbox` tüketicisiz (0136): sınırsız büyür (5,57M satır ≈ 800 MB bugün). Karar 0146 yalnız içerik
  değişiminde yazmayı sağladı; yine de 10M üründe ekleme + her başlık/görsel değişimi satır üretir.
- Arama doğrudan `product`/`offer` okur (0136); 1M'de p95 887 ms ölçüldü. 10M'de GIN sorguları için
  doğrusal-üstü bozulma olası ve ölçülmedi. Redis arama önbelleği/limit içindir, katalog yolunda değil.

### 2.8 Sıralı özet (ilk beş)

1. `price_point` hacmi + WAL (politika kararı: değişmediğinde yaz/yazma).
2. `product`/`offer` indeks amplifikasyonu (16+13 indeks, 4 GIN trigram, HOT kaybı).
3. Embedding + HNSW boyutu (100+ GB) ve inşa/çalışma kümesi.
4. `similarity` tam yeniden hesap (31 GB TEMP, 600M ANN adayı).
5. Kapı/yayın artımsız tam geçiş + `feed_source_offer` birleşimleri.

## 3. Yük testi planı (yalnız yerel/ücretsiz; ASLA üretim)

**Ortam:** tek kullanımlık yerel pgvector konteyneri (Windows'ta
`localhost` yerine `127.0.0.1` kullan), `docs/schema.sql` yüklü, `wal_level=replica`, `archive_mode=on` (yerel dizine,
üretimdeki gibi arşiv gecikmesi görmek için), `max_wal_size=16GB`, `wal_compression=zstd`. Disk: 10M için
~400 GB boş alan gerekir; yoksa 1M ve 5M ile durup doğrusal/doğrusal-üstü eğilimi raporla. Üretim DB'sine,
VPS'e ya da ağa bağlanma.

**Veri üretimi** (Python `COPY`, sabit tohum, `platforms.contract` ile uyumlu):

| Aşama | ürün | teklif | satıcı | `price_point` | embedding |
|---|---|---|---|---|---|
| S1 | 330 k | 1 M | 3 k | 7 gün x 1 M, %10 değişim | 1 M (rastgele birim vektör) |
| S2 | 1,7 M | 5 M | 10 k | 7 gün | 5 M |
| S3 | 3,3 M-10 M | 10 M-30 M | 30 k | 7 gün change-only + 1 gün tam | 10 M |

Gerçekçilik: Zipf satıcı dağılımı, başlık metni gerçek katalog örneğinden (üretim verisi KOPYALANMAZ;
kamuya açık/üretilmiş başlık), ürün başına 1-8 teklif, ~%30 teklif sıfır eşleşmeli, kategori ağacı 3 düzey.

**Zamanlanacak işler / sorgular** (her biri 3 tekrar, soğuk + sıcak önbellek ayrı):

1. Toplu yazma: `feeds/sync` upsert yolu ile 1M teklif; teklif/sn, WAL bayt/teklif, `pg_total_relation_size`.
2. `price_point` ay bölümüne 30M satır `INSERT`; vacuum/autovacuum süresi, WAL/gün.
3. `catalog_build gate` ve `publish` tam geçiş; parti süresi dağılımı, `EXPLAIN (ANALYZE, BUFFERS)` ile
   kısmi indeks kullanımı (bölüm 2.5'teki doğrulama).
4. `CREATE INDEX` trigram x3 ve HNSW süresi + tepe bellek; `CONCURRENTLY` ile.
5. `similarity` tam koşu (centroid TEMP boyutu, `pg_stat_statements`, süre).
6. Arama: 100 sorgu karışımı (kısa/uzun/yaygın üç-gram) eşzamanlı 8 istemci; `/ara` karşılığı SQL.
7. Resolver: 10k eşleşmemiş teklifi `resolve_offers` ile; aday sayısı ve süre.
8. Replikasyon/yedek: WAL arşiv hızı vs üretim hızı, `wal_pressure` duraklama süresi.

**Geçti/kaldı eşikleri (önerilen; ölçümden sonra gözden geçir):**

| Ölçü | Geçti | Kaldı |
|---|---|---|
| Besleme upsert hızı | >= 3.000 teklif/sn (30M/gün = 350/sn x 8 emniyet payı) | < 1.000 |
| 30M teklif tam yenileme süresi | <= 8 saat | > 24 saat |
| `price_point` büyümesi (change-only) | <= 0,5 GB/gün | > 2 GB/gün |
| Arşivlenmemiş WAL | pik < 1,5 GiB, `max_pause` tetiklenmez | duraklama > 1 saat |
| Arama p95 (8 eşzamanlı) | <= 1,0 sn (bugünkü 887 ms ölçüsü) | > 2 sn |
| Resolver | <= 300 ms/teklif p95 | > 2 sn |
| Kapı + yayın tam geçiş | <= 4 saat | > 12 saat |
| HNSW inşa | RAM içinde biter, kayıtlı bellek tavanı altında | takas (swap) |
| `similarity` tam koşu | <= 12 saat, TEMP < 40 GB | > 24 saat |

Çıktı: `docs/` altına tarihli ölçüm sayfası (ham sayılar, makine, ayarlar). Başarısız eşik, 2. bölümdeki
ilgili darboğazı "doğrulandı" olarak işaretler ve mühendislik gündemine girer (ör. artımlı similarity,
`price_point` politikası, ürün başına tek vektör).

## 4. Süreç içi karşılaştırma (Python, VERİTABANI YOK)

`services/ingest/scripts/bench_platforms.py --n 200000` (Python 3.12.10, Windows 11, tek çekirdek, 31 Ekim 2026).
Bu sayılar yalnızca **Python tarafının** darboğaz olup olmadığını gösterir; DB, indeks, WAL, ağ içermez.

| Ölçüm | ilan/sn |
|---|---|
| `CanonicalListing` oluşturma + doğrulama | 227.240 |
| `catalog_build.policy.evaluate` (kayıt defteri politikası) | 30.988 |
| `listing_fingerprint` (sha256) | 620.115 |
| `ChangeFilter.split` (ilk koşu / ikinci koşu) | 450.487 / 458.039 |
| `flow.run_source`, boş sink, batch 500 | 8.526.458 |
| `flow.run_source`, boş sink, batch 1000 | 4.613.057 |
| `flow.run_source`, boş sink, batch 5000 | 5.201.209 |
| `run_source` + `FilteringSink` batch 1000, ilk / tekrar | 443.298 / 376.830 |

Yorum: en yavaş Python adımı `evaluate` (~32 µs/ilan): 30M teklif için ~16 dakika/çekirdek; kimlik/parmak izi/akış
yükü ihmal edilebilir. Yani **darboğaz Python değil, veritabanıdır** (bölüm 2). Bu sonuç DB sayılarının
kanıtı değildir.
