# 200 ürünlük pilot: referans etiketlerle ölçüm raporu (karar 0170)

**Etiket kökeni: AI-assisted, user-reviewed.** Etiketler iki bağımsız insan değerlendirici tarafından üretilmedi; yapay zekâ hazırladı, kullanıcı inceleyip onayladı.
Bu rapordaki hiçbir sayı "bağımsız insan doğrulaması" olarak okunmamalıdır. Algoritma, eşik, embedding, API ve üretim sistemi değişmedi.
Gösterim: **[D]** doğrulanmış (veri/kod yeniden çalıştırıldı), **[G]** gözlem, **[H]** hipotez.

## 1. Veri bütünlüğü (Görev 1)
Dosyalar: `docs/semantic-pilot/human-eval/{labeling_pool,query_targets}_{A,B}_doldurulmus.csv`.

| Kontrol | Sonuç |
|---|---|
| Biçim | UTF-8 BOM'lu, virgül ayraçlı gerçek CSV; başlıklar ana dosyayla aynı |
| 240 çift korunmuş mu | **Evet**: A ve B'de 240 satır, 240 tekil (sorgu, ürün); kümeler ana havuzla aynı; eksik/fazla satır yok (`validate --master`) |
| Kimlik/başlık/kategori/sorgu metni | Ana dosyayla karşılaştırıldı: **değiştirilmiş alan 0** |
| Geçersiz/eksik etiket | `relevance` ve `result_type` 240/240 dolu, geçersiz değer yok; `labeler` sütunu A/B tutarlı |
| 36 / 38 | Havuz 36 sorgu; hedef tablosu 38. `yoga mat`, `yoga matı` havuzda yok (üç yöntem de 0 sonuç + ilgili aday yok); iki tarafta `KATALOGDA YOK` işaretli. Tutarlı |
| Ürün türü | A: main 78 / accessory 80 / part 82; B: main 61 / accessory 80 / part 83 / other 16 (A hiç `other` kullanmamış) |
| Sorgu hedefi | A: main 26, part 8, accessory 2, unclear 2; B: main 26, part 8, accessory 4 |
| `KARARSIZ` | A 18, B 4 (yalnız 2 ortak) |
Veri kaybı veya yapısal tutarsızlık yok. Dosyalar otomatik düzeltilmedi.

## 2. A/B karşılaştırması (Görev 2)
- **İlgililik: 240/240 çiftte AYNI etiket** (tam uyum 1,000; ağırlıklı kappa 1,000). Fark sayısı 0. Dağılım her iki tarafta aynı: **0 → 148, 1 → 61, 2 → 31**.
- **Ürün türü:** 29 çiftte fark (tam uyum 0,879): main/accessory 8, main/other 9, accessory/other 7, part/accessory 5 (2 + 3). Farkların 16'sı yalnızca B'nin `other` kullanmasından geliyor.
- **Sorgu hedefi:** 4 sorguda fark (laptop keyboard, dizüstü klavye: A=unclear, B=main; car led light, araç led ışık: A=main, B=accessory).
- Notlar birebir aynı değil (A 23, B 37 not); `KARARSIZ`: A 18 / B 4.

**Yorum:** İlgililik etiketleri iki dosyada **birebir aynı**. Bu, aynı kaynağın (aynı model + aynı onay) iki kopyası olmasıyla uyumludur; **bağımsız insan değerlendiriciler arası güvenilirlik kanıtı değildir.**
Gerçek bağımsızlık ölçülmedi. Farklılık yalnızca ürün türü ve sorgu hedefi alanlarında (tutarlılığı daha düşük alanlar) görülüyor.

## 3. Referans veri seti (Görev 3)
`merge` ile `docs/semantic-pilot/human-eval/reference_ai_assisted_user_reviewed/` altında üretildi (`README.md` kökeni belgeler):
- **İlgililik: 240/240 uyumlu** → referans (hakem gerekmedi).
- **Çözülmeyen (insan kararı bekleyen):** 29 ürün türü, 4 sorgu hedef türü, 20 `KARARSIZ` işaretli çift (ilgililik A=B olduğundan kabul edildi, duyarlılık §4.3'te) → `adjudication_open.csv` (51 satır). Rastgele/otomatik çözüm yok; ilgili alanlar BOŞ ve "çözümlenmiş" sayılmadı.
- `result_type` boş olan çiftler ve `query_target_type` boş olan sorgular tür-karışması metriğinden çıkar; ilgililik metriklerini etkilemez.

## 4. Arama performansı (Görev 4)
Komut: `human_eval score` (`reference_*/score_result.json`). **Düzeltme:** ölçüm kodunda, ilgili ürün varken **0 sonuç dönen yöntemin nDCG@10'u tanımsız sayılıp ortalamadan atılıyordu**
(metni şişiriyordu: 0,76); şimdi 0 sayılıyor (0,59) ve test eklendi. Önceki raporlardaki otomatik-etiket nDCG sayıları bu tanıma göre okunmalı.

### 4.1 Kapsam ve paydalar
38 sorgu: **35 ölçüme girdi** (≥1 ilgili [≥1] etiketli ürünü var), 1 `no_relevant` (gider hortumu), 2 `verified_absent` (yoga mat/matı).
- P@10 = ilgili/**10** (sabit payda); `P@ret` = ilgili/**dönen sonuç** — ikisi farklı şeydir. `P@10(≥1)` kısmen+doğrudan, `P@10(=2)` yalnız doğrudan.
- Recall@10 yalnız ≥3 etiketli ilgili ürünü olan sorgularda (**14** sorgu). MRR: ilk ilgili (≥1) sonuç, ilk 10. Tür karışması: iki tür alanı da dolu sorgularda (n aşağıda).
- Sıfır sonuç oranı: 38 sorgu üzerinden **ve** 35 ölçülen sorgu üzerinden verilir. Etiketsiz sonuç ilgisiz sayılmadı (240 çiftin tamamı etiketli).

### 4.2 Tüm ölçülen sorgular (n = 35)
| Yöntem | P@10 (≥1) | P@10 (=2) | P@ret (n) | İlgisiz oranı (n) | nDCG@10 | MRR | Recall@10 (n=14) | Tür karışması (n) | Sıfır sonuç /38 | Sıfır sonuç /35 | Sonuç/sorgu (38) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Metin | 0,11 | 0,05 | 0,84 (27) | 0,16 (27) | 0,59 | 0,71 | 0,37 | 0,40 (22) | 11/38 = 0,29 | 8/35 = 0,23 | 1,5 |
| Yalnız anlamsal (kapısız) | 0,24 | 0,08 | 0,52 (35) | 0,48 (35) | 0,86 | 0,91 | 0,83 | 0,51 (19) | 2/38 = 0,05 | 0/35 | 15,4 |
| Hibrit | 0,15 | 0,08 | 0,77 (35) | 0,23 (35) | 0,74 | 0,89 | 0,51 | 0,38 (27) | 3/38 = 0,08 | 0/35 | 1,9 |

### 4.3 Duyarlılık (aynı etiketler, farklı sorgu alt kümeleri)
| Küme | n | Metin P@10≥1 / nDCG | Anlamsal | Hibrit |
|---|---|---|---|---|
| Yalnız ≥1 doğrudan ilgili (=2) ürünü olanlar | 23 | 0,10 / 0,57 | 0,27 / 0,90 | 0,17 / 0,78 |
| `KARARSIZ` içermeyen sorgular | 15 | 0,07 / 0,60 | 0,14 / 0,93 | 0,10 / 0,78 |
Sıralama (anlamsal > hibrit > metin; nDCG) tüm kümelerde aynı; mutlak değerler kümeye göre değişir (35 sorgunun 12'sinde yalnız kısmen ilgili ürün vardır — örn. `laptop keyboard`, `3d printer nozzle`).

### 4.4 Dil kırılımı
| Dil | Yöntem | P@10≥1 | nDCG@10 | MRR | Recall@10 | Sıfır sonuç |
|---|---|---|---|---|---|---|
| EN (18 ölçülen/19) | Metin / Anlamsal / Hibrit | 0,12 / 0,23 / 0,14 | 0,65 / 0,83 / 0,72 | 0,81 / 0,85 / 0,83 | 0,43 / 0,86 / 0,51 (n=7) | 0,16 / 0,05 / 0,05 |
| TR (17 ölçülen/19) | Metin / Anlamsal / Hibrit | 0,09 / 0,24 / 0,16 | 0,52 / 0,88 / 0,76 | 0,62 / 0,97 / 0,94 | 0,31 / 0,81 / 0,52 (n=7) | 0,42 / 0,05 / 0,11 |
TR'de metin yolu en zayıf (8/19 sorguda 0 sonuç). Hibrit TR'de metne göre belirgin kazanç sağlıyor (nDCG 0,76 vs 0,52); EN'de kazanç küçük (0,72 vs 0,65).

### 4.5 Sorgu bazında karşılaştırma (nDCG@10, 35 sorgu)
- Hibrit vs metin: **12 iyi / 3 kötü / 20 eşit** (kötü: `bluetooth speaker`, `kadın elbise`, `drain hose`).
- Anlamsal vs metin: 19 / 2 / 14 (kötü: `women dress`, `kadın elbise`).
- Hibrit vs anlamsal: **1 iyi / 18 kötü** / 16 eşit.
- Yoga mat / yoga matı (katalogda yok): üç yöntem de 0 sonuç → doğru davranış (`verified_absent`).

### 4.6 Okuma uyarıları
1. **Yalnız anlamsal kapısızdır:** ortalama 15,4 sonuç (8 sorguda ≥40) döndürür, ilgisiz oranı 0,48. Yüksek nDCG/Recall bu yüzden üretimde kullanılabilir bir seçenek değildir; nDCG yalnız ilk 10'a bakar ve ilgisiz sonuçları cezalandırmaz.
2. **Hibritin anlamsala göre düşük Recall'ı kapı ve korumaların bedelidir** (§5); ama hibrit ilgisiz oranını 0,48'den 0,23'e indirir.
3. P@10 değerleri düşüktür çünkü havuzda sorgu başına az ilgili ürün var (etiketli 240 çiftin yalnız 31'i =2, 61'i =1) ve P@10 paydası sabit 10'dur; **P@ret ile karıştırmayın.**
4. Tüm sayılar **200 ürün, 38 sorgu, AI-assisted etiket**; güven aralığı hesaplanmadı, örnek küçük.
5. **Kural etiketlerinin güvenilmezliği teyit edildi [D]:** otomatik (kural) etiket ile referans etiket 240 çiftin **162'sinde (%67,5)** aynı; kural "doğrudan ilgili" (2) dediği 82 çiftin 20'sini referans 0, 32'sini 1 yapmış (kural ilgiliyi abartıyor); kural 0 dediği 135 çiftin 16'sını referans 1 yapmış.

## 5. Teknik analiz: 8 sorgu (Görev 5)
Sonuç gösterimi: `sıra.[etiket | tür | benzerlik] başlık`. Sınıflar: Embedding benzerliği (EB), Sorgu niyeti (SN), Ürün türü sınıflandırması (ÜT), SQL aday filtreleme (SQL), Hibrit eşikler (HE), Veri kalitesi (VK), Katalog kapsamı (KK).

| Sorgu | Yöntem sonuçları (n; P@10; nDCG) | Ne oldu | Sınıf | Kanıt |
|---|---|---|---|---|
| **erkek pantolon** (TR) | Metin 0; 0; 0,00 · Anlamsal 9; 0,7; 0,86 · Hibrit 6; 0,6; 0,81 | Metin TR→EN başlıkta sözcük örtüşmesi bulamıyor. Anlamsal/hibrit doğru pantolonları buluyor ama **ilk sırada kemer** (etiket 1, aksesuar; benzerlik 0,442 = en yüksek); EN `men pants`: metin 4/0,81, anlamsal 1,00, hibrit 0,85 | VK + EB (metin: dil) | [G] kemer başlığı "jeans/pants" sözcükleriyle dolu; [D] kemer en yüksek benzerlikte; hibrit kapısı kemerleri tutuyor çünkü benzerlikleri yüksek |
| **laptop keyboard** | Metin/anlamsal/hibrit aynı 2 sonuç; P@10 0,1; nDCG 0,63 | Katalogda dizüstü klavyesi yok; dönenler müzik klavyesi standı (0) ve fare altlığı (1, kısmen). Üç yöntem de aynı ilgisiz sonucu döndürüyor | **KK** + HE | [D] benzerlikler 0,22/0,21 < 0,30 kapı; hibrit bunları metinden aldığı için bırakıyor (kabul edilmiş anlamsal aday yoksa metin sonucu indirilmiyor, `fusion.ts`). `n_strict=0`: sıkı ölçüte göre bu sorgu ölçülmemeli (0,63 yalnız bir "1" etiketinden) |
| **laptop battery** | Metin 2; 0,2; **1,00** · Anlamsal 11; 0,2; 1,00 · Hibrit 2; 0,2; 1,00 | İki ilgili ürünün (etiket 2, part) ikisi de üç yöntemle üstte. Anlamsal 9 ilgisiz ekliyor, hibrit eliyor. **Başarı** | — | [D] `queryWantsAccessory("laptop battery")=true` → koruma devre dışı. **TR eşdeğeri `dizüstü bilgisayar pili`**: metin 0 sonuç (0,00), anlamsal 11 (1,00), **hibrit 2 (0,61)** — en iyi ürün hibritten eleniyor | **SN** (TR) | [D] `queryWantsAccessory` TR için `false` → `looksLikeAccessory` en iyi ürünü (benzerlik 0,50) çıkarıyor |
| **kulaklık pedi** (TR) | Metin 0; 0; 0,00 · Anlamsal 5; 0,4; 0,35 · Hibrit 1; 0,1; **0,15** | 2 doğrudan ilgili ped ürünü (9, 45; etiket 2, part) **hiçbir yöntemin sonucunda yok**; hibrit tek sonuç olarak kulaklık temizleme kalemi (etiket 1) döndürüyor. EN `earpads replacement`: metin 0,46, anlamsal 0,96, hibrit 0,75 | **SQL** (+ SN) | [D] `productTitleExclusionPattern("kulaklık pedi")` `earpad/cushion/replacement` sözcüklerini dışlıyor; ped ürünü anlamsal SQL aday listesine girmiyor (tam sıralamada benzerlik 0,486 ile 1.) |
| **gider hortumu** (TR) | Metin 0 · Anlamsal 50 · Hibrit 0 | Durum `no_relevant`. **Ama katalogda ilgili ürün var**: "2Pcs 80cm Drain Pipe Hose…" (`drain hose` sorgusunda etiket 2, benzerlik 0,55, rank 1) | **EB** (+ havuz boşluğu) | [D] TR sorgu vektörünün bu ürünle benzerliği **0,028 (200 ürün arasında 99.)**; en iyi benzerlik 0,269 < 0,30 → hibrit 0. Ürün Q026 havuzunda yok (hiçbir yöntem getirmedi, sonda kuralı ilgili saymadı) → sorgu ölçümden dışarıda kaldı; bu **gizlenmiş bir hata** (bkz. §6 madde 1) |
| **3d printer nozzle** | Metin 1; 0,1; 0,61 · Anlamsal 3; 0,2; 0,92 · Hibrit 1; 0,1; 0,61 | Katalogda nozul yok (`n_strict=0`); EN'de üç yöntem de nozul contasını (etiket 1, part) döndürüyor. TR `3d yazıcı nozul`: aynı P ve nDCG sayıları, **ama hibritin tek sonucu başka bir ürün**: PLA filament (etiket 1, kısmen) — conta değil | KK + SN (TR) | [D] TR'de `queryWantsAccessory` = false ve metin 0 sonuç; koruma contayı (benzerlik 0,452) anlamsal adaylardan çıkarıyor; sayıların eşit çıkması tesadüf (iki ürün de etiket 1) |
| **drone with camera** | Metin 1; 0; 0,00 · Anlamsal 3; 0; 0,00 · Hibrit 2; 0; 0,00 | İlgili ürün yok (drone motoru etiket 1, part). Hibrit güvenlik kamerası ve telefon pil kapağı döndürüyor (ikisi 0). TR `kameralı drone`: üç yöntem drone motoru (1) → nDCG 1,00 | **ÜT** + KK | [D] `requiredTypePattern("drone with camera")` türü `camera` çıkarıyor; TR sorguda tür `drone` — iki dilde farklı davranış |
| **cat food** | Metin 0; 0; 0,00 · Anlamsal 50; 0,1; 0,50 · Hibrit 2; 0; **0,00** | Katalogda 1 doğrudan ilgili kedi maması (etiket 2): anlamsal 3. sırada (0,282), **hibrit onu kapı altında eliyor** ve yerine kaka poşeti (0) ve talaş (0) koyuyor. TR `kedi maması`: hibrit 3 sonuç, nDCG 0,63 (mama 2. sırada) | **EB** + **HE** | [D] benzerlik 0,282 < 0,30; poşet 0,315 ve talaş 0,309 kapıyı geçiyor ("kedi/evcil hayvan" bağlamı); metin yolu 0 sonuç (başlık TR, sorgu EN) |

Genel çıkarımlar (etiketli veriye göre): (1) aynı kavram iki dilde farklı sonuç veriyor ([D] `dizüstü bilgisayar pili`/`laptop battery`, `drone with camera`/`kameralı drone`, `cat food`/`kedi maması`); (2) hibrit,
metinin 0 sonuç verdiği 8 sorguda 0'ı kırıyor ama bunların bir kısmında yanlış sonuç getiriyor (`kulaklık pedi`, `cat food`) — "yanlış sonuç, sonuçsuzluktan kötü olabilir" kullanıcı etkisi;
(3) katalogda ilgili ürün olmayan sorgularda (`laptop keyboard`, `drone with camera`) ilgisiz sonuç dönüyor; yalnız `yoga mat` doğru biçimde 0 döndü.

## 6. Ölçüm sınırlamaları
1. **Havuz boşluğu:** `gider hortumu` için ilgili ürün katalogda var ama havuzda yok; sorgu `no_relevant` sayılıp ortalamadan çıktı. Bu, üç yöntemin de başarısız olduğu bir sorguyu **gizler**; sıfır sonuç oranı yine doğru (hibrit 0). Çözüm önerisi: Q026 için bu ürünü etiketleme havuzuna eklemek ve etiketlemek (bu görevde etiket eklenmedi).
2. Referans etiketler tek kaynaklı; ilgililikte A/B ayrımı sıfır, tür ve sorgu hedefinde 29 + 4 çözülmemiş kayıt var.
3. Küçük örnek (200 ürün, 38 sorgu, 14 sorguda Recall); P@10'un mutlak değeri düşük, karşılaştırma yönü önemlidir.
4. 12 sorguda yalnız "kısmen ilgili" ürün var; sıkı ilgililikle yalnız 23 sorgu ölçülür (§4.3).
5. Sorgu bazında istatistiksel anlamlılık hesaplanmadı.

## 7. 10–20 bin ürünlük pilot öncesi öncelikli sorunlar (Görev 6; yalnız karar desteği, kod değişmedi)

| # | Sorun | Teknik neden | Kanıt | Kullanıcıya etkisi | Önerilen çözüm | Doğrulama |
|---|---|---|---|---|---|---|
| 1 | **Parça/aksesuar isteyen sorguların tanınmaması ve TR/EN tutarsızlığı** | `queryWantsAccessory` TR `pili/pedi/nozul` için `false`; hibritte `looksLikeAccessory` doğru ürünü eliyor; SQL başlık dışlama deseni `earpad/replacement` | `dizüstü bilgisayar pili` hibrit nDCG 0,61 (anlamsal 1,00); `kulaklık pedi` hibrit 0,15; ped ürünleri hiçbir yöntemde yok | Yedek parça arayan kullanıcı doğru ürünü göremez, bazen ilgisiz tek sonuç görür | Parça/aksesuar sözcük listesi TR+EN eşleştirilmiş; sorgu "parça mı" niyetiyle SQL dışlama ve hibrit korumasını aç/kapa | `eval-plan-pilot2` kalibrasyon kümesinde 8 parça ailesi, TR/EN hibrit nDCG farkı ≤ ε; yeni 8 doğrulama sorgusunda tek ölçüm |
| 2 | **TR→EN embedding benzerliği zayıf** | Sorgu–başlık dil farkı; bazı TR sözcüklerde ürünle benzerlik ~0 | `gider hortumu`↔gider hortumu ürünü 0,028 (99.); TR ort. en iyi benzerlik 0,408 vs EN 0,461; TR'de 2 sorgu kapı altı | TR kullanıcı bazı ürünleri hiç göremez (yok gibi görünür) | Sorgu çevirisi/zenginleştirmesi (mevcut `/ara` Gemini sorgu yorumunun ürettiği normalize sorgu, kural 1 kapsamında) ya da sorgu vektörünü TR+EN birleştirme; yeni embedding üretmeden önce kalibrasyonda denenir | TR sorguların EN eş değerine göre benzerlik oranı ve nDCG farkı; doğrulama kümesinde TR/EN nDCG farkı |
| 3 | **Hibrit kapı: anlamsal Recall kaybı** | Sabit 0,30 / 0,12 eşiği; kapıdan geçen aday olmadığında ilgisiz metin sonuçları indirilmiyor | Hibrit vs anlamsal nDCG 1 iyi / 18 kötü; Recall 0,51 vs 0,83; `cat food` ilgili ürün 0,282'de; `laptop keyboard` ilgisiz sonuç | Hem eksik sonuç hem ilgisiz doldurma | Eşik/fark taraması **yalnız kalibrasyon kümesinde**, dil bazlı ve sorgu uzunluğuna duyarlı alternatifler; doğrulama bir kez | Kalibrasyonda nDCG/ilgisiz oranı Pareto; doğrulamada tek ölçüm |
| 4 | **Ürün türü çıkarımı hatalı** | Edatlı öbeklerde son isim ("with camera") baş isim alınıyor; dil başına farklı | `drone with camera` → `camera`, `kameralı drone` → `drone`; hibrit güvenlik kamerası döndürüyor | Yanlış ürün türü, alakasız sonuç | Baş isim çıkarımına edat öbeği kuralı; her iki dilde aynı türe eşleme testi | `tests` çift dilli tür eşleme tablosu; 12 uzun sorgu |
| 5 | **Anahtar sözcük doldurulmuş başlıklar** | Başlıklar farklı ürün sözcüklerini içeriyor; embedding aksesuar/ana ayrımını bulanıklaştırıyor | `erkek pantolon` hibritte ilk sonuç kemer (benzerlik en yüksek) | Ana ürün aranırken aksesuar üstte | Başlık normalizasyonu/temizleme (kaynak katmanı) veya embedding metnine kategori/tür sinyali; tür kapısı | Aksesuar–ana karışması metriği (insan etiketli `result_type`) |
| 6 | **Katalogda olmayan ürün için ilgisiz sonuç** | Metin yolu tek sözcük örtüşmesi; kabul edilen anlamsal aday yoksa metin sonucu indirilmiyor | `laptop keyboard`, `drone with camera`: yalnız ilgisiz/kısmi sonuç | Kullanıcı "var" sanır; güven kaybı | Düşük benzerlikli ve tek sözcük örtüşmeli metin sonucunu sınırlayan politika (ürün kararı) | `may_be_absent` sorgularında yanlış-pozitif oranı |
| 7 | **Ölçüm: gerçek bağımsız insan etiketi yok, havuz boşlukları** | A/B aynı kaynaktan; havuz yalnız yöntemlerin ilk-10'u + kural sondaları | A=B 240/240; `gider hortumu` havuzda yok; kural etiketi referansla %67,5 uyumlu | Kalite tahminleri güvenilir değil | İki gerçekten bağımsız kişi, kural-bağımsız sondalar (rastgele + tür bazlı); havuza yöntemlerin ilk-20'si | Cohen/ağırlıklı kappa ≥ önceden belirlenen eşik; havuz kapsama oranı |
| 8 | **Yetişkin içerik politikası** (ayrı görev) | Katalogda açık içerikli başlık var (2), arama yolunda süzgeç incelenmedi | Önceki rapor §6 | Kullanıcıya uygunsuz sonuç riski | Üretim yolunda süzgeç kararı | Bu görevin dışında |

Önerilen sıra: **7 → 1 → 3 → 2 → 4 → 5 → 6** (ölçüm güvenilirliği olmadan diğer değişiklikler kanıtlanamaz; 1 ve 3 en net ve düşük riskli kayıplardır; 2 yeni model/çeviri maliyeti içerebilir).

## 8. Üretilen çıktılar
- `docs/semantic-pilot/human-eval/reference_ai_assisted_user_reviewed/` (referans veri + `README.md` köken + `adjudication_open.csv` + `score_result.json`).
- `docs/semantic-pilot/p200_reference_query_table.md` (35+3 sorgunun durum ve metrik tablosu).
- Kod: `human_eval.py` küçük ölçüm düzeltmesi (sıfır sonuçlu yöntem için nDCG=0; puanlama n'leri), test `test_zero_result_method_gets_zero_ndcg_not_excluded`.
