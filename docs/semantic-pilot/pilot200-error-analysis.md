# 200 ürünlük pilot: hata analizi ve ölçüm güvenilirliği (karar 0170)

Kapsam: mevcut 38 sorgunun (19 kavram × TR/EN) metin, yalnız anlamsal ve hibrit ham sonuçları. Yeni API çağrısı, üretim erişimi,
embedding yeniden üretimi, algoritma/eşik değişikliği **yok**. Tüm veri: `semantic-review/pilot200/` (ham çıktı) ve
`docs/semantic-pilot/human-eval/` (havuz). Sorgu bazlı tam tablo: [`p200_query_table.md`](p200_query_table.md).

Etiket dili: **[G]** gözlem (çıktıda görülen), **[D]** doğrulanmış (kodu/veriyi yeniden çalıştırarak kanıtlandı), **[H]** hipotez (kanıtsız neden).
Tüm "ilgili/ilgisiz" ifadeleri **kural tabanlı otomatik etiketlere** dayanır; insan doğrulaması yoktur ve aşağıda bu etiketlerin kendisinin
güvenilmez olduğu gösterilir. **Arama doğruluğu kanıtlanmış değildir.**

## 0. En önemli bulgu: ölçüm yönteminin kendisi güvenilmez

**[D]** Kural etiketleyici (başlık düzenli ifadeleri) gerçek kataloglarda sık yanılıyor. `semantic_pilot.pilot200_analysis` çıktısında, kural-ilgili (2) sayılan ve
kuşkulu olan ürünler (kimlikler yerel pilot veritabanına göre):

| Sorgu | Kural "doğrudan ilgili" dedi | Ne olduğu (başlıktan) |
|---|---|---|
| men pants / erkek pantolon | 63, 72, 81 (kemer), 60 (kadın kemeri), 61 (kimono pelerin), 65 (tişört) | Başlıklar "jeans/pants" sözcüğünü anahtar sözcük olarak içeriyor; ürün kemer/üst giyim |
| women dress / kadın elbise | 58 (elbise dikmek için kumaş), 60 (kemer) | kumaş/kemer |
| car led light / araç led ışık | 62 (Hawaii gömleği), 103 (tırnak törpüsü), 8 (araç şarjı) | "Car"/"Light" sözcüğü geçiyor |
| oyuncak araba | 16 (araç/laptop için çıkartma seti) | "for Car" |
| bluetooth speaker / hoparlör | 43 (18650 pil), 33 (oto hoparlör kapağı) | hoparlör sözcüğü geçiyor |
| drain hose | gerçek bir gider hortumu başlığı **aksesuar (1)** etiketlendi | "hose ... for Kitchen" kalıbı aksesuar kuralını tetikledi |

Sonuç **[D]**: (a) kural etiketli P@10/nDCG sayıları hem şişebilir hem düşebilir, (b) önceki raporun hibrit-metin-anlamsal karşılaştırması **yön gösterir, kanıt değildir**,
(c) kapıda "elenen ilgili ürün" sayılarının önemli kısmı aslında kural yanlış pozitifidir (örn. Hawaii gömleği benzerliği −0,06 ile elenmiştir; doğru karardır).
İnsan etiketleri gelmeden hiçbir yöntem "daha doğru" ilan edilmez.

## 1. Üç yöntemin ham sonuçları (38 sorgu)

**[G]** Sonuç sayıları (ort. sorgu başına): metin 1,5 · yalnız anlamsal (kapısız, güvenlikli SQL adayları) 15,4 · hibrit 1,9.
Sıfır sonuç oranı: metin 0,29 (11/38) · anlamsal 0,05 (2/38) · hibrit 0,08 (3/38). Hibritte sıfır sonuç dönen 3 sorgu: `yoga mat`, `yoga matı`, `gider hortumu`.
Kural-ilgili ürün varken hibritin hiç sonuç döndürmediği sorgu **yok**; metin yolunda **8** sorgu böyle (aşağıda).

**[G]** Dil (19 eş değer sorgu çifti): ortalama en iyi benzerlik EN 0,461, TR 0,408; TR, 14/19 çiftte EN'den düşük; 0,30 altı en iyi benzerlik: EN 0, TR 2 (`gider hortumu` 0,27; `yoga matı` 0,27).
Metin yolu sıfır sonuç: TR sorguda 8, EN sorguda 3. Hibrit sonuç sayısı çiftlerin 10'unda EN ve TR için farklı.

### 1.1 Anlamsal/hibrit, metinden daha iyi göründüğü yerler (kural etiketli, **[G]**)
- TR sorgu + EN başlık (metin 0 sonuç; hibrit anlamlı sonuç): `erkek pantolon` (metin 0 / hibrit 6, ama bkz. §0: üstteki ürün kemer), `araç led ışık` (0 / 3; ilgili 2), `dizüstü bilgisayar pili` (0 / 2), `oyuncak araba` (0 / 1; ilgili), `telefon kılıfı` (metin 12 sonuç, bunların 8'i alakasız; hibrit 2 sonuç, ikisi de telefon kılıfı/kapağı).
- EN sorgu + TR başlık: `baby diaper` metin 0, anlamsal/hibrit "Prima Külot Bebek Bezi" (benzerlik 0,37) — çapraz dil çalışıyor.
- Metin sözcük örtüşmesi: `laptop keyboard` → müzik klavyesi standı ve fare altlığı (benzerlikleri 0,22/0,21) **[G]**; hibrit de aynı iki ürünü bırakıyor **[D]**: anlamsal kapıdan geçen aday olmadığı için metin sonuçları indirilmiyor (`fusion.ts`: indirme yalnız kabul edilmiş anlamsal aday varsa uygulanır); yani "anlamsal bilgi var ama kullanılmıyor" durumu.

### 1.2 Anlamsal/hibrit, metinden kötü ya da eşit olduğu yerler (**[G]**, nedenleri §3)
- `3d yazıcı nozul` (TR): metin doğru ürünü (117, nozul contası, kural-ilgili) buluyor; hibrit onu **eledi** ve yerine PLA filament döndürdü. EN eş değeri doğru. **[D]** neden: aksesuar koruması (bkz. §3).
- `dizüstü bilgisayar pili` (TR): en iyi anlamsal ürün (144, benzerlik 0,50) hibritte yok; 2. ürün ve alakasız bir PC kasası var. **[D]** neden: aksesuar koruması (`looksLikeAccessory` + sorgu "aksesuar istemiyor" kararı).
- `kulaklık pedi` (TR): metin 0 sonuç; hibrit 1 sonuç ve o **alakasız** (kulaklık temizleme kalemi); iki gerçek ped ürünü (9, 45) anlamsal aday listesine bile girmedi. **[D]** neden: SQL başlık dışlama deseni (`earpad`, `cushion`, `replacement`… aksesuar sözcüklerini dışlıyor).
- `drone with camera`: hibrit güvenlik kamerası döndürüyor; drone parçası (167) tür deseniyle elendi. **[D]** neden: tür deseni sorgudan "camera" (son isim öbeği) çıkarıyor.
- `cat food` / `kedi maması`: hibrit en üstte "Kedi Köpek Kaka Poşeti"ni getiriyor (benzerlik 0,315/0,319); gerçek kedi maması (200) EN sorguda 0,282 ile kapı altında elendi, TR sorguda 2. sırada kaldı.
- `kadın elbise`/`women dress`: kural-ilgili sayılan kemer/kumaş zaten yanlış pozitif (§0); hibrit sonuç sayısı azalıyor (1 vs metin 4). Anlamlı bir "metin daha iyi" kanıtı değil.

### 1.3 Kapı davranışı
**[D]** Hibrit kapısı (min 0,30, en iyiye göre en çok 0,12 fark) kural-ilgili olup hibritte olmayan 30 (sorgu, ürün) çiftini elemiştir. Nedenleri (`pilot200_analysis`, kod yeniden çalıştırılarak):

| Neden | Çift sayısı | Yorum |
|---|---|---|
| benzerlik < 0,30 (`BELOW_GATE_MIN`) | 15 | çoğu §0'daki kural yanlış pozitifi (gömlek, tırnak törpüsü, pil…); tek kesin gerçek kayıp: **200 kedi maması 0,282** |
| en iyiden > 0,12 geride (`BELOW_GATE_GAP`) | 6 | çoğu kemer/parça (kural FP); gerçek: kulaklık için 46 (akustik tüp parçası), araç için 8/82 (şarj/ışık vidası) tartışmalı |
| tür deseni (`TYPE_PATTERN_GUARD`) | 5 | 58/60 (kumaş/kemer — doğru eleme), 16 (çıkartma — doğru), 167 (drone parçası — tür çıkarımı hatası) |
| aksesuar koruması (`ACCESSORY_GUARD_FILTER`) | 2 | 144 pil, 117 nozul — **gerçek hata** |
| anlamsal listede yok (`NOT_IN_SEMANTIC_LIST`) | 2 | 9, 45 kulaklık pedi — SQL dışlama deseni, **gerçek hata** |

Küçük aday kümesi etkisi **[H]**: 200 ürünlü havuzda anlamsal liste çok kısa olduğundan kapı "en iyiye göre" göreli de olsa tek bir yüksek benzerlikli yanlış ürün ilgili ürünleri
gap kuralıyla eleyebilir; 10–20 bin üründe etkisi ölçülmeli.

## 2. Hata sınıfları (kural etiketli sayılar, ilk 10 sonuç, 38 sorgu)

| Sınıf | Metin | Anlamsal (kapısız) | Hibrit |
|---|---|---|---|
| Aksesuar/yedek parça ana ürün yerine (`ACC_PART_AS_MAIN`) | 4 | 23 | 3 |
| Farklı tür, yüksek benzerlik (`SEMANTIC_TYPE_CONFUSION`) | — | 10 | 9 |
| Kapı altı benzerlikle listede (`SEM_RAW_BELOW_GATE` / hibritte `FUSION_PASSED_BELOW_GATE`) | — | 123 | 9 |
| Sözcük örtüşmesi, anlamsız (`TEXT_LEXICAL_OVERLAP`) | 14 | — | — |
(Aksesuar sayıları yalnız aksesuar istemeyen sorgularda anlamlıdır; etiket kuralları §0'daki hatalara tabidir.)

1. **Aksesuar/parça önerisi.** [G] Kapısız anlamsal listede 23, hibritte 3, metinde 4. **Olası nedenler:** (a) [D] katalogda aksesuarlar ana ürünlerden çok fazladır ve başlıklar ana ürün adını aksesuar başlığında tekrar eder ("… for Laptop"), embedding ikisini yakın gösterir; (b) [H] metin modeli başlıktaki "for X" ifadesini yeterince ayırt etmez; (c) [D] hibritteki aksesuar koruması bunu azaltıyor ama **çifte kenarlıdır**: parça/aksesuar *isteyen* ancak lexicon'da olmayan sorgularda (`pili`, `pedi`, `nozul`) doğru ürünü eler (§3).
2. **Anlamsal benzerlikle farklı tür (10+9).** [G] Örnek: `kedi maması` → kaka poşeti; `drone with camera` → güvenlik kamerası. [H] Embedding "kedi" + "evcil hayvan" bağlamını yakalıyor, ürün işlevini (yem vs. poşet) başlık dilinden ayıramıyor; TR/EN karışık başlıkta ("Kedi Köpek Kaka Poşeti") daha belirgin olabilir.
3. **TR sorgunun yorumlanması.** [G] TR sorgu benzerliği ortalama 0,05 düşük; 2 TR sorgu kapı altında. [D] TR sorguda metin yolu sıfır sonuç verir (8/19 TR, 3/19 EN). [H] Sorgu ile başlık arasındaki dil farkı mutlak benzerliği düşürür; bu yüzden sabit 0,30 eşiği TR'ye daha sert uygulanır.
4. **EN başlık–TR sorgu eşleşmemesi.** [G] Metin yolunda yaşanıyor; hibritte anlamsal yol çoğunu kurtarıyor (`araç led ışık`, `dizüstü bilgisayar pili`), kurtaramadıkları §1.2'dedir.
5. **İlgisiz üst sıra.** [G] Metinde `laptop keyboard`, `telefon kılıfı`; hibritte `kulaklık pedi`, `cat food`, `drone with camera`.
6. **Sıfır sonuç + ilgili ürün var.** [D] Hibritte yok; metinde 8 (TR sorgu): `kulaklık pedi, dizüstü bilgisayar pili, erkek pantolon, araç led ışık, oyuncak araba`; EN: `baby diaper, cat food`/`kedi maması`.
7. **Anlamsal-yalnız yanlış pozitif.** [G] Kapısız anlamsal liste ilgili ürün olmayan sorgularda 27–50 sonuç döndürüyor (`baby diaper` 50, `drain hose` 50); hibrit kapısı bunu 1–2'ye indiriyor. Gerçekte yok (`yoga mat`) olan sorgularda üç yöntem de 0 döndürüyor [G]. Ancak `laptop keyboard` (örnekte yok) için metin ve hibrit ilgisiz 2 sonuç döndürüyor [G].

## 3. Yöntem bazında güçlü/zayıf yönler

| Yöntem | Güçlü [G] | Zayıf [G]/[D] |
|---|---|---|
| Metin | EN başlıkta tam ifade eşleşmesinde güvenilir; `3d yazıcı nozul` doğru; vektörsüz ürünü bulur | TR→EN eşleşmez (8 sıfır); tek sözcük örtüşmesinde alakasız sonuç (`laptop keyboard`); `telefon kılıfı` 12 sonuçtan 8'i alakasız |
| Yalnız anlamsal | Çapraz dil (EN→TR başlık, TR→EN başlık); en yüksek kapsama; sıfır sonuç azdır | Kapısız: ilgisiz doldurur (50 sonuç); aksesuar/ana karışıklığı; tür karışıklığı |
| Hibrit | Düşük ilgisiz oranı, anlamlı kısa liste, çapraz dil kurtarma | Korumalar parça/aksesuar sorgularında ilgili ürünü eliyor (3 doğrulanmış sorgu); tür çıkarımı hataları; sabit eşik TR'ye sert |

### 3.1 Doğrulanmış kod kaynaklı hatalar (yalnız bulgu; **düzeltme yapılmadı**)
1. **[D] `dizüstü bilgisayar pili` ve `3d yazıcı nozul`** (`hybrid-provider.ts`): sorgu `queryWantsAccessory(...)` ile "aksesuar istemiyor" sayılınca (guard açık) anlamsal adaylardan `looksLikeAccessory(title)` olanlar çıkarılır; sorgunun kendisi bir parça arıyorken (pil, nozul) doğru ürün parça olduğu için elenir. `queryWantsAccessory` TR `dizüstü bilgisayar pili` için `false`, EN `laptop battery` için `true` döner → aynı kavram iki dilde farklı davranır (EN'de ürün kalır). `3d yazıcı nozul` ve `3d printer nozzle` ikisi de `false` döner; EN'de ürünü **metin yolu** getirdiği için kalır (metin sonucu yalnız ×0,3 indirilir, silinmez), TR'de metin 0 sonuç verdiğinden tek kaynak yalnız-anlamsal yol olur ve koruma onu eler.
2. **[D] `kulaklık pedi`** (`product-title-guard.ts`; `queryWantsAccessory` burada `true`, yani hibrit koruması sebep değil): SQL başlık dışlama deseni sorgudan bağımsız olarak kulaklık sorgusu için `earpad`, `cushion`, `replacement` sözcüklerini dışlıyor; iki gerçek ped ürünü anlamsal SQL aday listesine bile girmiyor (benzerlik 0,486 ile 1. sırada olmasına rağmen).
3. **[D] `drone with camera`** (`product-type.ts`): "with camera" ifadesinden tür "camera" çıkarılıyor; drone ürünü (parça) tür deseniyle eleniyor, güvenlik kamerası geçiyor.
4. **[D] Kapı eşiği:** `cat food` gerçek ürünü 0,282 ile eşik altında; `gider hortumu` en iyi 0,27 ile hiç sonuç yok (ilgili ürün kural etiketinde aksesuar sayıldığı için kural-ilgili boş; asıl ürün "2Pcs 80cm Drain Pipe Hose" EN sorguda 0,55 ile bulundu, TR sorgunun benzerliği ölçülmedi).

## 4. Soruların yanıtları

1. **Anlamsal hangi sorgularda metinden iyi?** [G] Metnin sıfır/anlamsız sonuç verdiği TR sorgular (`araç led ışık`, `erkek pantolon` — ancak §0), `telefon kılıfı`, EN→TR başlık (`baby diaper`). İnsan etiketi yok → [H].
2. **Hangi sorgularda daha kötü?** [G]/[D] `3d yazıcı nozul` TR, `kulaklık pedi` TR, `dizüstü bilgisayar pili` TR (korumalar), `drone with camera` (tür çıkarımı), `cat food` (hem kapı hem embedding).
3. **Aksesuar teknik nedenleri:** §2 madde 1. Katalog yapısı (aksesuar başlıkları ana ürün adını tekrar eder) [D]; embedding'in "for X" ayrımı [H]; mevcut korumanın çift kenarlı olması [D].
4. **Eşikler neden ilgiliyi eliyor:** §1.3 — gerçek kayıplar azdır (kedi maması 0,282; TR çapraz dil düşük mutlak benzerlik [H]); kural yanlış pozitiflerinin çoğu doğru elenmiş. Tek eşik iki dil için ayarlı değil [G: TR ort. −0,05].
5. **Hatalar nereden?** Embedding kaynaklı: tür karışıklığı (kedi maması→poşet), TR benzerlik düşüklüğü [G/H]. **Filtre/sıralama kaynaklı** (doğrulanmış): aksesuar koruması, SQL dışlama deseni, tür çıkarımı, kapı eşiği. **Veri kalitesi kaynaklı** [G]: anahtar sözcük doldurulmuş başlıklar ("Belt … Jeans … Dresses"), karışık dil başlıkları, aksesuar bolluğu; ayrıca **etiket kuralı** kaynaklı ölçüm hatası (§0).
6. **Dil çeşitliliği:** [G] 200 üründe TR başlık yalnız ≈ 20 (üretimde %0,016). TR sorgu→EN başlık eşleşmesi metinde bozuk, hibritte kısmen kurtulur; EN sorgu→TR başlık çalışıyor (tek örnek). Karışık dil başlıklar ("Kedi Köpek Kaka Poşeti") yanlış tür eşleşmesini artırıyor olabilir [H].
7. **Katalog büyüdüğünde beklenen [H]:** (a) aksesuar/yedek parça yoğunluğu → aksesuar-ana karışıklığı artar; (b) benzer başlıklı ürün sayısı → kapının "en iyiye göre fark" kuralı daha çok ürünü içeri alır, ilgisiz oranı artar; (c) `maxSemanticOnly` 48 sınırı kısa sorgularda ilgili ürünleri keser; (d) HNSW ANN + SQL filtre (aksesuar/tür) → filtre sonrası boş/az sonuç; (e) anahtar sözcük doldurulmuş başlıklar çoğalır; (f) TR başlık oranı çok düşük kalacağı için TR sorgunun metin yolu hep zayıf kalır. Hiçbiri 200 üründe ölçülemez.

## 5. Kapsam etkisi: 38 sorgudan yalnız 12'sinin ortalamaya girmesi

Önceki rapor 12 sorguyu (≥3 kural-ilgili ürün) ortalamaya aldı, 26'yı dışarıda bıraktı. **[G]** (otomatik etiket, `human_eval auto-impact --strict-only --min-query-relevant 3`):

| Yöntem | P@10, yalnız 12 sorgu | Dışarıda kalan 26 sorguda sıfır sonuç | Dışarıdaki 26'da ort. sonuç |
|---|---|---|---|
| Metin | 0,17 | 9/26 | 1,2 |
| Yalnız anlamsal | 0,37 | 2/26 | 17,7 |
| Hibrit | 0,26 | 3/26 | 1,5 |

Çıkarım: (a) dışarıda bırakma P@10'u **yapay olarak yükseltir**: bu sorgularda ilgili ürün olmadığı için P tanımsızdır, ama tüm 38 sorguya yayılırsa (ilgili ürünü yokken P=0 varsayımıyla, adil değil) ortalama 0,05/0,12/0,08 olurdu; (b) 26 sorgunun 20'si "az ilgili (1–2)", yalnız 4'ü "hiç ilgili yok", 2'sinde havuz yok — yani çoğu "yok" değil **"az"**, ölçüm gürültülü; (c) dışarıda kalan sorgular yöntemleri en çok ayıran davranışı gösterir: kapısız anlamsal ilgisizi doldurur (ort. 17,7 sonuç), hibrit/metin kısadır; bu bilgi P@10 ortalamasından görünmez; (d) önceki raporun hibrit vs yalnız anlamsal sıralaması (anlamsal P@10 0,37 > hibrit 0,26) kısmen **kısa liste cezasıdır** (sabit payda 10); `P@ret` (dönen sonuç başına) hibritte 0,89, anlamsalda 0,62 çıkıyor (otomatik etiket) — yani ikisinin sıralaması metrik seçimine bağlı.
Yeni ölçüm kodu bu sorguları durumuyla ayrı tutar (`few_relevant`, `no_relevant`, `no_labels`, `incomplete`) ve her metriğin yanında kaç sorgudan hesaplandığını yazar.

**Tutarlılık notu (düzeltme):** Bu bölümdeki tablo ile `0170` belgesindeki 12 sorgu tablosu aynı P@10 sayılarını verir (0,17/0,37/0,26), ama başka iki sayı farklı tanımlara dayanır ve karıştırılmamalıdır: (a) nDCG@10 — `0170` (katalog-ideal, `pilot200_eval`) 0,47/0,78/0,62; havuz-ideal (`human_eval`, otomatik etiket) 0,62/0,76/0,69; (b) ilgisiz@10 — `0170` 0,02/0,11/0,04 (yalnız kural-0), `auto-impact --strict-only` 0,14/0,38/0,11 (strict modda kural-1 aksesuar da "ilgisiz" sayılır). Sonuç/sorgu da popülasyona bağlıdır: 12 değerlendirilen sorguda 2,0/10,4/2,9, 38 sorguda 1,5/15,4/1,9. İnsan etiketleriyle tek tanım (havuz-ideal nDCG, ilgisiz = etiket 0) kullanılacaktır.

## 6. Yetişkin içerik filtresi açığı (yalnız rapor)
- Pilot seçicideki yetişkin süzgeci ilk çalıştırmada etkisizdi (kaçış karakteri hatası; düzeltildi, test var). **[D]** 200 ürünlük kümede **2 açık içerikli** ürün (katalog kimlikleri 163, 165) ve 1 hafif ifadeli giyim ürünü (74, "sexy" sözcüğü) kaldı (içerik rapora taşınmadı. Kontrol (geniş anahtar sözcük listesi, yalnız eşleşme sayısı): etiketleme havuzu ve paketlerinde açık içerik **yok**; "Adult" sözcüğü geçen 70 ve 103 yaş grubu anlamında zararsız. Katalog tarama listesinden 163 ve 165 çıkarıldı); **[D]** bu ürünler hiçbir yöntemin ilk 10'unda ve insan etiketleme havuzunda **yok** (0 eşleşme).
- Üretim arama yolunda (hibrit/metin) yetişkin içerik filtresi bu görevde incelenmedi; katalogda bu tür ürünlerin varlığı üretim örneğinde gözlendi **[G]**. Karar/uygulama bu görevin dışında. Ürün kümesi seçicisi, değerlendirme CSV'leri ve raporlara ham yetişkin başlık taşınmadı (yalnız sayı).

## 7. Henüz doğrulanmamış bulgular (özet)
- Tüm doğruluk sayıları kural etiketlidir ve §0'a göre şişebilir/azalabilir; insan etiketi 0/240 satır.
- "Embedding tür karışıklığı" nedenleri (kedi maması→poşet, TR→EN düşük benzerlik) **hipotezdir**; embedding yeniden üretilmeden, farklı model/metin şablonuyla karşılaştırılmadan kanıtlanamaz.
- "Kapı küçük havuzda sert/gevşek davranır" ve "katalog büyüyünce şu sorunlar artar" **hipotezdir**.
- TR sorgu benzerliğinin düşük olması: 19 çift, tek model/şablon; istatistiksel güç düşük.
- Gerçek ürün 200 ile sınırlı; kapı eşikleri 15 bin ürün için ayarlanmıştı.

## 8. Sonraki aşamada düzeltilmesi gereken sorunlar (öncelik sırası, yalnız öneri)
1. **Ölçüm güvenilirliği:** insan etiketi (0/240 → en az iki değerlendirmeci), kural etiketlerin kullanımını bırakma; bunun olmadan bundan sonraki algoritma değişikliği ölçülemez.
2. **Parça/aksesuar isteyen sorguların tanınması (TR/EN tutarlılığı):** `pili`, `pedi`, `nozul`, `filtre` gibi; aksesuar koruması ve SQL dışlama deseni bu sorgularda ilgili ürünü eliyor (3 doğrulanmış sorgu, 4 ürün).
3. **Tür çıkarımı:** "with camera" gibi edatlı öbeklerde baş ismin yanlış seçimi (`drone with camera`).
4. **Kapı eşiği dil duyarlılığı:** TR sorguda ortalama −0,05 benzerlik; tek eşik için dil bazlı ya da sorgu-uzunluğu bazlı doğrulama (yalnız ölçüm; ayar bağımsız kümede).
5. **Embedding kaynaklı tür karışıklığı:** `cat food` gibi; metin şablonunda kategori/tür sinyali ağırlığı, karışık dil başlık temizliği (hipotez test edilmeli).
6. **Veri kalitesi:** anahtar sözcük doldurulmuş başlıklar, çok dilli başlıklar; seçicideki içerik süzgeci.
7. **Küçük havuz sınırı:** `maxSemanticOnly` ve "en iyiye göre fark" kuralının 10–20 bin üründe ölçümü.
8. Üretim hattında yetişkin içerik politikası (ayrı görev).

## 9. Üretilen/değiştirilen dosyalar
Bkz. teslimat raporu; kod: `services/ingest/semantic_pilot/{pilot200_analysis,human_eval,eval_plan}.py`, `packages/core/scripts/semantic-pilot-guards.ts`, testler `tests/test_{human_eval,eval_plan}.py`.
