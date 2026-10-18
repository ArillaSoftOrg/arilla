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

**Araçlar:** `classify sample --per-source K --split dev|eval` (kaynak kategoriye göre tabakalı,
salt okunur), `classify evaluate --labels dosya.tsv` (kategori kesin/kaba/yanlış, kaçan, marka
precision/recall, aksesuar-ana ürün karışıklığı, kaynak bazında hata, marka-boş nedenleri; etiketsiz
satırdan precision **üretmez**), kararlı dev/eval ayrımı (`crc32(id)`), `tests/classify_eval_labels.tsv`
ve `classify_prevented_errors.json`.

**Veri ve yöntem.** Gerçek AliExpress teklifleri (Admitad 6115, 1.696.880 kayıt, 21 kaynak yolu; sürekli
"hot products" beslemesi + 10 beslemenin ilk 12 MB'ı). *Bu tüm üretim kataloğunu temsil etmez*
(üretimde v2'nin ilk 5.000 ürün raporu %31,7 kapsama verdi; kayıt dağılımı farklı). Değerlendirme
satırları kural donduktan SONRA, geliştirmede hiç bakılmamış "eval" yarısından çekildi ve **yalnızca
başlık+kaynak gösterilerek (tahmin gösterilmeden)** etiketlendi. **Etiketleri insan değil model
(Claude) atadı; insan doğrulaması yoktur.** Rakamlar bu yüzden "model etiketine göre" okunmalıdır.
Eval etiketleri gördükten sonra *kural değiştirilmedi* (tek istisna: marka listesi "Honor", 60
satırlık marka denetiminde bulunan bir sözcük tuzağı).

**A. Tabakalı örneklem (216 satır, 18 kaynak × 12), aynı satırlarda v1/v2/v3:**

| | v1 | v2 | v3 |
| --- | --- | --- | --- |
| Kapsama (otomatik yazılan) | %81,5 | %63,4 | %64,4 |
| Precision (kesin) | %58,5 | %72,3 | %71,2 |
| Precision (kaba dahil) | %72,7 | %86,9 | %85,6 |
| Yanlış oranı (yazılanlar içinde) | %27,3 | %13,1 | %14,4 |
| Aksesuar↔ana ürün karışıklığı | 3 | 0 | 0 |
| Marka kapsama / precision | 0 / – | 0 / – | 0 / – |

v3 ≈ v2 (fark örneklem gürültüsünde; n≈140 yazılan satırda ±6 puan). **v2'nin v1'e karşı kazanımı
gerçek ve büyük; v3 bu tabakalı örneklemde ek iyileşme göstermiyor.** Sebep: 18 kaynağın çoğunda
(takı, giyim, kılıf, mobilya, tekstil) v3 davranışı aynı; v3'ün değiştirdiği kovalar örneklemde az.

**B. v3'ün DEĞİŞTİRDİĞİ ürünlerin doğrudan ölçümü (120 satır, kör, karışık):**

| Değişim | Ürün sayısı (1,7 M'de) | Örnek | Doğru | Anlam |
| --- | --- | --- | --- | --- |
| v3'ün yeni yazdıkları (incelemeden → atandı) | ~43.200 | 60 | **%82** (49/60) | yeni kapsama büyük ölçüde doğru |
| v3'ün geri çektikleri (atanmıştı → inceleme) | ~20.900 | 60 | v2 yalnızca **%32** doğruydu (19/60) | geri çekilenlerin çoğu v2'nin *yanlışı* |

Kaba tahmin (güven aralığı ±~12 puan): net ≈ +29 bin doğru atama, −6 bin yanlış atama (yanlışların
%68'i ayıklandı). Toplam kapsama 1,7 M'de **%64,1 → %65,4**; yanlış atama sayısı düşerken kapsama da
arttı. Satıcı çöp kovalarında kapsama: Tool Parts %3,0 → %12,0, Industrial %2,0 → %20,6, Electrical %2,5
→ %7,9, Power Tool Parts %9,1 → %12,9, Measurement %2,8 → %5,0.

**C. Marka denetimi:** v3'ün eval yarısında yazdığı 2.049 markadan 60 örnek: **59 doğru (%98)**; 1 yanlış (Honor, düzeltildi).
Toplam başlıktan marka: v2 2.588 → v3 4.180.

**Doğrulanamayanlar.** (1) Gerçek precision/yanlış oranı için *insan* etiketi yok; yukarıdakiler model
etiketli ve güven aralıkları geniş. (2) Üretimdeki 200 ürünlük rastgele örnek (`/root/arilla-classification-sample.tsv`)
buradan erişilemez; v3'ün üretim dağılımındaki başarısı **ölçülmedi**. (3) HB/Trendyol kaynaklarında
v3 doğrulanmadı (yapılandırılmış marka ve Türkçe kategori yolları kodla test edilir, ürün örneği yok).
(4) Bebek arabası dalı üretim gözlemine dayanır; bu beslemede yalnızca 216 başlık var, kural
sentetik örneklerle test edildi.

## 6. Performans ve ölçü (Faz 6)

- Karar hızı (saf Python, aynı 212 bin başlık): v2 12.796/sn, v3 11.851/sn (~%7 yavaş); kural dizini
  bellek +0,2 MB. Üretimde sınır veritabanı yazımıdır (yerel ölçüm ~2.100 ürün/sn, 0133).
- **Değişmeyenler:** parti/kontrol noktası, idempotans (yalnızca değişen satır UPDATE), WAL bekçisi
  (0134), kilit yeniden denemesi, `--owned-only`/`recheck` (0138), sahiplik modeli. Entegrasyon testleri
  (16) ve ingest birim testleri (1.288) geçti.
- **Tahmini maliyet, 2,77 M ürün** (v3 yazılan ~%65 varsayımıyla, *üretimde doğrulanmadı*): karar
  hesabı ~4 dk CPU; veritabanı süresi ~20–25 dk teorik, WAL bekçisiyle saatler; yazılan ürün başına
  ~4,2 KB WAL (0133 yerel ölçümü) → ~1,8 M satır ≈ 7–8 GB WAL. Arama/sohbet performansına etkisi: yalnızca
  `search_outbox` olayları (0136, tüketicisiz).

## 7. Üretime geçiş: kontrollü pilot (onay gerekir)

1. PR birleşir, otomatik dağıtım migration 0091'i uygular (yalnızca INSERT). Doğrula:
   `SELECT count(*) FROM category WHERE path LIKE 'elektronik/guc-batarya%'` = 4.
2. **Salt okunur ölçüm (üretim verisinde v3'ü ilk kez görmek):**
   `python -m classify sample --merchant aliexpress --per-source 15 --n 300 --seed 7 --split eval > s.tsv`
   — `expected_category`/`expected_brand` sütunlarını insan doldurur, sonra
   `python -m classify evaluate --labels s.tsv`. Eşik önerisi: kesin precision ≥ %85 ve yanlış oranı ≤ %8,
   aksi halde toplu iş başlamaz.
3. `python -m classify report --merchant aliexpress --max-batches 5` (salt okunur kapsama).
4. v2'nin yazdığı 495 ürün için `recheck` → `--owned-only` pilotu (0138 runbook).
5. Toplu iş: `products --confirm --merchant aliexpress` ayrı, açık onayla.
6. `classify lexicon --apply` en son (kapsam yeterliyken).

## Reddedilen alternatifler

| Alternatif | Neden değil |
| --- | --- |
| Ağacı baştan tasarlamak / kimlik-slug değiştirmek | Ağaç yapısı doğru; yalnızca yaprak eksik. Kimlik/slug değişikliği SEO ve arama için risk |
| Çöp kovası kaynaklarını yüksek güvenle eşlemek | Ölçüldü: kahve yazıcısı, motor kaputu "ölçü aleti" oluyordu |
| "Yabancı kanıt daha güçlüyse çelişki" kuralı | Doğru atamaların çoğunu düşürdü (geri alındı) |
| Başlığın ilk büyük harfli kelimesini marka saymak | 51 bin farklı ilk kelime; çoğu satıcı öneki/sıfat ("Car", "Modern", "Suitable") |
| Model çağrısı | Kural 1/3; maliyet ürünle ölçeklenir |
