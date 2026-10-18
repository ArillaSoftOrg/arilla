# 0138 — Sınıflandırma doğruluğu: kaynak/başlık çelişkisi, parça kaynakları, sahip olunan değerlerin yeniden kontrolü

**Tarih:** 18 Ekim 2026
**Durum:** Önerildi (PR). Üretimde çalıştırma ayrı, açık bir operasyon kararıdır; toplu
sınıflandırma kullanıcı onayı bekler.
**İlişkili:** 0133 (ürün sınıflandırma), 0134 (WAL geri basıncı)

## Sorun

Üretim pilotunda (ilk 1.000 AliExpress ürünü) 618 ürüne kategori yazıldı; örneklerde yanlışlar
var (ürün 17, "electric shock protection plug" → `ev-yasam/mutfak`, güven 88). Kök neden üç parça:

1. **Kaynak kategori gürültülü, karar onu sorgusuz kabul ediyordu.** AliExpress beslemesinde
   (Admitad 6115) kategori yolu yalnızca **iki seviyedir** ve satıcının seçimidir:
   `Home & Garden > Kitchen,Dining & Bar` → `ev-yasam/mutfak` (88). `decide._category` güven ≥ 80
   kaynağı başlığa bakmadan yazıyordu; başlık yalnızca kaynağın *altında* daraltma için
   okunuyordu. Aynı kaynakta priz, RAID kartı, NAS, yakıt tankı pompası, araç anahtar programlayıcı
   gerçek örneklerdir. Ürün 17'nin kaynak eşlemesi (yol → mutfak) doğrudur; **hata kararda**.
2. **Bazı kaynak eşlemeleri kendisi yanlıştı.** Kural, bölüm adındaki cihaz kelimesini görüp
   "parça/aksesuar" niteleyicisini yok sayıyordu: `Computer & Office > Laptop Parts & Accessories`
   → dizüstü (90), `Tools > Power Tool Parts & Accessories` → elektrikli aletler (88),
   `Tablet Accessories & Parts` → tablet, `Home Appliance Parts` → ev aletleri.
3. **Yüksek güven doğruluk değildi.** Etiketli örneklemde güven 85–88 ile yazılan
   `Home Decor` ürünlerinin ~%49'u (sehpa, şifonyer, kaynak makinesi), `Furniture Accessories`
   ~%29'u, `Tools > Tool Parts` ~%57'si (gaz kelebeği, ATV, bar sandalyesi) yanlıştı. Kaynağı
   ağaçta karşılığı olmayan (`unmapped`, örn. `Industrial & Business > Packaging…`) ürünlerde
   başlık tek başına ~%71 yanlıştı (kaynak makinesi → takı, ATV → RC oyuncak).

**Marka:** beslemede marka/vendor alanı **yok** (1,7 M kayıtta 0). Başlıktaki ilk kelime çoğunlukla
satıcı öneki (LTT, DSA, AZGIANT), marka değil; genel "ilk büyük harfli kelime" kuralı güvenilmez.

## Karar (kural sürümü 2)

1. **Başlık kaynaktan bağımsız da okunur** (`categories.title_evidence`: tüm adaylar + alan
   işaretleri). Başlıkta kaynak dalını destekleyen kural yoksa ve
   - başlık güçlü biçimde başka dalı gösteriyorsa → inceleme (`conflict`, `source_title_conflict`);
   - yalnızca alan işareti (`cue` kuralları: araç, bahçe, elektrik tesisatı, bilgisayar, telefon)
     başka alanı gösteriyorsa → önerilmiş kaynakta inceleme (`source_cue_conflict`).
   Aynı ana kategoride kardeş dal + başlıkta kaynağın kendi alan işareti ("Car Headlight Film"
   Exterior Accessories'te) çelişki sayılmaz.
2. **Başlık kaynağı tek başına değiştirmez.** Denendi: "başlık kazansın" kararlarının yarısı yanlıştı
   (meyve kasesi → mobilya, bira musluğu → banyo, davlumbaz camı → ekran koruyucu). Çelişki inceleme
   bekler; başlık yalnızca kaynağın altında daraltır (0133 ile aynı).
3. **Öncelik korunur:** yönetici onayı (`confirmed`) > kural önerisi (`suggested`) > başlık. Onaylı
   eşlemeyi alan işareti geçemez; güçlü ve açık çelişki ise onaylı kaynakta da incelemeye düşer
   (yönetici *yolu* onayladı, her ürünü değil).
4. **Parça/aksesuar kaynak bölümü cihaz kategorisine eşlenmez** (`taxonomy.DEVICE_PATHS`). Yalnız
   "aksesuar" diyen bölüm cihazın aksesuar dalına gider (`Camera & Photo Accessories` →
   `kamera/aksesuar`), "parça" diyen bölüm düşer ve üst bölüm sonucu zayıf kalır (başlık doğrulamalı).
   Alan kategorilerinde (bisiklet, oto) parça kategorinin parçasıdır: değişmez.
   `Tools > Tool Parts` karışık kova: zayıf (70).
5. **Parça/uyumluluk başlığı** ("Replacement…", "Suitable for…", "Applicable to…") bir cihaz
   kategorisini kanıtlamaz (`part_title`).
6. **Ağaçta karşılığı olmayan kaynak** (`unmapped`) varken başlık ≥ 85 (kural ≥ 90) ister
   (`unmapped_source`). Kaynağı hiç olmayan ürün 0133'teki gibi ≥ 80 ile.
7. **Gevşek başlık kuralları daraltıldı:** "food" yalnız kaynak adı; "conditioner" (klima),
   `kazak*` (Kazakhstan), "side skirts", "coat of arms", yalın "plug/socket" artık yanlış eşleşmez.
8. **Marka:** uyumluluk işaretleri genişledi ("applicable", "apply to", "used for", "matching",
   "adapter", "to"…): başlıktaki uyumlu cihaz markası ürünün markası yazılmaz. Seçilmiş listeye
   örneklemde sık ve resmi mağazalı üreticiler (UNI-T, Aneng, Fnirsi, HoldPeak, Inkbird, Xtool,
   MaXpeedingrods, Zonesun, Sonoff, Aqara, Yeelight, Moes, Zemismart); araç üreticileri ve Tuya
   yalnızca **uyumluluk** markasıdır. Oto parça/aksesuar dalları cihaz markası açısından aksesuar
   sayılır. Marka bulunamazsa markasız kalır.
9. **Yeni kural sürümünde sahip olunan değerin düzeltilmesi:** `classify recheck` (YALNIZCA OKUR,
   TSV: eski/yeni kategori, `keep|change|clear`, eski kimlikler) ve
   `classify products --confirm --owned-only [--after-id N]`: yalnızca bu işin yazdığı ve hâlâ
   üründe duran değerler yeniden karar alır; kontrol noktası yazılmaz, tüm katalog taraması
   başlamaz; yönetici/besleme değeri ve sınıflandırılmamış ürün dokunulmaz. Belirsizleşen değer
   geri alınır (yanlış kategori yerine kategorisiz).

Şema değişikliği yok: yeni nedenler `product_classification.detail` içinde.

## Ölçüm (gerçek veri, model yok)

Admitad 6115 beslemesinden salt okunur akışla 1.696.880 AliExpress teklifi (21 kaynak yolu; mutfak,
dekor, mobilya, oto, alet, takı, giyim, kılıf, endüstriyel…). Önce = `main` (kural 1), sonra = bu
değişiklik; kaynak eşlemesi her iki durumda kural önerisi. 18 büyük kaynaktan kaynak başına 35
satır elle etiketlendi (iki bağımsız örneklem); oranlar kaynak büyüklüğüyle ağırlıklandırıldı.

| | Önce | Sonra |
| --- | --- | --- |
| Otomatik yazılan | %87,8 | %64,1 |
| Yazılanlar içinde yanlış (tahmini) | ~%20,4 (~304 bin) | ~%7,1 (~77 bin) |
| Doğru yazılan (tüm ürünlere oran) | %69,9 | %59,6 |
| Başlıktan marka | 792 | 2.588 |

Yanlış atama ~%75 azalır. Bedeli: ~175 bin doğru atama incelemeye düşer — çoğu `Tools > Tool Parts`
içindeki genel "Yapı Market" atamaları ve oto kaynaklarındaki yanlış incelemeler (~%5–10). Kaynak
başına: Kitchen yanlış %26 → %8, Home Decor %49 → %36, Furniture Accessories %29 → %20,
Power Tool Parts ~%93 → (neredeyse tamamı inceleme), oto/takı/giyim/kılıf ≤ %6 ve değişmedi.
Kalan en büyük hata kümesi: `Home Decor` içindeki makine/sanayi ürünleri (başlıkta kural yok).

Karar hızı (saf Python) ~12.500 ürün/sn; üretim partisi veritabanına bağlı (~2.100/sn).

## Üretim: 618 ürünün düzeltilmesi (pilot ve geri alma)

Ön koşul: bu PR dağıtılmış, `catalog_build` oturumu yok. Hepsi `services/ingest` imajında.

1. **Önizleme ve geri alma kaydı (salt okunur):**
   `python -m classify recheck --merchant aliexpress > recheck_v2.tsv` — `action` sayıları stderr'de.
   Ayrıca anlık görüntü:
   ```sql
   \copy (SELECT pc.*, p.category_id AS p_category_id, p.brand_id AS p_brand_id FROM product_classification pc JOIN product p ON p.id = pc.product_id WHERE pc.wrote_category OR pc.wrote_brand) TO 'owned_v1.csv' CSV HEADER
   ```
2. **Kontrollü pilot:** `python -m classify products --confirm --owned-only --merchant aliexpress
   --batch 100 --max-batches 1` → çıktıdaki `son_urun` ile `recheck_v2.tsv` karşılaştırılır,
   örnekler arayüzde kontrol edilir.
3. **Kalanı:** `… --owned-only --merchant aliexpress --after-id <son_urun>`.
4. **Doğrulama:** `python -m classify status`;
   `SELECT state, detail, count(*) FROM product_classification WHERE rule_version = 2 GROUP BY 1, 2`.
5. **Geri alma** (gerekirse; tek işlem, yalnız v2'nin dokunduğu ve o günden beri değişmemiş satırlar):
   ```sql
   BEGIN;
   CREATE TEMP TABLE snap (LIKE product_classification) ON COMMIT DROP;
   ALTER TABLE snap ADD COLUMN p_category_id bigint, ADD COLUMN p_brand_id bigint;
   \copy snap FROM 'owned_v1.csv' CSV HEADER
   UPDATE product p SET category_id = s.p_category_id, brand_id = s.p_brand_id, updated_at = now()
     FROM snap s JOIN product_classification pc ON pc.product_id = s.product_id
    WHERE p.id = s.product_id AND pc.rule_version = 2
      AND p.category_id IS NOT DISTINCT FROM CASE WHEN pc.wrote_category THEN pc.category_id END
      AND (p.category_id, p.brand_id) IS DISTINCT FROM (s.p_category_id, s.p_brand_id);
   UPDATE product_classification pc SET rule_version = s.rule_version, state = s.state,
          brand_id = s.brand_id, brand_basis = s.brand_basis, category_id = s.category_id,
          category_basis = s.category_basis, confidence = s.confidence,
          compatible_brands = s.compatible_brands, wrote_brand = s.wrote_brand,
          wrote_category = s.wrote_category, detail = s.detail, classified_at = now()
     FROM snap s WHERE pc.product_id = s.product_id AND pc.rule_version = 2;
   INSERT INTO search_outbox (entity, entity_id, op, reason)
   SELECT 'product', s.product_id, 'upsert', 'classified' FROM snap s
     JOIN product p ON p.id = s.product_id AND p.publication_state = 'published';
   COMMIT;
   ```
6. **Toplu sınıflandırma** (2,77 M) ayrı onayla: `products --confirm --merchant aliexpress`
   (kural 2 için yeni kontrol noktası, WAL bekçisi 0134). Önce `report --merchant aliexpress`
   (salt okunur) oranları üretim verisinde doğrular.

## Reddedilen alternatifler

| Alternatif | Neden değil |
| --- | --- |
| Çelişkide başlığın kategorisini yazmak | Ölçümde yarısı yanlış; başlık anahtar kelimesi çoğu zaman ürünün kendisi değil (kullanım alanı, uyumlu cihaz, motif) |
| Güven eşiğini yükseltmek | Kitchen 88 ile yanlış yazıyordu; sorun eşik değil, çelişkinin hiç ölçülmemesi |
| Yeni kategoriler (elektrik tesisatı, endüstriyel) | Görev mevcut ağaç; karşılığı olmayan ürün kategorisiz kalır |
| "İlk büyük harfli kelime = marka" | Örneklemde çoğu satıcı öneki; yanlış marka yazardı |
| Model çağrısı | Kural 1/3; maliyet ürünle ölçeklenir |
