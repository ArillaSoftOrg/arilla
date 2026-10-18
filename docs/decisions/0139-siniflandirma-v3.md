# 0139 — Sınıflandırma v3: taksonomi genişlemesi, kanıt önceliği, marka nedenleri, ölçüm araçları

**Tarih:** 19 Ekim 2026
**Durum:** Önerildi (PR). Birleştirme ve üretim dağıtımı kullanıcı onayına bağlıdır; üretimde hiçbir
sınıflandırma çalıştırılmadı.
**İlişkili:** 0133 (sınıflandırma), 0134 (WAL), 0138 (v2: çelişki incelemesi)

## 1. Teknik denetim (Faz 1)

| Konu | Bulgu |
| --- | --- |
| Kategori ağacı | **Veritabanı tabanlı ve hiyerarşik**: `category(path, parent_id, slug UNIQUE, is_discoverable)`. Kök: 0016; dallar: 0089; bu PR: 0091. Anahtar `path`; ekleme idempotent, mevcut kimlik/slug değişmez. |
| Kurallar | **Kodda** (`classify/taxonomy.py`, `RULES` 176 kural, `LEXICON`): kaynak kategori adı ve başlık aynı kural kümesinden okunur. Yol → `category.id` eşlemesi çalışma başında DB'den. |
| Kaynak eşleme | `category_source_map(merchant_id, path_norm)`: `unmapped/suggested/confirmed/rejected`, `confirmed` yönetici onayı (güven 100, kural önerisi ezmez). Kural önerisi her koşuda `guess_source` ile üretilir. |
| Sahiplik | `product_classification.wrote_*` + ürün değeri hâlâ aynı → yalnızca bu işin yazdığı değer değişir; yönetici/besleme değeri korunur (0133/0138). **Bozulmadı.** |
| Marka | `brand(name_norm)`; çıkarım `classify/brands.py`: yapılandırılmış alan > seçilmiş liste (`KNOWN_BRANDS`) > yok. AliExpress beslemesinde marka alanı **yok** (1,7 M kayıtta 0). |
| Yönetim | `/yonetim/katalog/siniflandirma` ve ürün paneli (#193) `product_classification.detail` kodlarını etiketler; **yeni detay kodu eklenmedi**. |
| Arama/sohbet | `lexicon(kind='category')` kategori yüzeyi **katı filtre**; yüzeyler `classify lexicon --apply` ile, kapsam yeterliyken yazılır. TS tarafı fixture ile eşitlenir (Python testi doğrular). |

**Ağacı yeniden tasarlamak gerekli mi? Hayır.** Mevcut ağaç doğru yapıda; eksik olan *yaprak* dallar.
Kanıt (1,7 M gerçek AliExpress teklifi, başlık anahtar kelimeleri): makine/vana/pompa/sensör/PLC ~%10,
elektrik tesisatı %2,3, ölçü-test aletleri %1,6, elektronik bileşen %1,2, adaptör/güç %0,9, batarya
%0,7, mangal/barbekü %0,4 — hiçbirinin dalı yoktu, bu yüzden ürünler ya kategorisiz kalıyor ya da
yanlış bir dala (mutfak, dekorasyon, hırdavat) düşüyordu. Mevcut kimlik ve slug'a dokunulmadı.

## 2. Taksonomi (Faz 2) — migration 0091, yalnızca ekleme

| Yol | Ad | Not |
| --- | --- | --- |
| `elektronik/guc-batarya` (+ `batarya`, `sarj-cihazi`, `adaptor-guc-kaynagi`) | Güç ve Batarya | Telefona özgü şarj `telefon/aksesuar/sarj-kablo`da kalır; genel adaptör/güç kaynağı/batarya burada. |
| `ev-yasam/yapi-market/elektrik-tesisati` | Elektrik Tesisatı | şalter, kontaktör, klemens, sigorta, priz… (`elektronik/bilesen` ayrı: IC, modül, direnç). |
| `ev-yasam/yapi-market/olcum-aletleri` | Ölçü ve Test Aletleri | multimetre, kumpas, ölçüm cihazları (şerit metre `el-aletleri`nde kaldı). |
| `ev-yasam/yapi-market/alet-yedek-parca` | El Aleti Yedek Parça ve Aksesuarları | kömür fırça, rotor, mandren, uç, testere bıçağı. |
| `ev-yasam/yapi-market/endustriyel` | Endüstriyel Ekipman | `is_discoverable=FALSE` (B2B, keşfet akışına girmez). |
| `anne-bebek/bebek-arabasi` (+ `aksesuar`) | Bebek Arabaları | `bebek-bakim` kuralından "stroller" çıkarıldı (kardeş dallar LCA'da çelişiyordu). |
| `oto-bahce/bahce/mangal-barbeku` | Mangal ve Barbekü | |

Tek kaynağa özel değil: kural adları hem İngilizce AliExpress hem Türkçe (HB/Trendyol) yüzeylerini kapsar.
Aşırı ayrıntı yok: 11 düğüm. **Mutfak ekipmanları ve ev/bahçe aksesuarları için yeni dal gerekmedi**
(ölçümde mevcut dallar yetiyor; sorun dal eksikliği değil çelişkiydi).

**Migration ve geri alma.** `0091_category_taxonomy_v3.sql` yalnızca INSERT, yol varsa atlar, ebeveyn
yoksa NOTICE; iki kez uygulandı, aynı sonuç (158 kategori). Geri alma (ürünler bu yollara
bağlanmadan önce):
```sql
DELETE FROM category c WHERE c.path IN (
  'elektronik/guc-batarya/batarya','elektronik/guc-batarya/sarj-cihazi',
  'elektronik/guc-batarya/adaptor-guc-kaynagi','elektronik/guc-batarya',
  'ev-yasam/yapi-market/elektrik-tesisati','ev-yasam/yapi-market/olcum-aletleri',
  'ev-yasam/yapi-market/alet-yedek-parca','ev-yasam/yapi-market/endustriyel',
  'anne-bebek/bebek-arabasi/aksesuar','anne-bebek/bebek-arabasi','oto-bahce/bahce/mangal-barbeku')
  AND NOT EXISTS (SELECT 1 FROM product p WHERE p.category_id = c.id)
  AND NOT EXISTS (SELECT 1 FROM category_source_map m WHERE m.category_id = c.id);
```
Sınıflandırma çalıştıktan sonra geri alma önce `--owned-only` ile ürünlerin kategorisini
temizlemeyi (0138 rehberi) gerektirir.

## 3. Algoritma (Faz 3), kural sürümü 3

v2 kazanımları (çelişki → inceleme, parça kaynağı cihaza eşlenmez, onaylı eşleme önceliği) **korunur**;
`classify_prevented_errors.json` (71 yanlış atama) bunu test eder.

1. **İç içe ifade önceliği** (`categories._covered`): daha uzun, bir başka kuralın ifadesini *içine alan*
   ifade genel olanı eler. "stroller organizer" (bebek arabası aksesuarı) içindeki "organizer"
   (düzenleme) artık bağımsız kanıt değil → bebek arabası aksesuarında gereksiz çelişki biter.
2. **Satıcı çöp kovaları zayıf kaynak** (güven 75): `Measurement & Analysis Instruments`,
   `Electrical Equipment & Supplies`, `Power Tool Parts & Accessories`, `Industrial & Business`.
   Başlık dalı doğrulamadıkça yazılmaz. (İlk denemede güven 88 idi: kahve yazıcısı, motor kaputu,
   kurutma makinesi "ölçü aleti" oluyordu — ölçümle yakalandı, düzeltildi.)
3. **Zayıf kaynak onayı için başlık kanıtının kendisi ≥ 80**: tek bir genel kelime ("hydraulic")
   onaylamaz; genel kelimeler (hydraulic, pneumatic, cnc, plc, encoder, servo) ayrı, düşük güvenli
   kuralda.
4. **Hatalı bir kural denendi ve geri alındı:** "yabancı kanıt destekten güçlüyse çelişki" kuralı
   doğru atamaların çoğunu (takı, dikiş malzemesi, tuvalet masası, BMW parçası) incelemeye düşürdü;
   olduğu gibi bırakıldı: başlık kaynak dalını destekliyorsa ikinci alandan bir kelime kaynağı bozmaz.
5. Yeni dallar için kurallar (batarya/şarj/adaptör ayrımı, elektrik malzemesi/bileşen ayrımı, bebek
   arabası/aksesuarı, alet/alet yedek parçası) ve dışlama listeleri ("battery operated", "case",
   "tester", "phone"…). Binek araç üreticisi adları endüstriyel kuraldan dışlanır ("Peugeot brake
   vacuum pump" oto parçasıdır).

6. **Hata analizi sonrası üç düzeltme** (B1 kümesindeki hatalardan; B2 ile doğrulandı):
   - Zayıf kaynağın iki alt dalı kaynağın *kendi* üst dalında buluşuyorsa (elmas boyama + nakış →
     hobi) onay sayılır (v2 böyle davranıyordu ve doğruydu).
   - Araç parçası kaynağında ("Engines & Engine Parts") başlık yalnızca bileşen (vana/pompa/sensör)
     söylüyor, **binek araç markası geçiyor** ve iş makinesi sözcüğü yoksa kaynak geçerli. Araç
     işareti olmadan geçmez (deniz/tarım motoru pompaları v2'de yanlış oto parçası oluyordu; koruma
     testi bunu yakaladı).
   - `endustriyel` kuralında oto/alet bağlamı dışlanır ("auto parts", "headlight", "brake", "wrench",
     "screwdriver", "chuck").
7. **Denendi ve kaldırıldı:** "zayıf kovada tek güçlü kardeş dalı başlık seçsin" kuralı diş hekimi
   pensesi, kaya matkabı çekici ve sterilize edilebilir matkap gibi önlenmiş hataları geri getirdi
   (`classify_prevented_errors.json` yakaladı). Genel alet sözcükleri bu kovalarda güvenilir kanıt değil.

## 4. Marka (Faz 4)

**Kök nedenler (ölçüldü, 424 bin başlık):** %80,5 başlıkta seçilmiş listede hiçbir ad yok
(`no_known_brand`); %18,8 yalnızca *uyumlu* marka ("for Makita", "compatible with Dyson") —
doğru olarak yazılmaz (`compatible_only`); %0,3 taklidi yaygın marka (`counterfeit_prone`);
%0,2 başlığın ilerisinde (`late_position`); %0,25 marka bulundu. Ölçülen sınır: etiketli 216
satırın ~%5'inde ürünün kendi markası var → bu beslemede kapsama tavanı kabaca %5 (güven aralığı
geniş), v3 ~%0,25'ini bulur; geri kalanı bilinmeyen markadır. Satıcı önekleri (LTT, DSA, AZGIANT…) ve
model kodları **marka sayılmaz**. Kapsamı artırmanın güvenli yolu: yapılandırılmış marka alanı olan
kaynaklar (HB/Trendyol `brand_raw`, öncelikli) ve seçilmiş listeyi *onaylı* eklemelerle büyütmek.

Yapılanlar: `BrandFinding.reason` (boş kalma nedeni, DB'ye yazılmaz; `evaluate` raporlar);
`lead_only` markalar (sanayi markaları yalnızca başlığın ilk iki kelimesinde: Keyence, ABB, IFM, SMC,
Omron, Siemens, Schneider, Festo, Yaskawa, Autonics, Mean Well, Hikvision, Dahua; ve **"Honor"** —
"Honor Courage Valor" tişörtü telefon markası sayılıyordu, v2'de de vardı); araç üreticileri ve Tuya
yalnızca uyumluluk; uyumluluk işaretleri genişledi ("applicable to", "apply to", "used for",
"matching", "adapter", "to"). Yapılandırılmış kaynak marka başlıktan çıkarılan tahmini **ezmeye
devam eder** (`clean_source_brand` önce).

## 5. Ölçüm (Faz 5)

**Araçlar:** `classify sample --per-source K --split dev|eval` (kaynak kategoriye göre tabakalı, salt
okunur), `classify evaluate --labels dosya.tsv` (kesin/kaba/yanlış, kaçan, marka precision/recall,
aksesuar↔ana ürün karışıklığı, kaynak bazında hata, marka-boş nedenleri, **Wilson %95 aralığı**),
kararlı dev/eval ayrımı (`crc32(id)`), `tests/classify_eval_labels.tsv`, `classify_prevented_errors.json`.
Etiketsiz satırdan precision **üretilmez**. Dosyadaki `label_source` sütunu (`human` | `model`) ile
**insan ve model etiketleri asla birleştirilmez**: `evaluate` her kaynağı ayrı raporlar ve insan etiketi
yoksa "doğruluk kanıtı sayılmaz" uyarısı verir.

**Veri.** Gerçek AliExpress teklifleri (Admitad 6115, 1.696.880 kayıt, 21 kaynak yolu). *Tüm üretim
kataloğunu temsil etmez* (üretimde v2'nin ilk 5.000 ürün raporu %31,7 kapsama verdi).

**Etiket kaynağı: tamamı MODEL (Claude), kör etiketleme (başlık + kaynak; tahmin gösterilmeden).
İNSAN DOĞRULAMASI YOKTUR.** Aşağıdaki oranlar "model etiketine göre" okunmalı; modelin dünya bilgisi
kural tabanlı sistemden fazladır (örn. parça numarasından marka/ürün tanıma), bu yüzden `missed`
(kaçan) oranı olduğundan kötü görünebilir, hata türleri ise gerçektir. Bağımsızlık: değerlendirme
satırları geliştirmede bakılmamış "eval" yarısından; **hata analizi yapılan kümeler (B1) ile ayar
sonrası doğrulama kümesi (B2) ayrıdır**.

**A. Tabakalı örneklem (216 satır, 18 kaynak × 12), aynı satırlarda — kategori:**

| | v1 | v2 | v3 | v3 %95 aralığı |
| --- | --- | --- | --- | --- |
| Kapsama (otomatik yazılan, n=216) | %81,5 | %63,4 | %64,4 | — |
| Precision (kesin) | %58,5 | %72,3 | %71,2 | [63,2; 78,1] |
| Precision (kaba dahil) | %72,7 | %86,9 | %85,6 | |
| Yanlış oranı (yazılanlar içinde) | %27,3 | %13,1 | %14,4 | [9,5; 21,2] |
| Kaçan (etiketli kategori var, incelemede) | 35 | 72 | 71 | |
| Aksesuar↔ana ürün karışıklığı | 3 | 0 | 0 | |

v3 ≈ v2 (fark gürültüde; v1→v2 kazanımı gerçek: yanlış %27 → %13). Bu örneklemde v3'ün değiştirdiği
kovalar azdır; v3'ün etkisini B bölümü ölçer.

**B. v3'ün DEĞİŞTİRDİĞİ ürünlerin doğrudan ölçümü (kör, karışık gelen+giden):**

| Küme | Ürün (1,7 M'de) | n | Sonuç | %95 aralığı |
| --- | --- | --- | --- | --- |
| B1 (hata analizi yapıldı) — v3'ün yeni yazdıkları | ~43.200 | 60 | %82 doğru (49) | [70; 89] |
| B1 — v3'ün geri çektikleri, v2 doğruydu | ~20.900 | 60 | %32 (19) | [21; 44] |
| **B2 (ayar sonrası, hiç bakılmamış) — yeni yazdıkları** | ~42.400 | 70 | **%84 doğru (59)** | **[74; 91]** |
| **B2 — geri çektikleri, v2 doğruydu** | ~18.400 | 70 | **%29 (20)** | **[19; 40]** |

Yorum (B2): v3'ün yeni yazdığı ürünlerin ~%16'sı yanlış (**yanlış pozitif**); geri çektiklerinin
**~%71'i v2'nin yanlışıydı**, ~%29'u doğruydu (**yanlış geri çekme**). Kaba net etki (aralık geniş, ±~10 puan): yeni yazılan 42,4 bin × %84 ≈ +35,7 bin doğru / +6,8 bin yanlış; geri çekilen 18,4 bin × %29 ≈ −5,3 bin doğru / −13,1 bin yanlış ayıklandı → **net ≈ +30 bin doğru atama, ≈ −6 bin yanlış atama**. Toplam kapsama 1,7 M'de **%64,1 → %65,5**.

**Hata türleri (B2, n küçük; çıkarım değil gözlem):**
- *Yanlış pozitif (11/70):* 9'u `endustriyel` "çekirdek"i: seviye/basınç sensörü ve vericisi (ölçü aleti
  olmalıydı), akülü hidrolik pens (el aleti), makine görüşü kamerası, PLC kablosu (elektrik tesisatı),
  otobüs klima pompası ve Ford karbon tank valfı (oto parça). Ortak neden: `sensor/pump/valve` gibi
  bileşen sözcükleri alan bağlamı olmadan "endüstriyel" sayılıyor.
- *Yanlış geri çekme (20/70):* 8'i OEM numaralı **oto parçası** (araç markası geçmediği için oto
  sinyali yok, `valve/actuator` endüstriyele çekiyor), 3'ü tırnak bakım ürünü (satıcı "Packaging"
  kovasında), 2'si vida/hırdavat, 2'si el aleti, 1'i tişört, 1'i kahve değirmeni.
- *Kategori çakışması:* geri çekmelerin çoğu `source_title_conflict` (v3'te 1,7 M'nin ~%18'i);
  çakışma kararı **doğru yönde ama pahalı**: çakışanların ~%29'u aslında doğruydu.

**C. Marka (kategoriden ayrı ölçüldü):** v3'ün eval yarısında yazdığı 2.049 markadan 60 örnek:
**59 doğru** (%98; aralık [91; 99,7]); 1 yanlış (Honor sözcük tuzağı, düzeltildi). Başlıktan marka sayısı
v2 2.588 → v3 4.134. **Marka kapsama/recall:** etiketli 216 satırın 11'inde ürünün kendi markası var
(model etiketi); v2/v3 bunların 0'ını buldu — bulunan markalar (Keyence, Aneng, Ugreen…) bu örneklemde
yok. Yani **precision yüksek, kapsama çok düşük (~%0,25; üst sınır ~%5)** ve kapsamı büyütmenin güvenli
yolu markasız ürünleri tahmin etmek değil, yapılandırılmış marka alanı (HB/Trendyol `brand_raw`) ya da
*onaylı* marka listesi eklemektir. Marka boş kalma nedenleri: bkz. §4.

**Doğrulanamayanlar.** (1) İnsan etiketi yok: tüm precision/yanlış oranları model etiketlidir, aralıklar
yalnızca örnekleme belirsizliğini yansıtır (etiket hatasını DEĞİL). (2) Üretimdeki 200 ürünlük örnek ve
üretim dağılımı bu ortamdan erişilemez (yalnızca `deploy@` salt okunur `status` yetkisi var), v3'ün
üretim başarısı **ölçülmedi**. (3) HB/Trendyol'da v3 doğrulanmadı. (4) Bebek arabası dalı bu beslemede
216 başlık; sentetik örneklerle test edildi.

## 6. Performans ve ölçü (Faz 6)

- Karar hızı (saf Python, aynı 212 bin başlık): v2 12.796/sn, v3 11.851/sn (~%7 yavaş); kural dizini
  bellek +0,2 MB. Üretimde sınır veritabanı yazımıdır (yerel ölçüm ~2.100 ürün/sn, 0133).
- **Değişmeyenler:** parti/kontrol noktası, idempotans (yalnızca değişen satır UPDATE), WAL bekçisi
  (0134), kilit yeniden denemesi, `--owned-only`/`recheck` (0138), sahiplik modeli.
- **Migration 0091 doğrulaması (yerel, 1.040.000 ürünlü veritabanı):** ürün (id, kategori, marka) md5'i
  uygulama öncesi/sonrası **aynı**; mevcut 143 kategorinin (id, yol, slug) md5'i **aynı**; +11 düğüm;
  ikinci uygulama 0 değişiklik. Entegrasyon testleri (`test_taxonomy_v3_migration_only_adds_categories_
  and_keeps_classifications`, `test_category_tree_integrity`) gerçek `product_classification` kayıtlarıyla
  aynı şeyi doğrular. Üretim için salt okunur bütünlük sorguları §7'de.
- **Tahmini maliyet, 2,77 M ürün** (yazılan ~%65 varsayımıyla, *üretimde doğrulanmadı*): karar hesabı
  ~4 dk CPU; veritabanı süresi ~20–25 dk teorik, WAL bekçisiyle saatler; yazılan ürün başına ~4,2 KB WAL
  (0133 yerel ölçümü) → ~1,8 M satır ≈ 7–8 GB WAL.

## 7. Üretime geçiş: kontrollü pilot (onay gerekir)

**Önkoşul.** Üretim şu an `b1984c1`: #195'teki *ilk* v3 sürümü (kural 3'ün erken hâli, 0091 uygulandı) ve
#197 çalışıyor. `classify` hiçbir zamanlayıcıda yoktur, kendiliğinden çalışmaz. **Bu PR (nihai kurallar)
dağıtılmadan pilot başlamaz**; erken sürümde "yabancı kanıt güçlüyse çelişki" kuralı vardır
(doğru atamaların çoğunu düşürüyordu).

**Salt okunur üretim bütünlük kontrolü (migration 0091 sonrası):**
```sql
SELECT count(*) FILTER (WHERE path LIKE 'elektronik/guc-batarya%') AS guc,           -- beklenen 4
       count(*) - count(DISTINCT path) AS yinelenen_yol,                               -- 0
       count(*) - count(DISTINCT slug) AS yinelenen_slug                               -- 0
  FROM category;
SELECT c.path FROM category c LEFT JOIN category p ON p.id = c.parent_id
 WHERE position('/' IN c.path) > 0
   AND (p.id IS NULL OR p.path <> regexp_replace(c.path, '/[^/]+$', ''));           -- 0 satır
SELECT count(*) FROM product WHERE category_id IN
  (SELECT id FROM category WHERE path IN ('ev-yasam/yapi-market/endustriyel'));        -- 0 (henüz yazılmadı)
```

**Aşama 0 — İnsan etiketli üretim ölçümü (yazma yok).**
`python -m classify sample --merchant aliexpress --per-source 15 --n 400 --seed 7 --split eval > s.tsv`
→ iki kişi `expected_category`/`expected_brand` doldurur, `label_source` = `human`
(uyuşmazlıklar çözülür) → `python -m classify evaluate --labels s.tsv`.
**Geç:** insan etiketli ≥ 300 satırda kesin precision alt sınırı (%95 aralık) ≥ %80 **ve** yanlış oranı üst
sınırı ≤ %12 **ve** marka precision alt sınırı ≥ %90. Aksi hâlde kurallar düzeltilir, pilot yok.

**Aşama 1 — 495 ürünlük v2 yazımını yeniden değerlendir (geri alınabilir).**
`recheck --merchant aliexpress > recheck_v3.tsv` (salt okunur); `keep/change/clear` dağılımı incelenir;
`\copy` anlık görüntüsü (0138 §Üretim) alınır. `products --confirm --owned-only --batch 100 --max-batches 1`.
**Geç:** hata 0, `change` oranı < %10, örnekten 30 `change`/`clear` satırı elle doğru. **Dur:** hata > 0,
`change` > %25 ya da elle bakılan 30'un > 5'i yanlış → anlık görüntüden geri al.

**Aşama 2 — Küçük canlı pilot (en çok 20.000 ürün, tek kaynak).**
`products --confirm --merchant aliexpress --max-batches 10 --batch 2000` (yeni kontrol noktası).
Hemen ardından rastgele 300 yazılan ürün insan etiketine gider. **Geç:** yazılanlar içinde yanlış üst
sınırı ≤ %12; `review` ≥ beklenen (rapor ± 5 puan); `errors` = 0; `wal` duraklamaları < %10 süre;
arama p95 gecikmesi pilot öncesine göre +%10'dan az (`search_outbox` birikmesi izlenir).
**Dur (otomatik karar yok, insan):** yanlış oranı > %15, `concurrent_change` hataları > %0,5, WAL
geri basıncı 3 kez üst üste, arama/sohbet hata oranında artış.

**Aşama 3 — Kademeli genişleme.** %1 → %5 → %25 → %100 (her adımda 300'lük insan örneklemi, aynı
kriterler). Her adım ayrı onay. `classify lexicon --apply` en son (kapsam yeterliyken; kategori yüzeyi
katı filtredir).

**Geri alma.** `product_classification.wrote_*` ve anlık görüntü sayesinde yalnızca bu işin yazdığı
değerler geri alınır (0138 §Geri alma SQL'i); yönetici/besleme değerleri dokunulmaz. Kategori ağacı
geri alma SQL'i §2'dedir (ürün bağlanmadan önce).

## Süreç bulgusu — #195'in birleşmesi (kanıt)

- #195 (taslak değil) 22:27:47Z'de **web arayüzünden** açıldı (başlık "…" ile kesik, gövde "…" ile devam:
  GitHub web ön doldurması; `gh pr create` böyle kesmez), 22:28:28Z'de GitHub'ın **Update branch** işlemiyle
  `main` birleştirildi (commit'in committer'ı GitHub, imzalı), 22:34:16Z'de `YusufSari-ai` hesabıyla squash
  birleştirildi. Hiçbir Actions iş akışı PR açmaz, birleştirmez ya da dalı güncellemez; `C:\ClaudeAutopilot`
  yalnızca oturum devam ettirir (son etkinliği 04:02, git/gh komutu yok).
- Birleşme anında `pr policy` durumu **failure** ("Yüksek risk (migration): insan onayı gerekli") idi ve
  `risk-approved` etiketi yoktu. `main` **korumasız** ve kural setleri API'de 403 ("Upgrade to GitHub Pro or
  make this repository public"): kuruluş *free* planda, depo özel olunca dal koruması/kural seti
  uygulanamıyor. Yani kapı **tavsiye niteliğinde**; kırmızı kontrole rağmen birleştirme engellenmez.
- İşlemi kimin yaptığı (kullanıcı mı, aynı hesabı kullanan başka bir oturum/tarayıcı otomasyonu mu)
  **kanıtlanamadı**; GitHub denetim günlüğü bu planda yok. Sorumluluk atanmadı.
- Sonuç: birleşme otomatik dağıtımı tetikledi (#197 ile build düzelince `b1984c1` dağıtıldı, migration
  0091 üretimde uygulandı; yedek `pre-migrate-20261018-232022-…dump`). Zarar: yok (yalnızca ekleme
  migration'ı, sınıflandırma çalışmadı); risk: üretimde nihai olmayan kural sürümü.
- Öneri: planı yükseltip (ya da depoyu kamuya açmadan) dal korumasını gerçekten zorunlu kılmak; o zamana
  dek `pr policy` kırmızıyken birleştirmemek kural olarak ekip içinde yazılı olmalı.

## Reddedilen alternatifler

| Alternatif | Neden değil |
| --- | --- |
| Ağacı baştan tasarlamak / kimlik-slug değiştirmek | Ağaç yapısı doğru; yalnızca yaprak eksik. Kimlik/slug değişikliği SEO ve arama için risk |
| Çöp kovası kaynaklarını yüksek güvenle eşlemek | Ölçüldü: kahve yazıcısı, motor kaputu "ölçü aleti" oluyordu |
| "Yabancı kanıt daha güçlüyse çelişki" kuralı | Doğru atamaların çoğunu düşürdü (geri alındı) |
| Başlığın ilk büyük harfli kelimesini marka saymak | 51 bin farklı ilk kelime; çoğu satıcı öneki/sıfat ("Car", "Modern", "Suitable") |
| Model çağrısı | Kural 1/3; maliyet ürünle ölçeklenir |
