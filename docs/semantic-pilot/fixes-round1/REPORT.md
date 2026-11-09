# Düzeltme turu 1: doğrulanmış arama hataları (karar 0170)

Etiket kökeni: **AI-assisted, user-reviewed** (bağımsız insan değerlendirmesi değil). Ölçüm: aynı 200 ürün (yerel `arilla_pilot200`), aynı 38 sorgu,
aynı sorgu vektörleri (`qvec_p200.json`, **API çağrısı yok**), aynı referans etiketler ve aynı paydalar. 38 sorgunun hepsi 110 sorguluk planda
**yalnız kalibrasyon** ailelerindendir (`seen_in_pilot200`); bağımsız doğrulama kümesi kullanılmadı. Eşikler değişmedi. 200 ürünlük örnekteki değişim üretim başarısı değildir.

## 0. Referans kayıtları
- Önceki durum: `baseline/run.json` (ham sıralamalar), `baseline/score.json`, `baseline/query_table.md`. Kod değişmeden önce yeniden çalıştırıldı: 38 sorgu × 3 yöntem **birebir aynı** (deterministik).
- Sonraki durum: `after/run.json`, `after/score.json`, `after/score_stdout.txt`; karşılaştırma `comparison.txt` (`python -m semantic_pilot.compare_runs`).
- Hakem listesi (insan kararı bekleyen, otomatik çözülmedi): `../human-eval/reference_ai_assisted_user_reviewed/adjudication_types_and_targets.csv` — **29 ürün türü + 4 sorgu hedefi**. İlgililik etiketleri değiştirilmedi.

## 1. Düzeltilen hatalar ve kök nedenleri

| # | Hata | Kök neden (kanıt) | Düzeltme (genel kural) | Dosya |
|---|---|---|---|---|
| 1 | `kulaklık pedi`: iki doğru ped ürünü SQL aday listesine giremiyordu | `productTitleExclusionPattern` sorguyu "kulaklık" cihaz araması sayıp `earpad`, `cushion`, `replacement` başlıklarını dışlıyordu; sorgudaki "ped/pedi" parça isteği olarak tanınmıyordu | Kulaklık sorgusunda **parça isteği** (`ped, pedi, pedleri, pad(s), ear pads/cushions/tips, yedek…, replacement, spare, parça…, parts`) varsa cihaz-aksesuar dışlaması uygulanmaz. Cihaz aramasında dışlama aynen sürer | `packages/core/src/search/product-title-guard.ts` |
| 2 | `dizüstü bilgisayar pili` (TR) hibritte en iyi ürünü (pil, benzerlik 0,50) kaybediyordu; EN `laptop battery` kaybetmiyordu | `queryWantsAccessory` yalnız `\bpil\b` tanıyordu; Türkçe iyelik eki ("pili", "pilleri") tanınmadı → hibrit aksesuar koruması "Laptop Battery For HP" başlığını eledi | Parça isteği sözlüğüne TR iyelik ekli `pil(i|ler|leri)` eklendi | `packages/core/src/search/semantic/accessory-guard.ts` |
| 3 | `3d yazıcı nozul` (TR) hibrit nozul contasını eleyip PLA filament döndürüyordu; EN'de conta metin yolundan geliyordu | "nozzle/nozul" parça isteği olarak tanınmıyordu (iki dilde de); TR'de metin 0 sonuç olduğu için koruma tek kaynağı eliyordu | `nozzle(s)`, `nozul…` parça isteğine eklendi (TR/EN aynı karar) | aynı dosya |
| 4 | `drone with camera` tür olarak "camera" çıkarılıyor, hibrit güvenlik kamerası döndürüyordu; TR `kameralı drone` doğru (drone) | Baş isim = sorgudaki **son** tür; İngilizce özellik öbeğinde ("with camera") son isim özelliktir | `with, without, w, featuring, including` edatından **sonraki** tür baş isim sayılmaz; edattan önce tür yoksa zorunluluk yok. `for` bilerek hariç ("case for phone") | `packages/core/src/search/semantic/product-type.ts` |

Sorgu metnine özel sabit sonuç veya istisna yok; kurallar dil kalıplarıdır ve TR/EN eşdeğerleri için aynı karar verdiği testlenmiştir.

**Dikkat (davranış kapsamı):** düzeltme 1 `product-title-guard.ts` içindedir ve yalnız anlamsal yolu değil **mevcut metin aramasını da** etkiler (bayrak kapalıyken de). Etki: kulaklık + parça isteği içeren sorgularda dışlama artık uygulanmıyor.
200 üründe metin yolunun sonuçları değişmedi (TR sorgu EN başlıkla sözcük eşleşmesi bulamıyor). Düzeltme 2–4 yalnız anlamsal/hibrit yoldadır (`SEMANTIC_SEARCH_ENABLED` varsayılan kapalı).

## 2. Önce/sonra metrikleri
Aynı payda: **iki çalıştırmada da `ok` olan 34 sorgu** (38'den: `gider hortumu` no_relevant, `yoga mat/matı` verified_absent, `kulaklık pedi` sonrası `incomplete` — bkz. §3).
Recall@10 yalnız ≥3 etiketli ilgili ürünü olan 13 sorguda. P@10 sabit payda 10; P@ret dönen sonuca göre (ayrı metrik).

| Yöntem | | P@10 (≥1) | P@10 (=2) | P@ret (n) | İlgisiz (n) | nDCG@10 | MRR | Recall@10 (n=13) | Tür karışması (n) | Sıfır sonuç (34) |
|---|---|---|---|---|---|---|---|---|---|---|
| Metin | önce / sonra | 0,11 / 0,11 | 0,05 / 0,05 | 0,84 / 0,84 (27) | 0,16 / 0,16 (27) | 0,61 / 0,61 | 0,74 / 0,74 | 0,40 / 0,40 | 0,40 / 0,40 (22) | 0,21 / 0,21 |
| Anlamsal (kapısız) | önce / sonra | 0,23 / 0,24 | 0,09 / 0,09 | 0,51 / 0,54 (34) | 0,49 / 0,46 (34) | 0,87 / 0,90 | 0,91 / 0,94 | 0,85 / 0,85 | 0,48 / 0,52 (18) | 0 / 0 |
| Hibrit | önce / sonra | 0,15 / 0,16 | 0,08 / 0,08 | 0,76 / 0,81 (34) | 0,24 / 0,19 (34) | **0,75 / 0,80** | 0,88 / 0,91 | 0,54 / 0,54 | 0,36 / 0,34 (26→27) | 0 / 0 |

Dil kırılımı (hibrit, nDCG@10 / ilgisiz oranı): **EN (18)** 0,72 → 0,77 / 0,28 → 0,23; **TR (16)** 0,80 → 0,82 / 0,19 → 0,16. Metin yolu iki dilde de değişmedi.
38 sorgu üzerinden sıfır sonuç oranı değişmedi: metin 0,289, anlamsal 0,053, hibrit 0,079.

**Sorgu bazında (34 ortak sorgu, nDCG@10):** iyileşen 3, kötüleşen **0**. Değişmeyen 31 sorgunun sıralamaları birebir aynı (yalnız 4 hedef sorgu × yöntem değişti).

| Sorgu | Yöntem | Önce → Sonra | Açıklama |
|---|---|---|---|
| dizüstü bilgisayar pili | hibrit | nDCG 0,61 → **1,00**; P@10 0,10 → 0,20 | iki doğru pil de üstte; EN `laptop battery` ile aynı |
| drone with camera | anlamsal, hibrit | nDCG 0,00 → 1,00; P@10 0 → 0,10 | güvenlik kamerası ve telefon pil kapağı gitti; tek sonuç drone motoru (**etiket 1, kısmen; parça**). Katalogda kameralı drone **yok** (`n_strict=0`): bu artış "doğru ürün bulundu" değil, "yanlış tür artık gelmiyor" demektir |
| 3d yazıcı nozul | hibrit | P@10/nDCG aynı (0,10 / 0,61) | tek sonuç PLA filament (1) → nozul contası (1); metrik değişmedi ama TR/EN sonuçları artık aynı |
| kulaklık pedi | hibrit (yöntem düzeyinde) | nDCG 0,15 → **0,46**; ilk sonuç temizleme kalemi (1) → "Replacement Ear Pads…" (**2**) | sorgu genel ortalamada ölçüm dışı (aşağıda); metin yine 0 sonuç |

## 3. Hâlâ başarısız ya da ölçülemeyen sorgular
- **kulaklık pedi:** düzeltme sonrası anlamsal ilk 10'a **etiketsiz** bir ürün girdi (ürün 53) → sorgu `incomplete`, ortalamaya alınmadı (etiketsiz ürün ilgisiz sayılmadı). Etiket gerekli: `labels_needed.csv` (1 satır).
  İkinci doğru ped (ürün 9, benzerlik 0,358) hibritte hâlâ yok: en iyi 0,486'dan 0,128 geride → **gap kapısı (0,12)**.
- **cat food:** doğru kedi maması (benzerlik 0,282) **min kapısı (0,30)** altında; kapıyı geçen kaka poşeti (0,315) ve talaş (0,309) üstte. Hibrit nDCG 0,00. Eşik değiştirilmedi (§4).
- **gider hortumu:** TR sorgu vektörünün doğru ürünle benzerliği 0,028 (embedding); hibrit 0 sonuç. Bu turun kapsamında değil.
- **erkek pantolon / men pants:** ilk sonuç kemer (etiket 1). Kök neden veri kalitesi (anahtar sözcük doldurulmuş başlık "...Belt ... Jeans/Pants") + kemerin en yüksek benzerlik. Tür koruması kemeri tutuyor çünkü başlık "pants/jeans" içeriyor. **Düzeltilmedi:** başlıktaki "ilk tür" kuralı gibi bir değişiklik çok sayıda doğru ürünü (ör. "Speaker … for phone") riske atar; ölçüm ve tasarım gerekir.
- **laptop keyboard / dizüstü klavye:** katalogda yok; üç yöntem müzik klavyesi standı (0) ve fare altlığı (1) döndürüyor. Sorgu niyeti A/B'de anlaşmazlıklı (unclear/main). **Düzeltilmedi** (ürün kararı: kabul edilen anlamsal aday yokken ilgisiz metin sonucu gösterme politikası).
- **drone with camera:** tür hatası düzeldi ama katalogda doğru ürün yok; tek sonuç bir parça (kısmen).

## 4. Hibrit Recall kaybı (eşik değişmedi)
Sonraki çalıştırmada, anlamsal ilk 10'da olup hibritte olmayan **etiketli ilgili** (≥1) 32 (sorgu, ürün) çifti:

| Neden | Çift | Bunların içinde doğrudan ilgili (=2) |
|---|---|---|
| Aksesuar koruması (sorgu ana ürün istiyor, ürün aksesuar/parça) | 11 | 0 (hepsi etiket 1 — bluetooth speaker aksesuarları, robot süpürge parçaları) |
| Min kapısı (benzerlik < 0,30) | 11 | **1** (`cat food` kedi maması 0,282) |
| Gap kapısı (en iyiden > 0,12 geride) | 10 | **1** (`kulaklık pedi` ped 0,358) |

Yorum: Recall@10 (≥1) "kısmen ilgili" aksesuarları da sayar; aksesuar koruması bunları **bilerek** dışarıda bırakır, dolayısıyla Recall@10 (≥1) farkının çoğu tasarım gereğidir.
Doğrudan ilgili kayıp yalnız 2 çifttir. Bu iki örnekle eşik değiştirmek gerekçelendirilemez: 0,282'yi geçirecek bir min eşiği (≤0,28) aynı sorguda kaka poşeti/talaşı zaten geçirirken
diğer sorgulara ne getirdiği ölçülmeden uygulanamaz. Öneri: kalibrasyon ailelerinde (eval-plan) eşik taraması, **TR/EN ayrı** ve sorgu uzunluğuna göre; doğrulama kümesinde tek ölçüm.

## 5. Regresyon testleri
`packages/core/src/search/semantic/pilot200-fixes.test.ts` (26 test):
- SQL filtresi: 5 parça isteği sorgusu (TR/EN) dışlama uygulamaz; cihaz aramasında dışlama sürer; `ipad`/`gamepad` alt dizisi parça isteği sayılmaz.
- Sorgu niyeti: 6 parça sorgusu (iyelik ekli TR dâhil) korumayı kapatır; 5 ana ürün sorgusu (`pilates topu` dâhil, `pil` alt dizisi) açık tutar; TR/EN eşdeğerleri aynı kararı verir.
- Ürün türü: `drone with camera` drone ister, kamerayı istemez; TR eşdeğeriyle aynı desen; `headphones with/without mic`, `jacket with hood`; edatsız sorgular değişmez; edattan önce tür yoksa zorunluluk yok.
Python: `semantic_pilot/compare_runs.py` (aynı sorgu kümesi/payda ile karşılaştırma).

## 6. Çalıştırılan testler
- `packages/core` birim testleri: **170 dosya, 2495 test geçti**; `tsc --noEmit` hatasız; Biome (değişen dosyalar) temiz.
- Entegrasyon (yerel DB `arilla`): semantik/candidate-limit/quality geçti; `search.integration.test.ts`'te **3 test başarısız — değişikliklerim geri alınarak (stash) aynı 3 test yine başarısız**: yerel test DB'sinde pilot için yüklenmiş 15 bin gerçek ürün tohum verisini bozuyor (önceden var olan, bu turla ilgisiz). CI'da temiz veritabanıyla doğrulanmalı.
- `services/ingest`: pilot ve ölçüm testleri (`test_human_eval`, `test_eval_plan`, `test_pilot200`, `test_enrich_*`, `test_semantic_pilot*`): **58 geçti**; `ruff` temiz.

## 7. Çözülmemiş etiket anlaşmazlıkları
29 ürün türü + 4 sorgu hedefi (`adjudication_types_and_targets.csv`) ve 20 `KARARSIZ` çift (`adjudication_open.csv`) insan kararı bekliyor. Tür karışması metriği bu nedenle 18–27 sorguda hesaplanabiliyor.
Ayrıca `labels_needed.csv`: düzeltme sonrası ortaya çıkan 1 etiketsiz (sorgu, ürün) çifti.

## 8. Kalan riskler
1. Örnek çok küçük (200 ürün, 34 ortak sorgu); 3 sorgunun iyileşmesi istatistiksel kanıt değildir. Etiketler tek kaynaklı.
2. Parça isteği sözlüğü elle bakımlı; yeni parça isimleri (ör. "conta", "fırça başlığı", "rulman") eksik kalabilir. Sözlük genişledikçe aksesuar koruması daha çok sorguda kapanır → ana ürün aramalarında yanlışlıkla kapanma riski (ör. "pil" içeren ana ürün adları) testle izlenmeli.
3. Düzeltme 1 metin aramasını da etkiler; üretim davranış değişikliğidir (küçük ve hedefli, ama dağıtımdan önce gözden geçirilmeli).
4. Edat kuralı yalnız İngilizce; Türkçe "ile" bilerek eklenmedi (ölçüm yok).
5. Eşik kaynaklı 2 doğrudan ilgili kayıp ve TR embedding zayıflığı (gider hortumu) çözülmedi.
6. Yerel entegrasyon DB'si kirli (3 önceden var olan hata).

## 9. 10–20 bin ürünlük pilot için hazırlık durumu
| Alan | Durum |
|---|---|
| Doğrulanmış filtre/niyet hataları (bu tur) | 4/4 düzeltildi, regresyon testli |
| Ölçüm altyapısı (kör havuz, uyum, hakem, birleştirme, aynı-payda karşılaştırma) | Hazır |
| Bağımsız insan etiketi | **Yok** (AI-assisted, user-reviewed); 33 + 20 hakem kararı ve 1 eksik etiket bekliyor |
| Eşik kalibrasyonu (TR/EN ayrı) | Yapılmadı; kalibrasyon kümesiyle yapılmalı |
| TR→EN embedding zayıflığı | Açık (sorgu zenginleştirme/çeviri seçenekleri değerlendirilmedi) |
| Veri kalitesi (anahtar sözcük doldurulmuş başlıklar) | Açık |
| Altyapı (halfvec migration taslağı, HNSW, disk/WAL hesapları) | Taslak/hesap hazır; yerelde 10–20 bin ürünle ölçülmedi |
| Yeni Jina anahtarı, oran sınırı, birim fiyat | Kullanıcı aksiyonu bekliyor |
Sonuç: kod tarafındaki bilinen filtre/niyet hataları giderildi; **pilota geçmeden önce** en az (a) bağımsız etiketleme ya da hakem kararları, (b) TR/EN ayrı eşik kalibrasyonu planı ve (c) temiz bir yerel/CI veritabanında entegrasyon testleri gereklidir.
