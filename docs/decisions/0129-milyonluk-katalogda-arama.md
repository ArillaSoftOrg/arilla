# 0129 — Milyonluk katalogda metin araması: sınırlı aday kümesi ve yurt dışı ürün

**Tarih:** 17 Ekim 2026
**Durum:** Kabul edildi (migration 0083; kolon 0076, karar 0127 / PR #165 ile ortak). Kod, testler ve yerel
ölçüm hazır; üretimde çalıştırılmadı.
Üretimde 2.769.478 AliExpress ürünü **taslak**; bu karar hiçbir ürünü yayınlamaz.
**Bağlam:** 0029 (token kapısı), 0066 (aşamalı arama, "bilinen ölçek sınırı"), 0113/0114 (TRY dışı fiyat,
TCMB kuru), 0121 (kaynak ilanından ürün), 0125 (`kind: concurrent`), 0127 (yurt dışı teklif fiyat özeti,
`foreign_offer_count`, PR #165). Önceki taslak numarası 0124 idi; 0124 artık Hepsiburada kota modelidir.

## Sorun

1. **Yurt dışı ürün görünmüyordu.** `offer_count`, `best_offer`, görsel arama ve alternatifler yalnızca TRY
   teklif sayıyordu; AliExpress beslemesinin tamamı USD olduğundan yayınlanacak 2,8M ürünün tamamı aramada
   sıfır sonuç olurdu.
2. **Arama milyonluk katalogda çöküyordu.** Sentetik 2,8M üründe metin araması 37–61 sn sürüyordu. Ölçülen
   nedenler:
   - Baş isim ön filtresi (`headPrefilter`) **sınırsızdı**: "kılıf", "case" gibi yaygın bir baş isim yüz
     binlerce ürünle eşleşir; trigram GIN'i eşik `<<%` için kayıplı olduğundan her satır yeniden
     denetlenir (uzun AliExpress başlıklarında pahalı). Ardından token LATERAL'i, skor, görsel
     tekilleştirme ve `count(*) OVER()` bu kümenin tamamında koşuyordu.
   - **Aynı pahalı filtre iki kez** çalışıyordu: ürünler için ve `best_offer` CTE'sinin kapsamı için.
   - Metinsiz (yalnızca filtre) sorguda `best_offer` **tüm teklif tablosunu** `DISTINCT ON` ile tarıyordu
     (0066'daki bilinen sınır).
   - Fallback aşamaları (alias, bulanık, gevşetme) bu maliyeti tekrar ediyordu.
   - Asıl kök neden `<<%` operatörünün kendisi: eşik benzerliği için trigram GIN kayıplıdır; kısa bir
     kelimede (" ca", "ta " gibi yaygın trigramlar) yüz binlerce satırı aday yapıp her birinde
     `strict_word_similarity` hesaplatır. 3,77M üründe "canta" için indeksle bile 19 sn sürdü.

## Karar

### A. Sınırlı aday kümesi (metin araması, `/ara` ve `/sohbet`)

1. Her arama önce **bir kez** `cand` CTE'sini kurar (`text-match.ts` `candidateCtes`); teklif seçimi, metin
   kapısı, skor, görsel tekilleştirme ve sayım YALNIZCA onun üzerinde çalışır. Aynı filtre ikinci kez
   çalışmaz; `best_offer` yalnızca `o.product_id IN (SELECT id FROM cand)` için hesaplanır. Tüm teklif
   tablosunu tarayan yol kaldırıldı (görsel arama ve alternatifler zaten aday kümesiyle sınırlıydı).
2. **İki bölüm, ayrı sınır:** TRY teklifli ürün (`offer_count > 0`) ve geri kalan yayındaki ürün
   (`offer_count = 0`: yurt dışı kaynak ilanı ya da özeti gecikmiş ürün). İki bölüm birlikte tüm yayındaki
   ürünleri kapsar; hiçbir ürün bölümsüz kalmaz. 2,8M yurt dışı ilan, aynı kelimeyi taşıyan TRY ürünlerini
   (bugün Shopify, yarın Hepsiburada/Trendyol) adaydan itemez. Her bölümün kendi kısmi başlık GIN'i vardır
   (migration 0083, `CONCURRENTLY`).
3. Her bölümde dallar, her biri en fazla `CANDIDATE_LIMIT` = 1000 ürün:
   - **Sıkı dal** (2+ slot): TÜM slotlar başlıkta, markada ya da ana kategori adında eşleşir. Baş isim
     dalı dolsa bile en alakalı ürünler (tüm niteleyiciler) aday kalır. İki slotta tek daldır: kapı iki
     slotu da ister, baş isim dalının ek adayı kapıdan geçemezdi.
   - **Baş isim dalı** (1 ve 3+ slot): eski `headPrefilter` kümesi, sınırlı. Metin yoksa ürün kolonu
     filtreleri.
   - **Bulanık (yazım hatası) aşaması:** her 5+ harfli kelime için ayrı, tek koşullu `<<%` dalı (eşik
     işlem içinde 0,3), en fazla 3 kelime. Kısa kelimede eşik 0,3 neredeyse her başlığı aday yapar.
   Dallar `UNION ALL` + `LIMIT` ile yazılır: dal sınıra ulaşınca durur.
4. **Aday dalında başlık eşleşmesi kelime başı kök regex'idir** (`candidatePattern`): kelimenin sonundan
   en fazla iki harf atılmış kökü (en az 4 harf) kelime başında aranır: "cantasi" → `\mcanta`, "koltuk" →
   `\mkolt` ("koltuğu"), "kulaklik" → `\mkulakl`. Trigram GIN regex'in TÜM trigramlarını (VE) ister: aynı
   indeksle "canta" 19 sn → 7 ms. 1–2 harfli kelime ("tv", "4k") trigram üretmez, `<<%` kalır. Bu
   yalnızca ADAY seçimidir; nihai kabul yine 0,5 eşikli trigram kapısıdır.
5. **Planlayıcı indekse yönlendirilir** (`withCandidatePlan`): pg_trgm yüklemleri için seçicilik tahmini
   sabittir; planlayıcı `LIMIT`'e güvenip sıralı taramayı seçer ve eşleşmesi olmayan bölümde 3,77M
   satırı tarar (39 sn). Arama sorgusu kendi işleminde `set_config('enable_seqscan', 'off', true)` ile
   çalışır; ayar işlem bitince düşer, havuza sızmaz. Ek maliyet bir ifade (~1 ms).
6. **Ürün kolonu filtreleri aday dalına itilir** (kategori alt ağacı, renk, marka dahil/hariç). Sınırlı
   dal seyrek filtreli bir sorguda (ör. "kılıf" + bir marka) eşleşmeyen ürünlerle dolmaz. Filtreler sonra
   `buildFilterClause` ile AYNEN yeniden uygulanır; sonuç kümesi değişmez. Teklife bağlı filtreler
   (mağaza, stok, fiyat, beden) teklif seçiminden sonra uygulanır.
7. **"En iyi fırsatlar"** yalnızca TRY bölümünden ve şişik olmayan fiyat istatistiği olan üründen aday
   alır (sekmenin kendi koşulu); aksi halde sınırlı dal yurt dışı ilanlarla dolar ve sekme boş kalırdı.
8. **Metin kapısı, eşik ve skor değişmedi** (0029): `strict_word_similarity` ≥ 0,5, baş isim zorunlu, 3+
   slotta bir niteleyici eksik olabilir; dengeli skor aynı. Türkçe/İngilizce eş anlamlı slotlar
   (`lexicon`), marka ve ana kategori eşleşmesi, model kodu doğrulaması ve görsel tekilleştirme aynıdır.
   Varyantlar (renk/beden) ayrı ürün olarak kalır; birleştirme yok.
9. **Toplam dürüst gösterilir.** Kapıdan geçen her ürünü kapsaması gereken dal (tek slotta ve 3+ slotta
   baş isim dalı, iki slotta sıkı dal) sınıra ulaştıysa `totalCapped = true` döner ve arayüz
   "1.000+ sonuç" yazar. Sayfalama aday kümesinin içinde kalır.
10. **Zaman aşımı değişmedi.** Sohbet aramasının 4 sn'lik `INTENT_SEARCH_TIMEOUT_MS` sınırı aynı; bu karar
   `/ara`'ya zaman aşımı eklemez (ayrı PR #168 adım başına 5 sn'lik işlem içi sınır öneriyor; ölçülen en
   kötü süre 0,75 sn olduğundan ikisi çatışmaz).

### B. Yurt dışı (TRY dışı) teklifli ürün arama yüzeylerinde (önceki 0124 taslağı)

1. **Fiyat özeti TRY-only kalır.** `min_price`, `max_price`, `offer_count`, `in_stock_count` değişmez (0113).
   Yeni kolon `product.foreign_offer_count` = aktif mağazanın fiyatlı aktif TRY DIŞI teklifi olan farklı
   mağaza sayısı. TS (`refresh-aggregates.ts`) ve Python (`db/product_aggregates.py`) aynı SQL'i taşır.
   Kolon ve özet SQL'i karar 0127 (PR #165) ile birebir aynıdır; migration 0076 iki dalda aynı dosyadır.
2. **Arama uygunluğu** `offer_count > 0 OR foreign_offer_count > 0` (görsel arama, alternatifler).
3. **`best_offer` önce TRY teklifini seçer.** TRY teklif yoksa yurt dışı teklif, son TCMB döviz satış kuruyla
   (`fx_rate`, en fazla `MAX_RATE_AGE_DAYS` = 4 gün eski, gelecek tarihli değil) **yaklaşık kuruş** olur:
   `round(current_price * rate)` — numeric, float yok, yarım yukarı (`pricing/fx.ts` ile aynı). Güncel kur
   yoksa yurt dışı teklif seçilmez; kur uydurulmaz. Orijinal tutar, para birimi ve kur tarihi
   (`foreignPrice`) sonuçla taşınır. **0132 ile değişti:** kur yoksa teklif yine seçilir, TL fiyatı NULL kalır, kart
   tutarı kendi para birimiyle gösterir.
4. **Sıralama.** "Bizim seçtiklerimiz"de yurt dışı teklifin mağaza güveni `FOREIGN_OFFER_TRUST_FACTOR`
   (0,8) ile çarpılır: eşit alakada TRY teklifli ürün öndedir (kargo/gümrük/teslim belirsizliği).
   "En iyi fırsatlar" sekmesine yurt dışı teklif girmez (fiyat yüzdeliği TRY geçmişidir). Fiyat süzgeci
   yaklaşık TL üzerinden çalışır.
5. **Kart dürüst gösterir:** "≈ 1.245 TL · 30,00 USD", "Yurt dışı" rozeti, "TCMB kuru, {tarih} · Kargo ve
   vergi belirsiz" (`docs/copy.md` `offers.*`). `/ara`, görsel arama, sohbet ve ürün sayfası alternatif şeridi.
6. **Kapsam dışı (bilinçli TRY-only):** mağaza karşılaştırma, link araması aday üretimi, internet sonucuna
   katalog görseli iliştirme (AliExpress başlıkları anahtar kelime yığınıdır, "aynı ürün" kanıtı değildir,
   0119). `/gecmis`, `/hesap`, `/kaydettiklerim` kartları `product.min_price` okur; yurt dışı üründe "—".
7. **Çıkış** mevcut `/git/<offerId>` (Admitad deeplink) ile `click` üretir. Değişiklik yok.

## Reddedilen alternatifler

| Alternatif | Neden değil |
| --- | --- |
| Sınırsız ön filtre + daha büyük zaman aşımı | Ölçek sorunu çözülmez; 4 sn sınırı artırılmayacak |
| Tek aday dalı, tek sınır | 2,8M yurt dışı ilan TRY ürünlerini adaydan iter; "En iyi fırsatlar" boş kalır |
| `tsvector` (tam metin) ile aday | Türkçe ek/ünsüz yumuşaması ("koltuk"/"koltuğu") ve kapının trigram eşiğiyle uyum ayrı sezgisel kök bulma ister; aday kümesi kapının kabul ettiği ürünleri kaçırır. Trigram aynı operatörle (`<<%`) kapıyla tutarlı kalır |
| Önceden hesaplanmış arama belgesi kolonu (başlık+marka+renk+kategori) | 2,8M+ satırlık geri doldurma ve her marka/kategori değişikliğinde yeniden yazma; ölçülen darboğaz bu değildi |
| Ayrı arama motoru (OpenSearch vb.) | Şimdilik gereksiz; `SearchProvider` arayüzü geçişe hazır. 10M+ TRY ürünü ve alaka sıralamasının sınırlı kümenin ötesine taşması gerektiğinde yeniden değerlendirilir |
| `offer_count`'a yurt dışını da saymak | `min_price` ve "N mağaza" USD kuruşla kirlenir (0113) |
| Yaklaşık TL'yi `product.min_price`'a yazmak | Kur her gün değişir: 2,8M satır günlük yeniden yazılır (WAL, şişme) |

## Ölçüm (yerel PostgreSQL 16, üretim ayarları; sentetik veri, üretim ölçülmedi)

Veri: 1.000.000 TRY ürünü (Türkçe başlık, 3.060 marka, 26 kategori, 4M teklif) + 2.769.478 AliExpress
tarzı USD ürünü (İngilizce anahtar kelime başlıkları, ürün başına 1 teklif), hepsi yayında (gelecekteki
durum). `shared_buffers` 2 GB, `work_mem` 16 MB, `random_page_cost` 1,1, konteyner 6 GB. Ölçüm:
`scale.perf.integration.test.ts` (`SEARCH_PERF=1`), `/ara` hattı (`searchWithFallback`), ısınma + 5 koşu.

| | Eski (sınırsız ön filtre) | Yeni |
| --- | --- | --- |
| 33 sorgu × 5 koşu, p50 / p95 / en kötü | — | **168 / 561 / 751 ms** |
| 14 sorgu, tek koşu, p50 / p95 / en kötü | 33,9 / 65,8 / 65,8 sn | 0,07–0,6 sn (aynı sorgular) |
| "çanta" | 57,5 sn | 67 ms |
| "kablosuz kulaklık" | 65,8 sn | 561 ms |
| "phone case" | 62,4 sn | 293 ms |
| "airpdos pro" (yazım hatası) | 54,2 sn, sonuç yok (bütçe doldu) | 168 ms, 48 sonuç |

Doğruluk (14 sorgu, ilk 24, başlık+marka her deseni taşımalı, değerlendirme seti kuralı): eski 302/302,
yeni 326/326 alakalı; ilk 24'teki TRY ürün payı her sorguda aynı. Sınıra ulaşmayan sorgularda (stanley
termos 14, nike ayakkabı 2000 TL altı 317, iphone 15 pro max kılıf 96) toplam birebir aynı ve ilk 24 aynı
ya da 19/24 ortak. Sınıra ulaşan yaygın sorgularda ilk 24'ün eskiyle örtüşmesi düşüktür (0–5/24): binlerce
eşit alakalı ürünün farklı bir alt kümesi seçilir.

İndeks boyutu (REINDEX sonrası): `product_title_fold_try_trgm` 91 MB (1M ürün),
`product_title_fold_foreign_trgm` 246 MB (2,77M ürün); `CONCURRENTLY` kurulumu ikisi birlikte 5 dk.
Bugün üretimde yalnızca yayındaki ürünleri kapsadıkları için (taslaklar girmez) küçük ve hızlıdır.

## Sonuçlar ve riskler

- **Aday kökü sezgiseldir.** Kapının kabul edeceği ama kelimesi kökle başlamayan ürün (bitişik yazılmış
  "telefonkılıfı" gibi) aday olmaz. Sınıra ulaşmayan ölçülen sorgularda toplamlar eskiyle aynı çıktı;
  regresyon testleri (Türkçe ek, eş anlamlı, marka, model kodu) geçti.
- **Sıralama sınırlı kümenin içindedir.** Eşleşme sınırı aşınca (ör. tek kelimelik "kılıf") bölüm başına
  1000 aday fiziksel sırayla gelir; 24'lük ilk sayfa bunların içinden dengeli skorla seçilir. Kartlar
  doğru ve alakalıdır, ama "tüm eşleşmelerin en iyisi" garanti değildir. Niteleyici eklenen sorgular sıkı
  dalla en alakalıları öne alır. Tek bölümde 10M+ ürün olduğunda arama motoru değerlendirilmelidir.
- **Taslaklar indekse girmez.** Yayın (`catalog_build publish`) ürünü bölüm GIN'ine ekler; toplu yayında
  GIN yazımı ve WAL hesaba katılmalı (yayın kademeli: `publish --limit`).
- Eski `product_title_fold_trgm` yönetim katalog araması için kalır; yeni bölüm indeksleriyle aynı satırları
  kapsar. Toplu yayından önce yönetim araması bölüm indekslerine taşınıp eski indeks `DROP INDEX
  CONCURRENTLY` ile kaldırılmalı (ayrı iş).
- Kur 4 günden eskiyse yurt dışı ürünler aramadan düşer. `python -m pricing fx` günlük zamanlanmalıdır.
- `foreign_offer_count` mevcut ürünlerde 0 başlar; doğru değer `publish` ya da fiyat özeti onarımıyla yazılır.
