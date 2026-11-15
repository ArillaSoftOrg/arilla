# 0196 — BGE-M3 sorgu servisi, kanarya kapısı ve model-bilinçli anlamsal sunum

Durum: **kabul (kod), etkinleştirme bekliyor.** Migration yok. İlgili: 0170, 0178, 0182, 0186, 0189,
0190, 0195. `Depends on #338` (0195, migration 0114).

## Bağlam

- Sunum (0190) yalnız Jina'yı biliyordu: tek sorgu istemcisi (Jina API), tek tablo (768), tek birleştirme
  (mutlak kosinüs kapısı + RRF).
- BGE-M3'te alakasız ürünler de 0,45–0,61 kosinüs alır; Jina için seçilmiş mutlak eşik çalışmaz (E4).
  E4'te geliştirilen koşullu hybrid (lexical ilk blok korunur, anlamsal eklemeler sorgu-içi göreli eşikle
  ve aday temizliğiyle girer) bunu çözer; ama yalnız çevrimdışı kullanılıyordu.
- BGE-M3'ün yoğun vektörü CLS havuzlamadır. Yanlış havuzlama norm kapısından geçer ama vektör uzayı başka
  olur ve sıralama sessizce bozulur (0182).

## Karar

1. **Aynı sunum, model-bilinçli.** `SemanticIndex` `provider` (`jina` | `remote_http`), `endpoint` ve
   `fusion` (`rrf_gate` | `conditional_hybrid`) taşır. `/ara` ve `/sohbet` değişmez: ikisi de ortak
   `serveSemantic` → `applySemanticServing`. Jina davranışı birebir aynıdır (parite testi).
2. **Sorgu servisi (`remote_http`).** OpenAI uyumlu `POST {url}/v1/embeddings` (TEI), **toplu iş
   servisinden ayrı** adres (`EMBED_BGE_M3_QUERY_URL`, isteğe bağlı `EMBED_BGE_M3_QUERY_TOKEN`).
   - Adres: HTTPS ya da yerel/özel ağ (loopback, RFC1918, tek etiketli Docker servis adı); kimlik
     bilgisi/sorgu/parça/yol yok. Geçersizse istemci hiç kurulmaz (`no_endpoint`).
   - Sorgu metni **önek olmadan**, yalnız boşlukları sadeleştirilerek gönderilir (BGE-M3'te resmî önek yok).
     Kullanıcının özgün sorgusu değişmez.
   - Uzay kapısı: yanıttaki `model` = servisin bildirdiği (`BAAI/bge-m3`), boyut 1024, tüm değerler sonlu,
     norm ≈ 1 (±0,02). Biri tutmazsa vektör KULLANILMAZ (`bad_payload`).
   - Tek deneme, 1,5 sn zaman aşımı, süreç geneli önbellek (model + sorgu), hata → `null`.
   - Anahtar, adres ve sorgu metni hiçbir hata ya da günlük çıktısına girmez (test).
3. **Kanarya kapısı.** Servis, resmî sentence-transformers referansının altın vektörleriyle (Python
   `enrich.canary` ile aynı vektörler ve eşik 0,9994; parite testi dosyaları eşitler) doğrulanana kadar
   gerçek sorgu vektörü üretilmez. İlk kullanımda arka planda çalışır ve isteği BEKLETMEZ (o ana kadar
   sonuç metin aramasıdır); 6 saat sonra arka planda yeniden doğrular (kayıp varsa kapı kapanır, başarısız
   kanarya 5 dk sonra yeniden denenir). Kanarya çağrıları önbelleksizdir ve `api_usage`'a yazılmaz.
4. **Sağlık ve devre kesici.** Mevcut süreç içi devre kesici (0190) uzak servise de uygulanır
   (`bad_payload`/`timeout`/`network`/`server` art arda → kısa bekleme); ayrıca `GET /health` sondası
   (`probeServiceHealth`) operasyon betikleri içindir. Kullanım `api_usage`'a yazılır (kural 9, maliyet 0).
5. **Koşullu hybrid (yalnız BGE).** `fuseForIndex`: `conditional_hybrid` ise E4'ün `hybrid-policy.ts`
   (49 sorguluk geliştirme kümesinde seçildi; AI destekli ön değerlendirme) kullanılır: metin sonuçları
   HİÇ düşmez; güçlü lexical'de ilk 3 dokunulmaz; anlamsal eklemeler yalnız aday temizliğinden (teknik kod,
   olumsuzlanan özellik, karşıt özellik, aksesuar, gürültü) ve göreli eşikten geçerse girer; en fazla
   `SEMANTIC_SERVING_MAX_ADDED` (8). Kesin kategori ve fiyat süzgeci SQL'de (aday) ve kart yüklemede
   uygulanır, gevşetilmez. **C+ (çeviri/yazım) bu yola bağlı DEĞİLDİR**; çeviri vektörü sıralamada kullanılmaz.
6. **Hazır olma kapıları (hepsi birden; biri tutmazsa sonuç = metin araması):** mod `on`; sorgu uygunluğu
   (KVKK); aktif indeks model ve QUERYABLE; sağlayıcı sağlıklı; envanterde HAZIR, geçerli, model ve sürüm
   uyumlu HNSW; strateji seçici `global_hnsw`/`exact_btree`; kanarya geçti; günlük tavan. Kayıt defterinde
   model `disabled` ve `license_verified=false` kaldığı sürece `enrich.index activate` zaten reddeder;
   açık `SEMANTIC_EMBEDDING_MODEL` ayarı da HNSW olmadan hiçbir şeyi açmaz.

## Ölçüm (yerel, 14 Kasım 2026; 160.017 gerçek ürün, 160.017 vektör `enrich.vector_import` ile alındı)

Ortam: Docker Desktop (Windows), PostgreSQL 16 + pgvector 0.8, `shared_buffers=128MB`, yerel TEI
cpu-1.9.4, 2 vCPU sınırı. Üretim KVM'si ile **aynı değildir**; yön gösterir.

**HNSW (kısmi, `halfvec_cosine_ops`, m=16):**

| | ef_construction=64 | ef_construction=200 |
|---|---|---|
| Kurulum | 106 sn (3 paralel işçi; `maintenance_work_mem` 64 MB: "graph no longer fits" uyarısı) | 187 sn (seri, 1 GB) |
| Boyut / WAL / bellek tepe | 394 MB / 360 MB / 1,4 GiB (CPU 3 çekirdek) | 394 MB |
| recall@10, ef_search=40 / 100 / 150 / 400 | 0,75 / 0,85 / 0,88 / 0,93 | 0,78 / 0,87 / **0,92** / **0,96** |
| recall@150 (aday penceresi), ef=150 / 400 | 0,82 / 0,92 | 0,86 / 0,95 |
| kategori süzgeçli recall@10 (HNSW + sonradan süzme), ef=150 / 400 | 0,91 / 0,97 | 0,93 / 0,98 |

- 120 çok dilli sorgu, tam tarama gerçeğine karşı, mesafe tabanlı recall (yinelenen vektörler haksız
  düşük recall vermesin diye; kimlik örtüşmesi 0,01 kadar daha düşük çıktı).
- **Recall sorunu gizlenmez:** `ef_construction=64` ile ef=150'de recall@10 yalnız 0,88 (E3-d'nin 50 bin
  vektörlük ölçümünde 0,97+ idi; ölçek ve sorgu karışımı farkı), bazı sorgularda sıfıra yakın. Bu yüzden
  indeks `ef_construction=200` ile kurulmalıdır (0195). ef=150'de bile ilk 10'un ~%8'i kaçırılır; bu yalnız
  ANLAMSAL EKLEMELERİ etkiler: lexical sonuçlar hiçbir zaman HNSW'ye bağlı değildir ve hiç düşmez.
- Kategori süzgecinde HNSW'ye güvenilmez: strateji seçici (0189/0190) küçük kategoride `exact_btree`, büyükte
  anlamsal ekleme yapmaz.
- Gecikme (HNSW top-10): p50 6 ms, p95 8,5 ms (ef=150); ef=400: p50 11, p95 16 ms. Aynı sorgu indekssiz
  tam taramada p50 116 ms. Sunumun gerçek aday sorgusu (ef 150, k 150): p50 13,7, p95 16,8 ms.

**Uçtan uca (gerçek `serveSemantic`, gerçek lexical, gerçek HNSW, gerçek TEI + kanarya; 80 sorgu):**

| | Değer |
|---|---|
| Kanarya | geçti, min kosinüs 0,99998 |
| Sunum sonucu | 60 `served:fused`, 11 `served:no_new_candidates`, 9 `skipped:lexical_empty` |
| Metin sonucu düşen sorgu | **0**; göreli sırası değişen 35 (RRF teyidi ve olumsuz/aksesuar indirme; tasarım gereği) |
| Servis kapalıyken (ölü port) | 80/80 sonuç lexical ile **birebir aynı** |
| Eklenen ürün | sunulan sorgu başına ort. 5,9, en çok 8 |
| Gecikme (sıcak, yerel) | toplam p50 132 / p95 177 ms; sorgu embedding p50 100 / p95 136 ms; aday+benzerlik SQL p50 21 / p95 33 ms |
| Soğuk başlangıç | HNSW ilk sorgularda soğukken 6/80 sorgu 400 ms SQL süresini aştı (`error:timeout`); sonuç metin araması (güvenli). Üretimde indeks ısıtması (`pg_prewarm`) önerilir |

**Kalite (AI destekli ön değerlendirme; insan etiketi DEĞİL; puanlanmamış ürün 0 sayılmaz, yoğun metrik;
64 etiketli sorgu). Karşılaştırma tabanı: bugün kullanıcıya görünen davranış = yalnız lexical:**

| | A lexical | B lexical + BGE-M3 | B − A (%95 GA) |
|---|---|---|---|
| nDCG@10 (tümü) | 0,397 | 0,522 | +0,126 (0,054 – 0,198); 29 kazanır / 17 kaybeder |
| MRR | 0,633 | 0,781 | +0,105 (0,044 – 0,176) |
| P@10 | 0,581 | 0,673 | +0,040 (−0,019 – 0,100) |
| geliştirme kümesi (37; politika bunlarda seçildi) nDCG | 0,336 | 0,479 | |
| doğrulama kümesi (27; politika seçiminde kullanılmadı) nDCG | 0,479 | 0,581 | |

- 13 sorguda nDCG 0,05'ten fazla düştü (ör. Q21 "kabin boy valiz" 0,78→0,21, Q05 0,92→0,54, Q43
  0,78 vs 1,00); bunların bir kısmı puansız ürünlerden olabilir, insan kontrolü yok.
- Bu **Jina'lı hybrid ile karşılaştırma değildir** (yerelde Jina vektörü ve anahtarı yok; ücretli).
  E4'ün kör çevrimdışı ölçümünde BGE koşullu hybrid ≈ eski hybrid (nDCG 0,699 vs 0,700) ve teknik özellik
  uyuşmazlığı %30 → %0 idi.
- Etiket havuzları BGE yoğun sonuçlarını da içerir; tam bağımsız bir doğrulama değildir. İnsan etiketi
  ve bağımsız yeni sorgu kümesi gereklidir.

## Bilinen sınırlar

- Aksesuar koruması (0170) yalnız İngilizce başlıkları tanır; Türkçe başlıklı (HB) aksesuarlar bu kapıdan
  geçmez. Çok dilli aksesuar/tür tespiti ayrı iştir.
- Sorgu dili/ürün başlığı dili sabit kodlanmaz: BGE-M3 çok dilli, yeni dil için ürün vektörü yeniden
  üretilmez; ancak çok dilli doğruluk yalnız TR/EN/DE sorgularla (etiketsiz) sınandı.
- Kategori süzgeci olan büyük kategorilerde anlamsal ekleme yapılmaz (HNSW recall).
- 12 milyon ürün: HNSW (394 MB / 160 bin → ≈ 30 GB) belleğe sığmaz (E3-d); ayrı karar.

## Üretime alma ön koşulları (hepsi insan onaylı; bu PR hiçbirini yapmaz)

1. PR #338 (migration 0114) uygulanmış; vektörler `enrich.vector_import` ile alınmış ve `verify` temiz.
2. Sorgu servisi (ayrı TEI, `embed-query`) kurulu ve sağlıklı; `EMBED_BGE_M3_QUERY_URL` tanımlı.
3. HNSW (`ef_construction=200`) ayrı `concurrent` migration PR'ıyla kurulmuş; ısıtılmış.
4. Kayıt defterinde model durumu ve `license_verified` insan/hukuk onayıyla; `enrich.index activate`.
5. `SEMANTIC_SEARCH_MODE=shadow` ile gözlem, sonra `on`. Geri alma: tek bayrak (`shadow`/`off`).

## Reddedilen

- Mutlak kosinüs eşiğini BGE'ye taşımak (E4: alakalı/alakasız örtüşür).
- Sorgu çevirisi/C+ ile genişletmek (kalite avantajı kanıtlanmadı; E4b).
- Kanaryasız servis (norm kapısı yanlış havuzlamayı yakalamaz).
- Toplu iş servisini sorgu için paylaşmak (canlı sorgu ve toplu iş ayrı havuzlarda çalışır; 0182).
