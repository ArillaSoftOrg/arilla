# 0195 — BGE-M3 (1024 boyut) kalıcı depolama ve kontrol noktası içe aktarımı

Durum: **kabul (kod), uygulama bekliyor.** Migration: `0114`. İlgili: 0105, 0110 (0181), 0125, 0134,
0174, 0180, 0182, 0186, 0189, 0190. Bu karar, E4 deney dalındaki `0191-bge-m3-1024-depolama-taslak`
taslağının yerine geçer; taslağın numarası (0191) main'de başka bir karara verildiği için
yeniden numaralandı.

## Bağlam

- E4 (13 Kasım 2026): BGE-M3 (`bge-m3-5617a9f6`, revizyon `5617a9f6…`, CLS havuzlama, L2, 1024
  boyut) üretim sunucusunda (KVM 4) ayrı, sınırlı bir CPU konteynerinde 158.000 gerçek ürün
  başlığıyla gömüldü. Çıktılar `enrich.offline_embed` dosya kontrol noktalarındadır (float16,
  `content_hash`, `source_hash`, ürün kimliği, parça SHA-256'sı).
- 1024 boyutlu vektörlerin üretim tablosu yoktu; anlamsal sunum (0190) yalnız Jina (768) okuyabiliyordu.

## Karar

1. **`product_text_embedding_d1024`** (migration 0114, `kind: schema`): `product_text_embedding`
   (0105) ve `_d384` (0110) ile aynı sözleşme; `embedding halfvec(1024)`, **`STORAGE PLAIN`**
   (2 KiB vektör satır içinde; TOAST tablosu boş kalır, ölçüldü). Anahtar `(product_id, model_version)`:
   `model_version` model **ve revizyonu** taşır (`bge-m3-5617a9f6`); bir model/revizyon değişirse yeni
   satır kümesi doğar, eskisinin yerine geçmez. Mevcut Jina ve e5 verisine dokunulmaz.
2. **`embedding_index` kısıtları** yeni tabloyu ve 1024 boyutu kabul eder (`..._storage_table_check`,
   `..._table_dims`; temiz veritabanında adları doğrulandı). Migration yalnız tabloyu kurar:
   **`embedding_index` satırı, HNSW indeksi ve etkinleştirme yoktur.** Anlamsal sunum hazır indeks
   bulamadığı sürece tabloyu hiç sorgulamaz (0190).
3. **HNSW ayrı, yüklemeden sonra:** `kind: concurrent` migration, vektörler yüklendikten SONRA ve
   modele kısmi/sabit yüklemle (E3-d.1: genel planda doğru indeks seçilir). Yükleme sırasında indeks
   bakımı WAL ve süreyi katlar; bu yüzden aynı migration'da değildir. Ayrı PR, ayrı insan onayı.
   Taslak SQL: `CREATE INDEX CONCURRENTLY IF NOT EXISTS
   product_text_embedding_d1024_hnsw_bge_m3_5617a9f6_v1 ON product_text_embedding_d1024 USING hnsw
   (embedding halfvec_cosine_ops) WITH (m = 16, ef_construction = 200) WHERE model_version =
   'bge-m3-5617a9f6'`. **`ef_construction = 200`** (E4 taslağındaki 64 değil): 160.017 gerçek vektörde
   ölçüldü (karar 0196 §Ölçüm): recall@10 ef_search=150'de 0,88 → 0,92, ef=400'de 0,93 → 0,96; boyut
   (394 MB) ve sorgu gecikmesi aynı, yalnız kurulum süresi artar. Sürüm soneki (`_v1`) sunumun beklediği indeks sürümüyle eşleşmelidir (0190).
4. **İçe aktarım:** `python -m enrich.vector_import {plan|run|verify}` (Python; yalnız okur/yazar,
   migration üretmez — kural 5). Embedding ÜRETMEZ, model çağırmaz.
   - **Sözleşme kapısı (veritabanına dokunmadan önce):** bicim, model, revizyon, boyut,
     normalizasyon, havuzlama, ön işleme ve metin sürümü kayıt defteriyle birebir; parça boyutları
     ve SHA-256'ları; her vektör sonlu ve birim normlu. Biri tutmazsa TÜM koşu durur, hiçbir şey yazılmaz.
   - **Ürün/içerik kapısı (satır başına):** ürün var mı (yoksa `missing`); güncel başlık ve
     markadan kanonik metin yeniden üretilir, `content_hash` (model kimliğini de taşır) ve
     `source_hash` aynı mı (değişmişse `stale`, **yazılmaz**, ürün yeniden gömülür).
   - **İdempotans:** aynı `(ürün, model)` satırı aynı `content_hash` ve metin sürümüyle varsa
     `present` (yazılmaz, WAL üretmez). `ON CONFLICT … DO UPDATE … WHERE` yalnız içerik gerçekten
     farklıysa günceller.
   - **Devam:** durum veritabanındadır (parça işaretçisi yok); yarım kalan koşu tekrar çalışınca
     yazılanları atlar. Dilim başına ayrı işlem (varsayılan 250 satır).
   - **Frenler:** WAL geri basıncı (0134), `STOP` dosyası/SIGTERM, `--max-rows`, dilimler arası
     bekleme, oturum düzeyi danışma kilidi (tek koşu), ardışık 3 dilim hatasında dur.
   - **Yerel olmayan veritabanı** yalnız `--allow-remote` ile ve yalnız aşağıdaki insan onayından
     sonra yazılır; `plan` ve `verify` her yerde salt okunurdur.
   - **İş sonucu (0174):** `job_run.job = enrich_vector_import`; `completed`, `no_input`
     (`up_to_date`), `partial` (`wal_backpressure`, `interrupted`, `item_errors`,
     `consecutive_errors`), `failed` (`incompatible_checkpoint`), `skipped_locked`.
   - **Kullanım (kural 9):** her yeni satır yazan parça için `api_usage`'a bir satır
     (`operation = embedding_offline_import`, birim = parçanın benzersiz metin sayısı, maliyet 0).
5. **Model hazır olma koşulları (etkinleştirmeden ÖNCE hepsi):** (a) tablo dolu ve `verify` temiz;
   (b) HNSW kuruldu, geçerli ve beklenen sürümde; (c) kategori filtresi stratejisi (0189/0190)
   BGE için ölçüldü; (d) sorgu servisi (ayrı TEI) sağlıklı ve kanaryası geçti; (e) `online_query`
   kayıtta açık ve TS paritesi (`QUERYABLE_INDEXES`) tam; (f) insan: lisans/hukuk (`license_verified`) ve
   `enrich.index activate`. Bu karar hiçbirini yapmaz.
6. **Geri dönüş:** içe aktarım yeni satır ekler/aynı içerikle yenisini yazar; `DELETE FROM
   product_text_embedding_d1024 WHERE model_version = '…'` ile model satırları silinir (başka bir
   şeye FK yok). Migration geri alma: tabloyu `DROP`, iki kısıtı önceki tanımına döndür.

## Ölçüm (yerel, 14 Kasım 2026; gerçek 158.000 vektör, pgvector 0.8, PG16)

| | Değer |
|---|---|
| Yazılan satır | 158.000 (159 parça), 0 stale, 0 missing, 0 failed |
| Süre | 120 sn (≈1.300 satır/sn); ikinci koşu 32 sn, 158.000 `present`, 0 yazım |
| WAL | 488 MB (≈3,1 KB/satır) |
| Tablo | heap 411 MB (≈2,6 KB/satır), indeksler 17 MB (PK + özet), TOAST 8 KB (boş) |
| PostgreSQL (konteyner) | CPU tepe %23, ort. %18 (tek çekirdek payı); bellek tepe 490 MiB |
| Doğrulama | `verify`: 3.000 rastgele satır, vektör ve özet eşit, 0 uyuşmazlık |

Aynı kontrol noktası, E4 deney veritabanına karşı `plan` ile (salt okunur): 158.000 `present`,
`stale` 0 → checkpoint'teki özetler güncel ürün metniyle eşleşiyor.

## Ölçek (tahmin; doğrusal ekstrapolasyon, HNSW hariç)

| Ürün | Heap + indeks | WAL (tek yükleme) |
|---|---|---|
| 158 bin (ölçüldü) | 0,43 GB | 0,49 GB |
| 1 milyon | ≈2,7 GB | ≈3,1 GB |
| 12 milyon | ≈33 GB | ≈37 GB |

HNSW boyutu ve belleği ayrıca ölçülür (PR "BGE-M3 sunum"). 12 milyonda HNSW bellekte kalmaz
(E3-d); o ölçekte ikili nicemleme + yeniden sıralama ya da bölümleme ayrı karar konusudur.
KVM 4 disk tabanı korunur; yükleme öncesi `df` ve WAL arşiv gecikmesi kontrol edilir.

## Üretim ön koşulları (bu PR'ın uygulanması)

- Migration 0114 yalnız tablo ve iki kısıt ekler: hızlı, kilit süresi ihmal edilebilir, uygulama
  kodu tarafından kullanılmaz. Geriye uyumludur (kural 14). `pre-migrate` dökümü ve yedek doğrulaması
  mevcut deploy hattının parçasıdır.
- İçe aktarım **bu PR'da çalıştırılmaz.** Ayrı, insan onaylı operasyondur (`docs/ops.md`).

## Reddedilen

- 768 tablosuna Matryoshka ile kırpmak: recall 0,821 (karar 0183 ölçümü).
- Bölümleme: E3-d.1 §6.
- HNSW'yi 0114'te kurmak: yükleme sırasında indeks bakımı; boş tablodaki indeks ilk yükte yavaştır.
- Yükleme için ürün başlığını yeniden gömmek: maliyet ve zaman; kontrol noktası zaten doğrulandı.
