# 0170 — Anlamsal ürün arama pilotu (hibrit: metin + pgvector)

Durum: **pilot, yerelde ölçüldü; üretimde kapalı ve çalıştırılmadı.** Hiçbir üretim verisi okunmadı/yazılmadı,
toplu embedding başlatılmadı. Bayrak `SEMANTIC_SEARCH_ENABLED` varsayılan kapalı.

> **Kayıt notu (9 Kasım 2026):** Bu belge ve `docs/semantic-pilot/` ölçüm/etiket dosyaları,
> 0171/0172/0177/0178'in atıf yaptığı pilot kaydı olarak main'e alındı. Pilot dalının kodu
> (`services/ingest/semantic_pilot/`, TS hibrit yolu, migration 0104/0105 taslakları) main'e
> **alınmadı**: üretim karşılığı 0177 (migration 0105) ve 0178 (migration 0108) ile yeniden
> yazıldı. Aşağıda geçen dosya yolları ve migration numaraları pilot dalına aittir.

## Bağlam
Bugün `/ara` ve `/sohbet` metin aramasıdır (trigram token kapısı, sözlük eşanlamlıları, kademeli gevşetme);
embedding yalnızca fotoğraf aramasında kullanılır. "otomobil" yazan kullanıcı "araba" ya da "Car ... Holder"
başlıklı ürünü bulamaz; Türkçe sorgu İngilizce (AliExpress, katalogun ~%99,9'u) başlığa ulaşamaz.
Mevcut altyapı: `embedding(target_type, target_id, kind in ('image','text'), model_version, vector(768))`,
pgvector HNSW (yalnız `offer`/görsel için), Jina istemcisi, Python `enrich --kind text` (offer düzeyinde, zamanlayıcısız).

## Karar
1. **Mevcut metin araması aynen korunur.** Hibrit, `SearchProvider` arayüzünü saran bir katmandır
   (`packages/core/src/search/semantic/`); `fallback/` klasörü (model çağrısı yok testi) dokunulmadı.
2. **Ürün düzeyinde metin vektörü:** `embedding(target_type='product', kind='text')`. Metin =
   `services/ingest/enrich/text.py` ile aynı kanonik kurulum (başlık + marka + kategori yolu); TS yansıması
   `embedding-text.ts` (eşdeğerlik testli, `İ/ı` kenar durumu dahil). Şema değişmez; yalnızca model başına kısmi
   HNSW indeksi gerekir (model sürümü indeks koşulunda SABİT metin olarak yazılır).
3. **Bağımsız anlamsal aday keşfi:** sorgu vektörüne en yakın 400 ürün (`ORDER BY vector <=> q`), sonra
   mevcut kesin filtreler (kategori, fiyat, marka, renk, stok, mağaza — aynı `buildFilterClause`), yayın durumu,
   teklif doğrulaması ve **aksesuar/başlık koruması** (`product-title-guard`) aynı SQL yapı taşlarıyla.
4. **Birleşim:** Reciprocal Rank Fusion (k=60). Metin sonuçları HİÇ düşmez. Yalnızca-anlamsal aday kapıdan geçmek
   zorunda: `benzerlik ≥ 0,30` (v3, gerçek veride kalibre; sentetikte 0,40 idi), en iyiden en fazla `0,12` geride, en fazla 48 yalnız-anlamsal ürün.
   **Anlamsal doğrulama (gerçek örnekte eklendi):** anlamsal aday kapıdan geçtiyse, vektörü OLAN ve sorguya benzerliği
   0,40'ın altında kalan metin-yalnız ürünün metin puanı ×0,3 yapılır (bulanık alakasız metin eşleşmesi gerçek anlamsal
   eşleşmenin önüne geçmesin). Vektörü olmayan ürün cezalanmaz → katalog kademeli embed edilirken güvenli.
5. **Hata davranışı:** bayrak/anahtar yok → metin sağlayıcısı AYNEN döner (aynı nesne); vektör yok/zaman aşımı
   (1,5 sn, tek deneme)/HTTP hatası/DB hatası/yanlış boyut → metin sonucu aynen. Bulanık (typo) adım ve boş sorgu
   hiç değişmez. Sorgu metni loga girmez.
6. **Kural 1 istisnası (CLAUDE.md güncellendi):** bayrak açıkken `/ara` sorgusu başına en fazla bir embedding çağrısı;
   her gerçek çağrı `api_usage`'a (`semantic_query_embedding`) yazılır, aynı sorgu süreç belleğinde önbelleklenir.
   Model yalnızca vektör üretir; ürün, fiyat, SQL üretmez. Gemini'nin sorgu yorumlama görevi değişmedi.
7. **Gereksiz üretim önleme:** aynı kanonik metin tek vektör (pilotta 15.000 üründe 13.423 benzersiz metin: %10,5 tasarruf);
   sorgu vektörü önbellekte; Python tarafı mevcut `(model, hash)` yinelenme kuralını kullanır.
8. **Kapsam:** yalnızca `/ara` metin sonucu bağlandı. `/sohbet` (işlem içi arama; embedding çağrısı işlem dışına
   alınmalı) ve ürün başına toplu embedding işi (Python) sonraki aşamadır.

## Gerçek örnek (üretimden salt okunur, 15.000 ürün) — GÖZLE inceleme
SSH döndükten sonra `TABLESAMPLE` ile 15.000 yayınlı ürün (başlık, marka, kategori yolu; yalnızca SELECT) alınıp yerel ayrı bir veritabanına
yüklendi, v3 ile embed edildi (14.962 benzersiz metin, **47,5 token/ürün**, ~0,71 M token; 10 M ürün için ≈ 475 M token).
Örnek %100 İngilizce, kataloğun ~%0,15'i: çoğu test kavramı (oyuncu kulaklığı, şort…) örnekte neredeyse yok, bu yüzden **recall ölçülemez**,
etiket de yok; yalnızca davranış incelendi:
- **"telefon kılıfı":** metin yolu golf/defter kılıfı döndürüyor; hibrit 10/10 gerçek telefon kılıfı (büyük kazanç).
- **"otomobil":** metin yolu motosiklet anahtarlığı/tornavida; demotion sonrası hibrit 10/10 araçla ilgili (maket araba, araç içi temizleyici, araç örtüsü).
- **"akıllı saat":** metin aksesuar (kılıf, kablo, pil) ağırlıklı; hibrit gerçek saatleri de ekliyor.
- **"gaming headset" / "kırmızı şort":** örnekte gerçek karşılık yok; kapı bol çöp yerine az sonuç döndürdü (5 ve 3), ama anlamsal-yalnız 3 sonucun ikisi şort değil → ince katalogda kapı sıkı olmalı.
- **"araba":** metin yolu "Arab" bulanık eşleşmeleri (kıyafet) döndürüyor; örnekte araç yok, semantik yardım etmedi. Mevcut metin yolu kusuru.
- Tek bir sorgu 0 sonuç: "kablosuz kulak üstü kulaklık" (örnekte kulak üstü kulaklık yok).
Gerçek recall/precision için hedefli örnek (ör. her kavramdan birkaç yüz gerçek ürün) ve insan etiketi gerekir.

## Gerçek örnekte doğruluk ölçümü (15.000 gerçek ürün, 42 sorgu)
Düzenek: `semantic_pilot/real_queries.py` (42 sorgu: 26 TR, 16 EN) + kural tabanlı **taslak** etiketler (0/1/2; **insan doğrulamalı değil**,
`labels_override.json` ile ezilir, `real_eval export-review` insan etiketleme CSV'si üretir). Metrikler: P@10 (sıkı = yalnız derece 2),
Recall@50, nDCG@10, ilgisiz@10. Örneklemde yeterli ilgili ürünü (<3) olmayan 8 sorgu **"örneklemde yok"** işaretlenir, ortalamaya girmez,
ayrıca raporlanır (arama başarısızlığı sayılmaz): oyuncu kulaklığı, gaming headset, kablosuz kulak üstü kulaklık (2 dil), akıllı saat (2 dil),
kameralı drone, yoga matı. **Gerçek katalog ağırlıklı olarak aksesuar/yedek parçadır** (örnekte gerçek akıllı saat yok; "süpürge"nin 5 "ilgili"sinin
hepsi aksesuardı); bu yüzden aksesuar koruması doğruluğun ana belirleyicisidir.

Model: **multilingual-e5-small** (yerel, ücretsiz; ürün+sorgu vektörleri 384→768 sıfır dolgulu, kosinüs aynı). **jina-embeddings-v3 bu bölümde ölçülmedi** (aşağıdaki "Karar güncellemesi"nde ölçüldü):
ürün vektörleri hazır (önbellekte), ama 42 sorgu vektörü ücretli API çağrısı gerektirir ve onay verilene kadar çağrı yapılmadı
(`python -m semantic_pilot.query_vectors --model jina-embeddings-v3 --approved-paid`; ≈ 42 × ~18 = ~750 token).

| Yöntem (34 değerlendirilen sorgu) | P@10 sıkı | P@10 geniş | R@50 | nDCG@10 | ilgisiz@10 |
|---|---|---|---|---|---|
| Metin (bugün) | 0,29 | 0,31 | 0,34 | 0,31 | 0,46 |
| Yalnız anlamsal (e5-small) | 0,23 | 0,24 | 0,36 | 0,28 | 0,76 |
| **Hibrit** (e5-small, kalibre kapı) | **0,36** | **0,38** | 0,37 | **0,40** | **0,44** |

Kalibrasyon (örnek-İÇİ, 42 sorguda 6 yapılandırma; aşırı uyum riski var): e5 benzerlikleri 0,82–0,89'a sıkıştığından v3 kapısı (0,40) işe yaramaz:
varsayılanda hibrit "yok" sorgularında 48–50 alakasız sonuç döndürdü. `min=0,86 / gap=0,03 / en çok 24` ile "yok" sorgularında metinle aynı n (7,1 vs 6,9).
**Mutlak eşik modele özgüdür; her model için yeniden kalibre edilir.** Kategori yoğunlaşması (ilk 10 komşunun aynı kategoride toplanması) ayırıcı olarak
zayıf çıktı (yok: 0,35, var: 0,50), kapı olarak kullanılmadı.

Aksesuar koruması + renk zorunluluğu etkisi (e5, varsayılan kapı): hibrit P@10 0,29→0,32, nDCG 0,33→0,38, ilgisiz@10 0,71→0,68; ardından kalibre kapı ile 0,36 / 0,40 / 0,44.

Sorgu bulguları (e5-small):
- **Kazanç:** İngilizce sorgularda ve "otomobil" (0,0→0,3 P@10; nDCG 0,00→0,36), "laptop" (0,3→0,5), "tablet" (0,1→0,4), "t-shirt" (0,2→0,9), "powerbank" (0,4→0,6).
- **Kazanç yok:** Türkçe sorguların çoğu ("araba", "kot pantolon", "güneş gözlüğü", "telefon kılıfı", "masa lambası", "kahve makinesi"): e5-small TR→EN köprüsünü uzun
  gerçek başlıklarda kuramıyor (yalnız anlamsal P@10 0,0–0,3); hibrit = metin. Önceki gözle incelemede v3 "telefon kılıfı"nı 10/10 buldu; bu, e5 için geçerli değil.
- **"araba":** hem metin hem hibrit P@10 0,0 (metin "Arab" bulanık eşleşmesi; anlamsal "araba"yı yakalayamıyor). Aksesuar-yalnız sonuç kümelerinde ("akıllı saat": 8/8 aksesuar) aksesuarlar hâlâ
  gösteriliyor çünkü başka sonuç yok; gizlemek metin davranışını değiştirir → karar bekliyor.
- **"örneklemde yok" sorgular:** hibrit metinden fazla çöp eklemiyor (ort. 7,1 vs 6,9 sonuç; ilgisiz@10 0,55 vs 0,59) — ama metin yolunun kendisi bu sorgularda alakasız bulanık sonuç döndürüyor (oyuncu kulaklığı: pil, rulman).

## Model karşılaştırma kriterleri (doğruluk + gecikme + maliyet + depolama + bakım)
| | jina-embeddings-v3 | multilingual-e5-small |
|---|---|---|
| Sentetik doğruluk (P@10/R@50) | **0,95 / 0,95** | 0,91 / 0,88 |
| Gerçek örnek (e5 ölçüldü, v3 BEKLİYOR) | ölçülmedi | hibrit nDCG 0,40; TR→EN zayıf |
| Sorgu gecikmesi | API ~550 ms medyan, ~1 sn p95 | yerel CPU medyan ~5 ms, p95 ~11 ms (ölçüldü; ayrı çalışma zamanı gerekir) |
| Doküman maliyeti (10 M) | ≈ 475 M token (47,5/ürün ölçüldü) × birim fiyat (doğrulanmadı); oran sınırı ~70 bin tok/dk gözlendi → ~5 gün | API yok; ~125 metin/sn tek CPU → ~22 saat/makine |
| Depolama 10 M (ölçüldü, 15 bin ürün üzerinden) | float32 **83 GB**, halfvec **37 GB** | float32 **37 GB**, halfvec **20 GB** |
| Boyut/şema | 768 = mevcut `vector(768)` | 384 → ayrı kolon/tablo |
| Bakım yükü | düşük (SaaS); sağlayıcı/KVKK (karar 0015), sorgu başına dış çağrı, gecikme kuyruğu | yüksek: web yolunda ONNX çalışma zamanı ya da ayrı servis (mikroservis yasağı/kural 1 sınırı), model sürüm sabitleme, CPU/bellek bütçesi |

Ön öneri: **jina-embeddings-v3**, ANCAK gerçek veride ölçülene kadar kesin değil; e5-small gerçek TR→EN performansı nedeniyle tek başına yetersiz görünüyor.

## Ölçüm düzeneği ve SINIRI
**Katalog SENTETİKTİR** (üretim erişimi yoktu; SSH kapalıydı): 15.000 ürün, ~%75 İngilizce AliExpress tarzı,
~%20 Türkçe, %5 karışık; 40+ ürün türü, aksesuar/aynı kelimeli zor negatifler (bebek arabası, market arabası,
kulaklık standı/pedi/kılıfı). İlgi yargısı katalog etiketlerinden gelir (modelden bağımsız). 28 sorgu (9 çekirdek).
Sonuçlar **mekanizmayı** ölçer, üretimdeki mutlak doğruluğu değil; üretimden alınacak gerçek bir örnekle
(salt okunur SELECT) ve insan etiketiyle yinelenmelidir. Kapı eşikleri bu yüzden gerçek veride yeniden ayarlanır.

### Model karşılaştırması (yalnız anlamsal, brute-force, aksesuar koruması YOK, fiyat süzgeci var)
| Model | Boyut | Tüm P@10 | Tüm R@50 | Tüm ilgisiz@10 | Çekirdek P@10 | Çekirdek R@50 | Not |
|---|---|---|---|---|---|---|---|
| jina-embeddings-v3 | 768 (Matryoshka) | **0,95** | **0,95** | **0,05** | **0,86** | **0,84** | API, sorgu/doküman asimetrik |
| jina-clip-v2 (mevcut) | 768 | 0,91 | 0,83 | 0,09 | 0,80 | 0,66 | API, görselle aynı uzay |
| multilingual-e5-small | 384 | 0,91 | 0,88 | 0,09 | 0,82 | 0,76 | kendi barındırma (karar 0155 modeli), CPU'da ~125 metin/sn |
| paraphrase-multilingual-mpnet | 768 | 0,82 | 0,74 | 0,18 | 0,71 | 0,65 | yerel |
| paraphrase-multilingual-MiniLM | 384 | 0,82 | 0,74 | 0,17 | 0,84 | 0,70 | yerel |

**Seçim: `jina-embeddings-v3` (768, Matryoshka).** Sebep: en yüksek doğruluk, mevcut `vector(768)` şeması ve
mevcut sağlayıcı/AB-KVKK gerekçesi (karar 0015) ile uyumlu, API anahtarı zaten var. Kayıt: jina-clip-v2 görsel için
kalır; metin-metin aramada v3 belirgin üstün. **e5-small** güçlü bir kendi-barındırma yedeği (API maliyeti/oran sınırı
yok) ama 384 boyut ayrı tablo/kolon gerektirir ve ölçülen doğruluğu v3'ün altında. Model sürümü env ile değişir.

### Uçtan uca (gerçek `resolveQuery` + `searchWithFallback` + PostgreSQL; aksesuar koruması AÇIK)
Jina embeddings-v3, eşikler varsayılan (0,40 / 0,12 / 48):

| Küme | Yöntem | P@10 | P@20 | R@50 | İlgisiz@10 | MRR |
|---|---|---|---|---|---|---|
| Tüm (28) | metin (bugün) | 0,96 | 0,96 | 0,87 | 0,00 | 0,96 |
| | yalnız anlamsal | 0,97 | 0,98 | 0,97 | 0,02 | 1,00 |
| | **hibrit** | **1,00** | **1,00** | **0,98** | 0,00 | 1,00 |
| Çekirdek (9) | metin | 0,89 | 0,89 | 0,84 | 0,00 | 0,89 |
| | yalnız anlamsal | 0,92 | 0,94 | 0,91 | 0,08 | 1,00 |
| | **hibrit** | **1,00** | **1,00** | **0,95** | 0,00 | 1,00 |

jina-clip-v2 ile hibrit: Tüm P@10 1,00, R@50 0,92; çekirdek R@50 0,86 (v3: 0,95).

Sorgu bazlı bulgular (v3):
- **"otomobil":** metin 0 sonuç → hibrit 48 sonuç, P@10 1,0 ("Automobile Driving Recorder", "Araba Çakmaklık Şarj"…).
  Bu, metinle ulaşılamayan asıl hedeftir. clip-v2 de bulur ama R@50 0,50 (v3: 0,96).
- **"oyuncu kulaklığı" ↔ "gaming headset":** iki yönde P@10 1,0; İngilizce başlıkların payı artar.
- **"kablosuz kulak üstü kulaklık":** koruma KAPALIyken anlamsal P@10 0,9 (v3), diğer modellerde 0,2–0,5 (şarj standı/ped
  /kılıf girer); koruma AÇIKken 1,0. Aksesuar elemesi anlamsal adaya da uygulanmadan model değiştirmek yeterli değil.
- **"kırmızı şort":** hibrit kazanç yok (R@50 0,58, 30 sonuç). Gömme **renk gibi kesin nitelikleri zayıf** taşır; kapı,
  yanlış renkli şortu alıp precision'ı düşürmek yerine eler. Renk/beden/fiyat kesin filtrelerle (Gemini/sözlük) çözülmeli.
- **"araba":** yalnız anlamsal P@10 0,3 (bebek/market arabası karışır); hibritte metin önde olduğu için 1,0. Belirsiz
  tek kelimelik sorguda vektör tek başına güvenilmez.
- **"3000 TL altında kablosuz kulaklık":** fiyat kesin filtre olarak anlamsal adaya da uygulanır; hibrit P@10 1,0.

Eşik taraması (5 yapılandırma): varsayılan (0,40/0,12/48) ve daha gevşek aralık eşit en iyi; `min=0,30` precision'ı
düşürür (çekirdek P@10 0,97), `gap=0,08` recall'u düşürür (R@50 0,92). Varsayılan korunur; gerçek veride yeniden ayarlanır.

### Gecikme (yerel PostgreSQL, 15.000 ürün)
- Metin yolu: medyan 24–28 ms (bugünkü).
- Hibrit, sorgu vektörü önbellekteyken: medyan ~27 ms, p95 ~220 ms (kNN ~25–150 ms).
- **Sorgu embedding API'si (soğuk):** v3 medyan ~550 ms, p95 ~1.000 ms, en yavaş 1,47 sn; clip-v2 medyan ~500 ms, p95 ~1,5 sn.
  Bu, kullanıcının gördüğü ek gecikmedir. 1,5 sn zaman aşımı en uçtaki sorguları metin yoluna düşürür (son koşularda 28/28 başarılı;
  aynı anahtarla eşzamanlı yoğun yük sırasında yapılan ilk koşuda sorguların bir kısmı 429/zaman aşımıyla vektörsüz kaldı ve
  hibrit beklendiği gibi metin sonucuna düştü). Sorgu önbelleği ve (sonraki aşama) en sık sorguların çevrimdışı önceden embed edilmesi gerekir.
- Sorgu başına token: v3 ≈ 17,7; clip-v2 ≈ 5,7.

### Depolama ve indeks (15.000 ürün, yerel pgvector 0.8.6)
| Biçim | Vektör (heap) | HNSW indeks | İndeks/ürün | İndeks süresi |
|---|---|---|---|---|
| vector(768) float32 | 44 MB (2,9 KB/ürün) | 53 MB | 3,67 KB | 4,8 sn |
| halfvec(768) | 22 MB (1,5 KB/ürün) | 26 MB | 1,84 KB | 7,5 sn |

HNSW geri çağırma (150 ürün-vektör sorgusu, ilk 10, tam arama karşısında): float32 %96–97, halfvec %96–97
(ef_search 40–400). Yinelenen metinler (aynı vektör) eşitlik sıralaması farkı yarattığı için bu alt sınırdır.

## 10 milyon ürüne genişleme (hesap, ÖLÇÜM DEĞİL; fiyatlar doğrulanmadı)
- **Depolama:** vektör+indeks ürün başına ≈ 6,6 KB (float32) / ≈ 3,3 KB (halfvec) → ≈ 66 GB / **≈ 33 GB**. Mevcut Postgres
  bellek sınırı 6 GiB: tam HNSW belleğe sığmaz. Seçenekler (öncelik sırasıyla): halfvec + yalnızca "aranabilir"
  alt küme (kategori/stok/görsel kalitesiyle) embed etmek; Matryoshka ile 256–384 boyuta inmek (ayrı ölçüm gerekir);
  kategori bölümleme ve filtreli ANN (pgvector iterative scan); ayrı okuma kopyası.
- **Doküman embedding:** gerçek AliExpress başlıkları pilot metinlerden uzundur; ~40–60 token/ürün varsayımıyla 400–600 M token.
  Jina birim fiyatı bu oturumda doğrulanmadı (bkz. `EMBEDDING_COST_MICROS_PER_1K_TOKENS`); fiyat × token çarpımı satın almadan önce
  güncel tarifeyle hesaplanmalı. **Asıl kısıt oran sınırıdır:** pilotta tek bağlantılı sıralı istemci ~70 bin token/dk ulaştı;
  bu hızla 500 M token ≈ 5 gün. Yüksek oran sınırlı plan ya da kendi barındırma (e5-small: bu makinede 125 metin/sn → 10 M ≈ 22 saat tek makine) gerekir.
- **Sorgu maliyeti:** sorgu başına ≈ 18 token (v3); aylık sorgu sayısı × 18 token. Önbellek isabeti ücretsiz.
- **Aşamalı yol:** (1) gerçek örnekle yeniden ölç → (2) tek kategori/AliExpress alt kümesi pilotu (≤ 200 bin) → (3) halfvec indeks ve
  filtreli ANN ölçümü → (4) Python toplu işi (`enrich`, ürün hedefli, `n` bağımsız hız sınırlı, kesintisiz devam) → (5) bayrak açma, `/sohbet`.

## Riskler
- Sentetik veri iyimser olabilir; gerçek başlıklar daha gürültülü. Eşikler ve model sıralaması gerçek örnekle doğrulanmadan üretime alınmaz.
- Sorgu embedding'i API'ye bağımlı (gecikme kuyruğu, 429, kota). Hata düşüşü metin yoludur; ama gecikme sınırı kullanıcıyı etkiler.
- ANN-sonra-filtre: çok seçici filtrede (ör. dar fiyat) anlamsal aday azalır. 10 M için filtreli ANN şart.
- Anlamsal-yalnız ürünler "alakalı ama kelime eşleşmesiz" olduğundan arayüzde ayrım gerekmiyor ama kalite izlenmeli (`irrelevant@10`).
- Jina'ya sorgu metni gider (kişisel veri süzgeci mevcut `queryContentIneligibility` ile birleştirilmeli; pilotta yalnız bayrak/anahtar var).
  KVKK değerlendirmesi (karar 0015: AB sağlayıcısı) üretimden önce tekrarlanmalı.

## Reddedilen alternatifler
- **Yalnızca metin sonuçlarını vektörle yeniden sıralamak:** "otomobil" gibi metinde 0 sonuç veren sorguyu çözmez (talep: bağımsız keşif).
- **Sorguyu LLM ile İngilizceye çevirip metin aramak:** her sorguda LLM çağrısı, yavaş, deterministik değil.
- **Sözlükle çözmek (otomobil↔araba):** ucuz ve önce yapılmalı (kapsamı tamamlayıcı), ama sınırsız eşanlamlıyı elle bakımla kapatmak ölçeklenmez.
- **Ayrı vektör veritabanı:** CLAUDE.md yasak; pgvector pilotta yeterli.

## Karar güncellemesi — Jina Embeddings v3 standart model (kullanıcı kararı)
Model karşılaştırması KAPANDI. `jina-embeddings-v3` (768, Matryoshka) hem ürün (`retrieval.passage`) hem sorgu (`retrieval.query`) için
tek standart modeldir: TS `DEFAULT_SEMANTIC_MODEL`, Python `enrich.products.MODEL`. e5-small ve diğerleri artık test edilmez.

### Gerçek veride ölçüm (15.000 gerçek ürün, 42 sorgu, v3; kullanıcı onayıyla 718 token API harcandı)
34 değerlendirilen sorgu; etiketler kural tabanlı TASLAK (insan doğrulamasız). Kapı: min 0,30 / gap 0,12 / en çok 48 yalnız-anlamsal.

| Yöntem | P@10 sıkı | P@10 geniş | R@50 | nDCG@10 | ilgisiz@10 |
|---|---|---|---|---|---|
| Metin (bugün) | 0,29 | 0,31 | 0,34 | 0,31 | 0,46 |
| Yalnız anlamsal (v3) | 0,49 | 0,51 | **0,64** | 0,54 | 0,49 |
| **Hibrit (v3)** | **0,59** | **0,61** | 0,58 | **0,61** | **0,39** |

(e5-small hibrit, aynı küme: 0,36 / 0,38 / 0,37 / 0,40 / 0,44.)

- nDCG@10: hibrit > metin 27 sorguda, < metin 2'de, eşit 5'te.
- Eşik taraması (v3, 12 yapılandırma): sentetik eşik 0,40 gerçek veride TR sorguları eliyordu (TR→EN mutlak benzerlikler 0,28–0,50;
  "kot pantolon" en iyi 0,35, "kolye" 0,30). min 0,25–0,30 / gap 0,12 en iyi (nDCG 0,61); fuzyon ağırlığı (×1–×5) ve metin indirme (×0,1–×0,3) etkisiz.
  Ayar 42 sorguda seçildi (örnek-içi); bağımsız doğrulama kümesi gerekir.
- Odak sorgular (hibrit vs metin P@10): **otomobil** 0,0→0,2 (nDCG 0,00→0,34); **oyuncak araba** 0,0→0,9; **telefon kılıfı** 0,0→0,9 (metin golf kılıfı döndürüyordu);
  **dizüstü bilgisayar** 0,0→0,7; **kot pantolon** 0,0→0,7; **kırmızı şort** 0,0→1,0 (yalnız 2 sonuç: örnekte 3 ilgili ürün var); **kulaklık standı** (aksesuar isteyen) 0,0→0,4;
  **kablosuz kulaklık** 0,0→0,5; **powerbank** 0,4→0,7; **t-shirt** 0,2→0,9.
- Başarısız/zayıf: **araba** (tek sözcük, TR; v3 benzerliği 0,27, metin "Arab" kıyafeti; hibrit de 0,0); **süpürge** (örnekteki 5 "ilgili"nin hepsi aksesuar → aksesuar koruması hepsini eledi, P@10 0,0);
  **otomobil** P@10 0,2 (araçla ilgili ürünlerin çoğu parça/aksesuar; taslak etiket ve belirsizlik); **kulaklık pedi** 0,2; **bebek arabası** 0,2.
- **Örneklemde ilgili ürün olmayan 8 sorgu** (ortalamaya girmez): oyuncu kulaklığı / gaming headset (hibrit 4–5 sonuç, ilgisiz 0,5–0,6; metin 12 sonuç, ilgisiz 1,0),
  kablosuz kulak üstü kulaklık (2 dil: 0 sonuç), akıllı saat (2 dil: yalnız aksesuar, iki yöntemde de 8 sonuç), kameralı drone (1 sonuç; metin 12), yoga matı. Ortalama dönen sonuç: metin 6,9 → hibrit 3,6; ilgisiz@10 0,59 → 0,43.
- Gecikme (yerel, 15 bin ürün; sorgu vektörü önbellekte): metin medyan 47 ms, hibrit 42 ms. Sorgu embedding API'si soğuk ~550 ms medyan.
- Bilinen eksik: "akıllı saat" gibi yalnız aksesuarı olan sorgularda aksesuarlar hâlâ gösteriliyor (başka sonuç yok); gizleme kararı bekliyor.

### Uygulama durumu (bu dal, bayrak varsayılan KAPALI)
- **Ürün embedding hattı** (`python -m enrich.products`): artımlı (`new` = vektörü olmayan yayınlanmış ürünler, kimlik sırası, `--after-id` ile devam), `verify` = içerik hash'i
  değişenleri yeniden üretir; **değişmeyen satıra yazım yok**; aynı kanonik metin (içerik hash'i, `embedding.content_hash`, migration 0104/0105) DB'den kopyalanır (API yok);
  kuru çalışma varsayılan; gerçek çalıştırma `--execute` + zorunlu `--max-tokens`; token bütçesi (`JINA_TOKENS_PER_MINUTE`); her çağrı `api_usage` (`product_text_embedding`).
  7 entegrasyon testi (idempotent, dedupe, kuru çalışma, hash değişimi, kopyalama, bütçe, sağlayıcı hatası).
- **Arama:** sorgu metni = filtreye çevrilen kısımlar çıkarılmış `unparsed` (Gemini/ayrıştırıcı çıktısı bu yoldan girer; kategori, bütçe, nitelikler `QueryObject`'te); kesin filtreler anlamsal adaya da
  uygulanır (fiyat, kategori, marka, renk, stok, mağaza); yalnız-anlamsal adaya ek zorunluluklar: **ürün türü** (başlık sözcüğü; ~70 tür TR/EN, baş isim), **açık renk**, **aksesuar elemesi**
  (sorgu aksesuar istemiyorsa; metin aksesuarı ×0,3 aşağı); vektörü olan ama sorguya benzemeyen metin sonucu aşağı iner; **vektörü olmayan ürün metinle bulunur ve cezalanmaz** (entegrasyon testi).
- **/ara ve /sohbet ortak altyapı:** `createRequestSearchProvider` (sohbette sorgu vektörü DB işlemi açılmadan önce alınır, `prefetchQueryEmbedding`). Hata, zaman aşımı (1,5 sn, tek deneme) ya da kapalı bayrakta metin sonucu aynen döner.

### 10 milyon ürün: ölçüme dayalı plan (HESAP; toplu iş BAŞLATILMADI)
Üretim durumu (salt okunur, bu oturumda): diskte 97 GB boş / 193 GB (veritabanı 64 GB, `product` 10,46 M satır / 21 GB, `embedding` tablosu BOŞ), `shared_buffers` 2 GB,
`maintenance_work_mem` 512 MB, `max_wal_size` 16 GB, WAL dizini 15 GB.

| Kalem | Hesap | Sonuç |
|---|---|---|
| Token | 47,5 token/ürün (gerçek 15 bin örnek) × 10,46 M | **≈ 497 M token** |
| Yinelenen metin | gerçek örnekte 38/14.962 (%0,25) | tasarruf ihmal edilebilir (sentetik %10,5 yanıltıcıydı) |
| API isteği | 64 metin/istek | **≈ 163 bin istek** (128/istek ile ≈ 82 bin) |
| Süre | token ÷ oran sınırı: 70 bin tok/dk (gözlenen) → ~4,9 gün; 1 M tok/dk → 8,3 sa; 2 M tok/dk → 4,1 sa | oran sınırı DOĞRULANMADI; belirleyici kota bu |
| Maliyet | token/1 M × birim fiyat (fiyat DOĞRULANMADI) | örnek: 0,02 → ≈ 10 $; 0,05 → ≈ 25 $; 0,10 → ≈ 50 $ |
| Depolama float32 | 4,2 KB (heap) + 4,1 KB (HNSW) / ürün | **≈ 83 GB — 97 GB boş diske SIĞMAZ** (WAL ve yedek payı yok) |
| Depolama halfvec | 1,6 KB + 2,0 KB / ürün | **≈ 37 GB** (yedek/WAL ile birlikte hâlâ dar) |
| Yükleme WAL'i | satır başına vektör + indeks değişimi (TAHMİN ≈ veri boyutunun 1–2 katı) | 40–75 GB WAL arşivi/yedek trafiği; yedek boyutu +37 GB |
| HNSW belleği | halfvec indeks ≈ 20 GB ≫ `shared_buffers` 2 GB | soğuk kNN gecikmesi 15 bin ürün ölçümünden ÇIKARILAMAZ; ölçülmeli |

Öneri ve sıra:
1. **Tam 10 M'u tek seferde yükleme.** Önce aranabilir alt küme (TRY teklifli, stokta, görseli olan; ya da kategori dilimi); alt küme boyutu ayrıca sayılmalı. İlk adım 200 bin ürün (≈ 9,5 M token).
2. **halfvec** şart: depolamayı yarıya indirir, geri çağırma float32 ile aynı ölçüldü (%96–97). Tip değişimi (ayrı halfvec kolon/tablo) migration gerektirir (karar bekliyor).
3. **HNSW'yi yükleme BİTTİKTEN sonra kur**; kurulum sırasında `maintenance_work_mem` ve `max_parallel_maintenance_workers` yükseltilir (512 MB ile 10 M'da çok yavaş); migration 0105 bilerek yalnız hash indeksini kurar.
4. Disk: yalnız alt küme + halfvec ile bile 97 GB'ın yarısına yaklaşır; WAL/yedek için disk genişletme ya da yedek hedefi kapasitesi kontrol edilmeli.
5. Günlük artım: yeni ürün sayısı × 47,5 token (ör. 20 bin ürün/gün ≈ 0,95 M token/gün); haftalık `verify` taraması hash'i değişeni yeniden üretir. Zamanlayıcı kurulmadı.
6. Çalıştırma: `python -m enrich.products --mode new --limit N --execute --max-tokens T` (kuru çalışma önce token tahminini yazar). `--after-id` ile kesinti sonrası devam.

### Kalan teknik eksikler
- Oran sınırı ve birim fiyat doğrulanmadı; 10 M süre/maliyet bu iki sayıya bağlı.
- Etiketler taslak (insan doğrulaması yok); eşikler 42 sorguda seçildi → bağımsız doğrulama kümesi.
- Gerçek TL fiyatlı örnekte fiyat filtresi sınanmadı (örnek fiyatları yabancı teklif).
- halfvec ve HNSW migration'ı yazılmadı; alt küme tanımı ve ölçekte kNN gecikmesi ölçülmedi.
- Aksesuar-yalnız sonuç kümesi politikası; tek sözcüklü belirsiz TR sorgular ("araba"); ürün türü sözlüğü elle bakımlı.
- Sorgu metninin Jina'ya gitmesi: kişisel veri süzgeci (`queryContentIneligibility`) hibrit yoluna bağlanmadı; KVKK değerlendirmesi üretimden önce.
- Anahtar (8 Kasım 2026 güncellemesi): kullanıcı anahtarın sızmadığını teyit etti; mevcut üretim anahtarı (`web.env`/`worker.env`) kullanılmaya devam eder, yenileme gerekmez.

## Üretim öncesi üç iş — sonuçlar (bu tur)

### 1) Gerçek doğruluk (15.000 gerçek ürün; v3; bayrak kapalı, ayarlar DONDURULMUŞ)
**Düzeltme:** önceki turdaki taslak etiket kuralında "aksesuar" regex'inin `\b` kaçışları bozuktu (arka-plan karakteri) ve kural fiilen eksik çalışıyordu; düzeltildi, bazı sorgular
artık doğru olarak "örneklemde yok" sayılıyor ve önceki tablo sayıları aşağıdakilerle DEĞİŞTİ. Önceki "0,59 / 0,61" sayıları geçersizdir.

**Bölümler:** *Kalibrasyon* = 42 sorgu (eşik/kapı bunlarla ayarlandı); *Bağımsız* = 39 YENİ sorgu (aksesuar niyeti, renk+tür, TR/EN çiftleri, cihaz/aksesuar; ayar sırasında hiç görülmedi,
sabit ayarla bir kez ölçüldü). Ayar: min 0,30 / gap 0,12 / en çok 48 yalnız-anlamsal; ürün türü, renk, aksesuar korumaları açık.

| Bölüm (değerlendirilen sorgu) | Yöntem | P@10 sıkı | R@50 | nDCG@10 | ilgisiz@10 | **tür hatası@10** | **aksesuar-ana@10** |
|---|---|---|---|---|---|---|---|
| Kalibrasyon (30) | Metin (bugün) | 0,29 | 0,32 | 0,32 | 0,43 | 0,26 | 0,23 |
| | Hibrit | **0,62** | 0,58 | **0,66** | 0,36 | **0,09** | **0,02** |
| Bağımsız (32) | Metin (bugün) | 0,38 | 0,47 | 0,42 | 0,47 | 0,08 | 0,31 |
| | Yalnız anlamsal | 0,51 | 0,74 | 0,64 | 0,49 | 0,00 | 0,28 |
| | Hibrit | **0,63** | 0,65 | **0,71** | **0,34** | **0,00** | **0,07** |

- Bağımsız sorgularda hibrit kalibrasyon sorgularından geri kalmıyor (nDCG 0,71 vs 0,66): ayar bu sorgulara uydurulmadı.
- **Ürün türü yanlış anlaşılması (öncelikli hata):** metin yolunda ilk 10'un %26'sı (kalibrasyon) sorgunun ürün türünü taşımıyor (en bariz: "araba" → "Arab" kıyafeti); hibritte %9 → %0.
  Eklenen kural: sorgunun baş isim türüne uymayan VE vektör olarak da sorguya benzemeyen (< kapı) metin sonucu çıkarılır (iki bağımsız işaret; vektörü olmayan ürüne dokunulmaz). Etkisi küçük (v3, "araba"
  ile "Arab" kıyafeti 0,31–0,39 benzerlikte kalıyor → eşiğin üstünde); çıkarma eşiği 0,30/0,45/0,60 ölçüldü, fark ≤ 0,01.
- **Aksesuar/ana ürün ayrımı:** aksesuar-gibi görünen sonuç oranı (sorgu aksesuar istemiyorken) metinde %23–31 → hibritte %2–7.
- **Örneklemde ilgili ürün olmayan sorgular** (ortalamaya girmez, ayrı): 17 sorgu (ör. oyuncu kulaklığı, gaming headset, kablosuz kulak üstü, akıllı saat ×2, siyah sırt çantası, gaming mouse, smartwatch).
  Bu sorgularda hibrit metinden az çöp döndürüyor (ör. süpürge 48 → 2, oyuncu kulaklığı 12 → 4), ama "smartwatch" (8 → 27) ve "gaming mouse" (18 → 20) gibi sorgularda anlamsal-yalnız ürünler (aksesuar/yakın tür) ekleniyor: bunlar arama başarısızlığı değil, örnekte karşılık yokluğunda yanlış-pozitif riski.
- **Etiket güvenilirliği:** kural etiketleri kesin kabul EDİLMEDİ. İlk 50 satır (odak sorguların hibrit ilk-N'i) model destekli denetlendi (insan değil): kural-denetim uyumu **41/50 = 0,82**
  (`audit_labels_model_assisted.json`). Sistematik kural hataları: "cover for <cihaz>" kalıbını kaçırıyor (telefon kılıfı, laptop sırt çantası: alt-puan), genel "holder/mount" eşleşmelerini fazla puanlıyor (kulaklık standı: üst-puan).
  İnsan incelemesi için: `review_focus.csv` (194 satır, 20 odak sorgu: otomobil, araba, oyuncak araba, oyuncu kulaklığı, gaming headset, kırmızı/red şort/elbise, aksesuar sorguları) ve `review_all.csv` (744 satır, 81 sorgu).
  Sütunlar: sorgu, bölüm, hibrit/metin sırası, ürün kimliği, başlık, kural derecesi, otomatik işaret (TUR_UYUSMUYOR / AKSESUAR_GIBI / RENK_UYUSMUYOR), insan derecesi (0/1/2), hata türü, not.
  `real_eval import-review` insan derecelerini etiket dosyasına çevirir; `score --labels` kuralı ezer; `agreement` kural-insan uyumunu verir.
- **Kalan başarısızlıklar:** "araba" (tek sözcük TR; hibrit de metin gibi), kırmızı/siyah gibi renk+tür sorgularında örnekte az ürün, "kulaklık standı" (örnekte gerçek stand yok; yakın tür aksesuarlar ilgili sayılıyor).

### 2) Sınırlı embedding pilotu (200 ürün, yerel DB, canlı Jina v3)
- Önbellek kontrolü: 15.000 ürünün tamamı hash'iyle eşleşiyor (`verify` kuru çalışma: 15.000 değişmemiş, 0 API) → "gerekli yeni embedding" sıfır. Üretim SSH'ı kapalı olduğundan taze gerçek ürün alınamadı;
  pilotun amacı (canlı API yolunda hash/idempotency/checkpoint) için 200 ürünün vektörü YALNIZCA yerelde silinip hat üzerinden yeniden üretildi.
- Kuru çalışma tahmini 9.102 token; gerçekleşen **8.619 token, 4 API çağrısı** (+ değişen 1 ürün: 39 token) → toplam **8.658 token** (sınır 15.000). Maliyet: fiyat doğrulanmadı; makul her tarifede (≤ 0,2 $/1 M) ≤ 0,002 $ ≪ 1 $.
- **Checkpoint:** iki çalıştırma (100 + 100, `--after-id 5099` ile devam). **İdempotency:** yeniden çalıştırma 0 ürün/0 API/0 yazım. **Hash:** `verify` 200 değişmemiş (API yok); bir başlık değişince yalnızca 1 ürün yeniden embed edildi, diğer 199'a ve satırlarına dokunulmadı.
- **Doğruluk:** yeni vektörler önbellekteki eskilerle kosinüs min 0,99992 / medyan 0,99996 (API deterministik, `retrieval.passage` yolu doğru). `api_usage`: 4 satır / 8.619 birim. Çıktı dosyalarında anahtar deseni yok.
- **Yeniden deneme:** `JinaEmbeddingClient` 429 (Retry-After, üstel bekleme, tavan) ve 5xx'i yeniden dener; v3 yolu için ayrıca 503→başarı testi eklendi; kalıcı 4xx yeniden denenmez; ardışık 3 parti hatasında koşu durur, yazılmayan parti sonraki koşuda yeniden denenir (entegrasyon testleri).

### 3) Ölçek: ölçümler ve kademeli plan
**halfvec (yerel, 15 bin gerçek ürün, v3):** tam aramada fp16 ile float32 ilk-10 örtüşmesi **0,999**, ilk-50 **0,999**, yalnız-anlamsal nDCG@10 farkı **0,0000** (81 sorgu); HNSW halfvec geri çağırma@10: **0,983 / 0,990 / 0,997** (ef_search 40/100/400, 231 sorgu).
Doğruluk kaybı ölçülemedi → halfvec kullanılır.

**Ürün/teklif ayrımı:** üretimde `embedding` tablosu BOŞ (0 satır); hiçbir teklif embedding'i yok. Birim ÜRÜN (yinelenen başlık gerçek örnekte %0,25; teklif düzeyinde üretim satırı çoğaltır ve AliExpress'te her ilan ayrı ürün).
Eski `enrich --kind text` (teklif düzeyi, clip-v2) zamanlanmamalı. Ürün vektörü için ayrı halfvec tablosu taslağı: `packages/db/migrations-draft/0106_product_text_embedding.sql.draft` (UYGULANMAZ; `migrations/` dışında).

**Ölçülen depolama/WAL (ürün başına, 15 bin ürün yüklemesi):**
| | tablo (heap+TOAST) | HNSW | yükleme WAL'i | HNSW kurulum WAL'i | 10 M toplam |
|---|---|---|---|---|---|
| float32 `vector(768)` | 4,2 KB | 4,1 KB | 3,5 KB | 3,4 KB | **≈ 83 GB disk + ≈ 69 GB WAL** |
| halfvec(768) | 1,6 KB | 2,0 KB | 1,7 KB | 1,8 KB | **≈ 37 GB disk + ≈ 35 GB WAL** |
Üretim (salt okunur, önceki ölçüm): 97 GB boş / 193 GB, veritabanı 64 GB, `max_wal_size` 16 GB, `shared_buffers` 2 GB, `maintenance_work_mem` 512 MB. halfvec 37 GB sığar (≈ 60 GB boş kalır); float32 sığmaz.
WAL arşivlenir (pgBackRest → yedek deposu) ve tam yedek +37 GB büyür; HNSW kurulum WAL'i 10 M'da doğrusal varsayıldı (ölçek etkisi ölçülmedi).

**Alt küme sayıları (üretim, salt okunur; `TABLESAMPLE SYSTEM (2)`, iki tohum, `default_transaction_read_only=on`, betik `services/ingest/semantic_pilot/prod_subset_counts.sql`):**
| Ölçüt | Örnek (tohum 22 / 11) | Oran | 10,16 M'a ölçekli |
|---|---|---|---|
| Örnek büyüklüğü | 206.524 / 201.732 | %2 | — |
| Yayında | 202.370 / 197.512 | %98 | ≈ 9,9–10,0 M |
| Teklifli (TRY ya da yurt dışı) | 202.370 / 197.512 | %98 | ≈ 9,9–10,0 M |
| Teklifli + görselli | 202.370 / 197.512 | %98 | ≈ 9,9–10,0 M |
| TRY teklifli (= TRY stoklu) | 19 / 41 | %0,01–0,02 | ≈ 1–2 bin (gürültülü) |
| Kategorili | 157.865 / 153.954 | %76–77 | ≈ 7,7–7,8 M |
Ortalama başlık 113 karakter. Tablolar: `product` ≈ 10,16 M satır / 21 GB, `offer` ≈ 10,73 M / 19 GB, `offer_image` ≈ 55 M / 15 GB, `embedding` 0 satır.
Sonuç: `--require-offer --require-image` kümeyi daraltmaz (hemen her yayındaki ürünün yurt dışı teklifi ve görseli var); TRY teklifli küme birkaç bin ürün olduğundan ölçek pilotuna uygun değil;
kategorili küme (≈ 7,7 M) tek başına hâlâ çok büyük. İlk genişleme ürün türü/arama ihtiyacına dayalı küçük bir kümeyle yapılmalıdır (bkz. öneri aşağıda).

**Kademeli, checkpoint'li plan (hiçbiri başlatılmadı; her adım ayrı onay):**
| Adım | Ürün | Token (47,5/ürün) | Kapı / durdurma koşulu |
|---|---|---|---|
| 0 | — | — | Oran sınırı ve birim fiyat doğrulaması; alt küme sayımı; disk/WAL izleme eşikleri; HNSW'siz tam tarama ile canary tasarımı |
| 1 | 10 bin | 0,48 M | `--require-offer --require-image`, `--max-tokens`; hata oranı > %1 ya da 429 oranı > %5 → dur |
| 2 | 200 bin | 9,5 M | Yerel/izole veritabanında doğruluk yinelenir; halfvec tablosu (migration kararı) |
| 3 | 1 M | 47,5 M | WAL ve disk izlemesi (pg_wal < max_wal_size, boş disk > 40 GB); HNSW ilk kez burada kurulur (yükleme BİTTİKTEN sonra, yüksek `maintenance_work_mem`) |
| 4 | alt kümenin tamamı (≤ 10,46 M) | ≤ 497 M | Bayrak yalnız canary kullanıcılarda; haftalık `verify`; günlük `new` artım |
Her adım `--after-id` ile kesintiden devam eder, `--max-tokens` ile sınırlıdır, kuru çalışma önce token tahminini yazar. Bayrak (`SEMANTIC_SEARCH_ENABLED`) adım 3'e kadar kapalı kalır.

**Kalan engeller:** (a) SSH/üretim erişimi (alt küme sayıları, canlı disk/WAL izleme); (b) yeni Jina anahtarı, oran sınırı ve birim fiyat; (c) insan etiketi (şimdiki doğruluk taslak etiketle); (d) halfvec tablosu migration kararı ve kodun o tabloya geçirilmesi (pipeline + sorgu);
(e) HNSW'nin üretim donanımında soğuk gecikmesi ve kurulum süresi (10 M); (f) KVKK/kişisel veri süzgeci (sorgu metni Jina'ya gidiyor); (g) aksesuar-yalnız ve örnekte karşılığı olmayan sorgularda anlamsal-yalnız yanlış-pozitif politikası.

## Gerçek ürün pilotu: 200 katmanlı ürün (Jina v3, yerel DB `arilla_pilot200`)
TEKNİK pilot; 200 ürün 10 milyon ürünlük aramanın doğruluğunun KANITI DEĞİLDİR. Üretimden yalnız SELECT (`default_transaction_read_only=on`),
vektörler yalnız yerel izole veritabanına yazıldı; üretime embedding yazılmadı.

**Seçim** (`semantic_pilot/select_stratified.py`; üretimde %2 blok örneği, tohum 77; Türkçe için %4, tohum 79; önceki 15 bin örnekle çakışan 6 aday atıldı):
phone 27, audio 27, fashion 27, auto 27, home 26, computer 26, kategorisiz 20, Türkçe karakterli 20. Hedef 30×6+20 idi; üretimde Türkçe karakterli başlık yalnız
%0,016 (32/200.059) olduğundan 20 Türkçe ürün ayrı grup olarak eklendi ve diğer gruplar 30→26–27'ye indi (DEĞİŞİKLİK). Türkçe grubun içinde Portekizce/Fransızca/Almanca/İngilizce başlıklar da var.
Grup üyeliği başlık anahtar sözcüğüyle belirlendi, bu yüzden gruplar gürültülü ("phone" grubunda oyuncak telefon, "fashion"da çanta olabilir). Her grupta rol (ana/aksesuar/yedek parça) ≈ 1/3'er.
200 ürünün 153'ü kategorili, 47'si kategorisiz. Bilinen kusur: seçicideki yetişkin içerik süzgeci (`ADULT`) ilk çalıştırmada etkisizdi (kaçış karakteri hatası; düzeltildi, test eklendi);
seçilen kümede 2 açık içerikli (katalog kimliği 163, 165) ve 1 hafif ifadeli giyim başlığı var (ilk sayım 3 idi; sonradan ayrıştırıldı); token sınırı nedeniyle küme yeniden seçilip yeniden embed edilmedi.

**Sonuç 1 — başarı:** 200/200 yazıldı, 0 başarısız. Önce önbellek/yinelenen metin kontrolü: DB'den kopyalanan 0 (kopya metin yok). İçerik hash'i 200/200 dolu. `api_usage`: 5 kayıt (`product_text_embedding`).
**Sonuç 2 — token/maliyet:** ürün embedding'i 9.109 token (45,5/ürün; kuru çalışma tahmini 9.545), hash değişimi yeniden üretimi 55, sorgu embedding'i (38 sorgu) 654 → **toplam 9.818 / 15.000 token (%65)**.
Birim fiyat doğrulanmadığından maliyet TAHMİN: 0,02–0,05 USD/M token ile ≈ 0,0002–0,0005 USD (≪ 1 USD). Sınırlar (200 ürün / 15.000 token / 1 USD) aşılmadı.
**Sonuç 3 — süre/depolama:** ≈ 2,8–3,6 sn/100 ürün (≈ 30 ms/ürün, 2 istek/100 ürün). `embedding` tablosu 200 satır: yığın 32 kB, indeksler dâhil 1,8 MB; ham vektör float32 3 KB/ürün (ölçek tablosu yukarıda).
**Sonuç 4 — idempotency ve devam:** (1) `--limit 100`: 100 yazıldı, son kimlik 100. (2) `--after-id 100`: kalan 100 yazıldı. (3) `new` tekrar: 0 incelendi, 0 API, 0 yazım. (4) `verify`: 200 değişmedi, 0 API, 0 yazım.
(5) bir başlık değiştirilip `verify`: 199 değişmedi, **1 API çağrısı (55 token), 1 yazım**. Sağlayıcı hatasında yazım yapılmaması ve tekrarlı hatada durma entegrasyon testlerinde (12 test geçti); gerçek API hatası bu turda oluşmadı.

**Değerlendirme** (`semantic_pilot/pilot200_eval.py`; 19 kavram × TR/EN = 38 sorgu; etiketler kural tabanlı TASLAK, insan doğrulamasız; metin, yalnız anlamsal, hibrit):
ilgili ana ürün sayısı ≥ 3 olan **12 sorgu** değerlendirildi; **26 sorgu "örneklemde ilgili ürün yok/az (≤ 2)"** olarak AYRI raporlandı (ortalamaya girmez).
| Yöntem | P@10 | nDCG@10 | ilgisiz@10 | aksesuar-ana@10 | ort. dönen |
|---|---|---|---|---|---|
| Metin | 0,17 | 0,47 | 0,02 | 0,10 | 2,0 |
| Yalnız anlamsal (kapısız, ilk 50) | 0,37 | 0,78 | 0,11 | 0,27 | 10,4 |
| Hibrit (kapılı) | 0,26 | 0,62 | 0,04 | 0,07 | 2,9 |
EN (6 sorgu): nDCG metin 0,54 / anlamsal 0,79 / hibrit 0,64. TR (6 sorgu): 0,39 / 0,77 / 0,59 (metin 'erkek pantolon' ve 'araç led ışık'ta 0,00; hibrit 0,78 ve 0,45).
Yorum (temkinli): havuzda her sorgunun ilgili ürünü 3–9 adet; P@10 paydası 10 olduğundan kısa listeler (hibrit ort. 2,9 sonuç) P@10'u düşürür. Yalnız anlamsal en yüksek nDCG'yi verir ama kapısızdır
(ilgisiz@10 0,11; aksesuarı ana ürün gibi dizer: 0,27); hibrit ilgisizi 0,04'e ve aksesuar-ana'yı 0,07'ye indirir ama kapı bazı ilgili ürünleri de eler. Bu küçük havuzda "hibrit > yalnız anlamsal"
ÇIKMADI; hibrit > metin bulgusu burada da geçerli. Havuz çok küçük olduğundan hiçbiri genellenemez.
Türkçe-İngilizce eşleşme çalışıyor: TR sorguda metin çoğunlukla 0 ya da yanlış sonuç veriyor ('telefon kılıfı' metin 12 sonuç, ilgisiz@10 0,80); anlamsal/hibrit EN başlıklı ürünleri buluyor.

**Gerçek ürünlerde gözlenen arama hataları:**
- Metin eşleşmesi alakasız sözcük örtüşmesinde kalıyor: 'laptop keyboard' → klavye müzik standı ve fare altlığı; 'drone with camera' → güvenlik kamerası ve pil kapağı (ilgisiz@10 1,00 hem metinde hem hibritte; örnekte laptop klavyesi/drone yok ya da az).
- Hibrit kapıdan ilgisiz geçirdi: 'kulaklık pedi' → kulaklık temizleme kalemi (yedek parça ayrımı yok); 'cat food' → kedi/köpek kaka poşeti ve evcil hayvan talaşı (tür kuralı 'cat/kedi'yi yakalıyor, 'food/mama' ayrımı yok).
- Kapı fazla sıkı: 'gider hortumu' (TR) en iyi benzerlik 0,27 < 0,30 → 0 sonuç. Düşük mutlak benzerlikli TR→EN eşleşmeleri kapıda kalıyor (önceki 0,28–0,50 bulgusuyla tutarlı).
- Kapısız yalnız-anlamsal ilgisiz doldurur ('baby diaper' 50 sonuç, ilgili 1): üretimde kapı şart.
- Taslak etiket sınırları: sorgu başına 1–2 ilgili ürün olduğunda ('smart watch', 'sneakers') ölçüm anlamlı değil.

**Bağımsız değerlendirme için hazırlananlar (depoya konmadı; çalışma dizininde `semantic-review/pilot200/`):** `pilot200_cat.jsonl` (200 ürün), `p200_run.json` (ham sıralamalar), `p200_score.txt`,
`p200_review.csv` (her sorgu için metin ve hibrit ilk 10; taslak etiket + boş `insan_etiketi(0/1/2)` sütunu). Eşiklerin (0,30 / 0,12 / 48) bağımsız kümede doğrulanması koşulu AYNEN geçerli;
bu 200 ürün eşikleri ayarlamak için KULLANILMADI (yalnız ölçüldü).

**Sonraki 10.000–20.000 ürünlük pilot için gereksinimler:**
1. Üretim erişimi (SSH kararlı) ve kullanıcı onayı; mevcut Jina anahtarı (kullanıcı sızmadığını teyit etti, 8 Kasım 2026), doğrulanmış oran sınırı ve birim fiyat (ücretli katman 500 RPM / 2 M TPM; $0,050 / 1 M token). Bütçe: 20 bin × 45,5 ≈ 0,91 M token.
2. Küme tanımı: teklif/görsel ölçütleri kümeyi daraltmıyor (%98); ürün türüne dayalı örnek. Türkçe başlık üretimde çok az (%0,016): TR sorgu → EN ürün eşleşmesi esas ölçüm, Türkçe başlıklı ürün ayrıca hedeflenmeli.
3. Yerel izole DB'de 10–20 bin ürün + halfvec tablosu (yerel migration taslağı; üretime uygulanmaz) + HNSW (yükleme sonrası kur); disk/WAL ölçümü yerelde.
4. ≥ 60 sorgu (kalibrasyon ayrı, bağımsız doğrulama ayrı), insan etiketli (CSV hazır), "örneklemde yok" sorguları ayrı; yedek-parça kuralı ve 'cat food' türü kısmi tür eşleşmeleri düzeltilmeli.
5. Seçicideki yetişkin içerik süzgeci yeni kümede doğrulanmalı. Sorgu metni için KVKK/kişisel veri süzgeci hibrit yoluna bağlanmalı.


## Ek: 200 ürünlük pilotun hata analizi ve insan değerlendirme altyapısı
Ayrıntı ve kanıt: `docs/semantic-pilot/pilot200-error-analysis.md` (hata sınıfları, kural etiketlerinin güvenilmezliği, kapsam etkisi), `docs/semantic-pilot/labeling-guide.md` + `docs/semantic-pilot/human-eval/` (kör etiketleme havuzu, 0/240 etiketlenmiş), `docs/semantic-pilot/eval-plan-pilot2.md` (110 sorgu, aile bazlı kalibrasyon/doğrulama bölmesi). Algoritma ve eşikler DEĞİŞTİRİLMEDİ; insan etiketi gelmeden doğruluk iddiası yoktur.


## Ek: referans etiketlerle ölçüm (AI-assisted, user-reviewed)
A/B etiketleri ilgililikte 240/240 aynıdır (bağımsız insan güvenilirliği kanıtı DEĞİL). Ölçüm ve analiz: `docs/semantic-pilot/pilot200-evaluation-report.md`; referans veri: `docs/semantic-pilot/human-eval/reference_ai_assisted_user_reviewed/`.


## Ek: düzeltme turu 1
Doğrulanmış 4 filtre/niyet hatası düzeltildi (parça isteği SQL dışlaması, TR iyelik ekli parça isteği, nozul, İngilizce özellik edatı); eşik değişmedi. Önce/sonra ölçüm ve kalan sorunlar: `docs/semantic-pilot/fixes-round1/REPORT.md`.
