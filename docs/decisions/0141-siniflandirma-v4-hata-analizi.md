# 0141 — Sınıflandırma v4: üretim örneği hata analizi (kaynak/başlık çelişkisi, ürün türü, parça numarası, cinsiyet)

**Tarih:** 22 Ekim 2026
**Durum:** Önerildi (PR). Birleştirme, dağıtım ve üretimde hiçbir sınıflandırma çalıştırma kullanıcı
onayına bağlıdır; üretim verisine dokunulmadı. Migration 0094 (karar 0140'ın 0092/0093'ünden sonra).
**İlişkili:** 0133, 0138 (v2), 0139 (v3)

## 1. Girdi ve doğrulama sınırı

Üretimden alınan 196 ürünlük tabakalı örnek (31 kaynak yolu, v3 kuralıyla 146 kategori önerisi =
%74,5 **kapsama**, 50 inceleme, 1 marka). Kullanıcı 10 ürünü yanlış olarak işaretledi. Başlık ve kaynak
yolu örneğin kendisinden (TSV) okundu; **önce v3 koduyla yeniden üretildi: 196 satırın 196'sında karar
TSV'deki ile aynı** (v3'ün üretimde dağıtılan sürümüyle aynı davranış kanıtı). 10 hatanın 10'u üretildi.
Üretim veritabanına erişim yok; yalnızca bu örnek ve depodaki etiketli küme kullanıldı.

## 2. Kök nedenler (örnekte doğrulandı)

| # | Kök neden | Örnek (başlık → v3 sonucu) |
| --- | --- | --- |
| K1 | **Kaynak dalı başlıkta hiç kanıt yokken güvenle yazılıyor.** Niş yaprak kaynağın (güven 90) başlıkla desteklenip desteklenmediğine bakılmıyor; satıcı yanlış kovaya koyduysa yazılır. | "Part Number 5C5807773 … Bumper Bracket", "Instrument Cup Holder 99155219401 … Boxster" → "Baby Strollers" bebek arabası aksesuarı |
| K2 | **Yaprak bölüm eşleşmeyince ata sonucuna sessizce düşülüyor** ve dalda karşılığı yok. | "Motorcycle … > Boats": 5/5 ürün (dıştan takma motor, jet ski, tekne radyosu) motosiklet. **Tekne dalı yoktu.** |
| K3 | **Koku sıfatı ürün türünü eziyor** ("scent", "fragrance"); ambalaj ve hijyen ürünü parfüm kovasında. | "Shower Gel … Scent" → parfüm; "Perspiration Pads" → parfüm; esans şişesi/damlalık/atomizer → parfüm (4/4) |
| K4 | **Tek yollu kural karşı cinsiyet bağlamını görmüyor.** | "Men's Thobe … Men's Abaya … Dress" → kadın elbise |
| K5 | **Başlığın sonundaki tek kelime kaynağı "destekliyor" sayılıyor** (anahtar kelime yığını); başta çok kelimeli başka alan var. | "IC Pickup/BGA Chip Picker/Electronic Component Catch/…/Manicure Cotton Ball Claw" → tırnak |
| K6 | **Genel kelime kuralı mevcut ürün türünü eziyor.** "mouse pad" kuralı oyun matını da yakalıyor; "travel bag" evcil hayvan çantasını valiz yapıyor. | "TCG Playmat" → klavye/mouse; "Pet Bag Cat Sling" → valiz |
| K7 | **Yaprak ad ile üst ad çelişkisi:** "Hair Extensions & Wigs > Hair Tools & Accessories" içindeki "Tools" el aleti sayılıyor (ek bulgu, ayrıca 2 üründe yanlış) | "Hair Extension Plier" → el aletleri |

Güven puanı bu hataların hiçbirini ayırt etmiyordu: yanlışların çoğu güven 85–90 ile yazılmıştı (K1/K2/K3).

## 3. Kararlar (kural sürümü 4)

Hiçbir kural ürün kimliğine ya da tek ürüne bağlı değildir; her biri bir kök nedeni genel olarak giderir.

1. **Parça numarası işareti (K1).** `has_part_number`: "part number/part no/P/N/OEM part" ifadesi ya da ≥8
   rakamlı kod ("99155219401", "76622-60170"). Kaynak dalı başlıkla **desteklenmiyorsa** ve bu işaret
   varsa: tüketici dallarında (bebek, moda, kozmetik…; `oto-bahce`, `elektronik`, `yapi-market` dışı)
   inceleme (`part_number_conflict`). Araç **türü** söyleyen dallarda (motosiklet, tekne) tür başlıkla
   desteklenmiyorsa yine inceleme: parça numarası otomobil mi motosiklet mi olduğunu kanıtlamaz
   (başlıkta "Genuine OEM … Mud Flap", motosiklet sözcüğü yok). Başlık kaynağı destekliyorsa
   ("Motorcycle … OEM Part Number") işaret inceleme gerektirmez.
2. **Eksik dallar (K2/K3/K6), migration 0094, yalnızca ekleme:** `oto-bahce/tekne-deniz` (Tekne ve Deniz
   Araçları), `saglik-kozmetik/kisisel-bakim/banyo-vucut` (Banyo ve Vücut Bakımı),
   `kitap-muzik-hobi/masa-kart-oyunlari` (Masa ve Kart Oyunları). Kanıt: örnekte "Boats" kovası 5/5,
   "Bath & Shower" kovası 6 üründe (dus jeli, lif, banyo fırçası) ve oyun matı bu dallar olmadan yanlış
   yere düşüyordu. Kaynak eşlemesi: "Boats" → tekne, "Bath & Shower" → banyo ve vücut.
3. **Ürün türü adı koku sıfatını ezer (K3).** Parfüm kuralından hariç tutulanlar: duş jeli, sabun, losyon,
   şampuan… ve ambalaj/parça (damlalık, atomizer, pompa başlığı, boş şişe). Ambalaj ifadeleri ayrıca
   `cue` (yalnızca çelişki ölçer): parfüm kovasında başlık bunu desteklemiyorsa inceleme. Hijyen
   ürünleri (ter pedi, koltuk altı pedi) kişisel bakım kuralında.
4. **Cinsiyet çelişkisi (K4).** (a) Başlık yalnızca bir cinsiyeti söylüyorsa ("Men's … Dress") karşı
   cinsiyet dalı aday olamaz (iki cinsiyet de geçiyorsa hiçbiri elenmez). (b) Kaynak yolunun cinsiyeti
   (`source_gender`; "Men's Clothing > …") eşlemede kaybolduğu için karara ayrı taşınır
   (`SourceVerdict.gender`); başlık karşı cinsiyeti söylüyorsa `gender_conflict` (onaylı eşleme dahil).
5. **Başlığın başı/sonu (K5).** Kaynağı yalnızca son %25'teki **tek kelime** destekliyor, ilk %40'ta
   **ana kategoride ayrı, çok kelimeli** (≥2) daha uzun bir ifade başka alanı söylüyorsa kaynak
   desteği sayılmaz. Kısa başlık (<12 kelime), aynı ana dal içindeki kardeş dal ve tek kelimelik yabancı
   kanıt yığın sayılmaz. Bilerek dar tutuldu: ilk denemedeki geniş sürüm (konum eşiği 0,6, tek kelime
   dahil) "Gym/Yoga … Fitness bag" ve "Embroidery … Men's Robe" gibi doğru atamaları da inceleme yaptı
   ve **geri alındı**.
6. **Ürün türü kuralları (K6).** `mouse pad` kuralı oyun matı/kart oyunu ifadelerini hariç tutar; kart
   oyunu/oyun matı yeni dala; `valiz` kuralı evcil hayvan ifadelerini hariç tutar, evcil hayvan çantası
   ("pet bag/sling/backpack") petshop'a. ("Cat Moon" baskılı spor çantası evcil ürün sayılmaz: yalnız
   `pet`, `puppy`, `köpek`, `evcil` hariç tutar.)
7. **Yaprak/ata çelişkisi (K7).** Yaprak bölüm, üstündeki **özel** (derinlik ≥2, güveni yapraktan
   düşük olmayan) bölümle **başka ana kategoride** çelişiyorsa yaprak yok sayılır ve ata sonucu ZAYIF
   (−15) kalır: başlık doğrulamadıkça yazılmaz. Ata yalnızca genel bölüm adıysa ("Home & Garden >
   Pet Products") yaprak kazanır (testle sabitlendi). 47 bilinen kaynak yolunda yalnızca 3'ü etkilendi;
   üçü de bu kararın düzelttiği vakalar.

**v2/v3 kazanımları korunur:** `classify_prevented_errors.json` (71 yanlış atama), `classify_regression.json`,
iç içe ifade önceliği, onaylı eşleme önceliği, parça kaynağı cihaza eşlenmez, mevcut/yönetici değeri
korunur — hepsi değişmeden geçer. "Kategori bulunamazsa inceleme" ilkesi güçlendi: yeni kararların
hiçbiri yeni bir kategori **uydurmaz**; belirsizlikte inceleme.

## 4. Ölçüm

**Dürüstlük notu.** (a) 196'lık örnek bu hataları **bulmak için** kullanıldı; kurallar ona göre
ayarlandı, yani bağımsız ölçüm değildir. (b) Hiçbir etiket insan etiketi değildir; aşağıdaki "yanlış"
sayıları geliştiricinin (model) yargısıdır, **precision iddiası değildir.** (c) Bağımsız karşılaştırma
için ayar sırasında bakılmamış, depodaki 216 satırlık etiketli kümeye (0139) bakıldı.

**196 örnek (v3 → v4, aynı satırlar):**

| | v3 | v4 |
| --- | --- | --- |
| Yazılan (kapsama) | 146 (%74,5) | 140 (%71,4) |
| İnceleme | 50 | 56 (+`part_number_conflict` 4, `source_cue_conflict` +3, `gender_conflict` 1) |
| Değişen satır | — | 37 |

Değişen 37 satırda (başka satır değişmedi): v3'ün **yanlış** yazdığı 21 ürün (kullanıcının
işaretlediği 10 + parfüm ambalajı 4 + tekne/jet ski 4 + saç düzleştirme tarağı 1 + saç uzatma pensi 2)
v4'te **0 kesin yanlış**, 1 belirsiz (duş jeli+şampuan: "banyo ve vücut" mu "saç bakımı" mı).
Doğru olup incelemeye düşen 2 ürün (kadın elbisesi "Men's" kovasında; ATV mafsalı OEM kodlu); incelemeden
yeni yazılan 5 ürün makul (banyo fırçası/lif, tekne römorku/ışığı, peruk aksesuarı). Yani **yanlış yazma düştü, kapsama %3,1 puan düştü**. Değişmeyen satırlarda
bilinen hatalar duruyor (aşağıda §6); tam precision hesaplanamaz.

**Bağımsız küme (216 etiketli satır, model etiketi, 0139):** v3 ve v4 **birebir aynı** (kesin 99, kaba 20,
yanlış 20, kaçan 71, kapsama %64,35). Yani yeni kurallar bu kümede ne iyileştirme ne zarar getirdi;
v4'ün hedeflediği kovalar (bebek arabası, tekne, banyo, oyun matı) bu kümede yok. **Bu, "genel doğruluk
arttı" kanıtı değildir.**

**Kaynak eşleme etkisi:** bilinen 47 kaynak yolunda 3 değişiklik: "Bath & Shower", "Hair Tools &
Accessories", "Boats". Başka kaynak kararı değişmedi.

## 5. Performans

Karar hızı (aynı 412 başlık, saf Python, bu makine): v3 4.593/sn → v4 3.903/sn (~%15 yavaş: konum/ifade
uzunluğu izleme, parça numarası ve cinsiyet kontrolü, 3 yeni kural). 2,77 M ürün için karar hesabı
~12 dk CPU; üretimde sınır hâlâ veritabanı yazımı ve WAL (0134): toplam süre bu farktan değil
yazımdan belirlenir. Bellek: üç yeni kural + ~60 ifade (ihmal edilebilir).
`lru_cache(8192)` yalnızca kaynak yolu cinsiyeti için (yol başına bir kez).

## 6. Bilinen sınırlar (v4'te çözülmedi)

- Başlığı olmayan tek kelimelik yabancı kanıt ve kısa başlıklar için yığın kuralı devreye girmez
  (bilerek; yanlış inceleme maliyeti ölçüldü).
- Marka alanı bu PR'ın konusu değil: marka/uyumluluk ayrımı değişmedi (`brands.py` dokunulmadı).
- Örnekte kalan şüpheli atamalar: "Floppy Drive Emulator for YAMAHA KORG … Electronic keyboard" →
  klavye/mouse (müzik klavyesi); "Wooden Suitcase Storage Box" → valiz (kaynak "Luggage"); saç kesme
  pelerini → saç bakımı. Genel çözüm değil marka/ürün listesi gerektirir; insan etiketi öncesi
  kural eklenmedi (aşırı uyum riski).
- "Men's Clothing" kovasına konmuş **kadın** elbisesi artık incelemede: başlık ve kaynak çelişkisinde
  başlığı otomatik tercih etmiyoruz (0138 ilkesi: başlık tek başına kategoriyi değiştirmez).
- Karar 0139 §7 kapısı (insan etiketli ≥300 satır, alt sınır ≥%80) **değişmedi** ve hâlâ karşılanmadı.

## 7. Migration ve geri alma

`0094_category_taxonomy_v4.sql`: yalnızca INSERT, yol varsa atlanır, ebeveyn yoksa NOTICE (0089/0091
kalıbı), `kind: data`. Üretimde henüz hiçbir ürün bu yollara bağlı değil (sınıflandırma çalışmadı),
geri alma:

```sql
DELETE FROM category c WHERE c.path IN (
  'oto-bahce/tekne-deniz','saglik-kozmetik/kisisel-bakim/banyo-vucut',
  'kitap-muzik-hobi/masa-kart-oyunlari')
  AND NOT EXISTS (SELECT 1 FROM product p WHERE p.category_id = c.id)
  AND NOT EXISTS (SELECT 1 FROM category_source_map m WHERE m.category_id = c.id);
```

`RULE_VERSION` 3 → 4: kontrol noktası `(rule_version, scope)` anahtarlı olduğundan v3'ün (hiç
çalışmamış) kontrol noktasına dokunmaz; `--rescan` gerekmez. Lexicon yüzeyleri (`tekne`, `duş jeli`,
`kutu oyunu`…) yalnızca `classify lexicon --apply` ile yazılır (kapsam yeterliyken); TS fixture
güncellendi.

**Dağıtım sırası:** (1) PR birleşir → otomatik dağıtım migration 0094'ü uygular (yalnızca ekleme);
(2) üretim kontrolü `classify status` (`rule_version` 4, kontrol noktası yok); (3) karar 0139 §7 aşama 0
(insan etiketi) **bu kurallarla** yeniden örneklenir; pilot ondan sonra. Sınıflandırma hiçbir
zamanlayıcıda yok, kendiliğinden çalışmaz.

## Reddedilen alternatifler

| Alternatif | Neden değil |
| --- | --- |
| 10 ürün için ID/başlık özel kuralı | Aşırı uyum; K1–K7 genel nedenlerdir (testler farklı başlıklarla genellemeyi sınar) |
| Parça numaralı her başlığı incelemeye yollamak | Oto/elektronik/yapı marketinde doğal; yalnızca tüketici dallarında ve araç-türü dallarında |
| Kaynak yolu güveni 90 → 70 (hepsi zayıf) | Kapsama çöker; hata niş yaprakta değil desteksiz+çelişen kanıtta |
| Başlık kategoriyi kaynağın üstüne yazsın | 0138 ölçümü: bu kararların yarısı yanlıştı |
| Konum eşiğini geniş tutmak (0,6) | Doğru atamaları incelemeye düşürdü (§3.5) |
| Marka listesiyle "Yamaha/Korg = müzik" gibi kural | Aşırı uyum; insan etiketi bekleniyor |
| Model çağrısı | Kural 1/3 |
