# 0142 — Sınıflandırma v5: karışık kaynak kovaları, aksesuarın ana ürünü, spor/seyahat çantası

**Tarih:** 22 Ekim 2026
**Durum:** Önerildi (PR). Birleştirme, dağıtım ve üretimde sınıflandırma çalıştırma kullanıcı onayına
bağlıdır; üretim verisine dokunulmadı. Migration 0095.
**İlişkili:** 0133, 0138 (v2), 0139 (v3), 0141 (v4)

## 1. Girdi ve yöntem

Üretimden ikinci bağımsız örnek: 189 ürün (31 kaynak yolu; v4 ile 130 kategori önerisi). Önce v4
koduyla yeniden üretildi: **189/189 karar örnekteki ile aynı.** 196'lık v4 örneğiyle yalnızca 2 ürün
ortak.

**Aşırı uyumu önlemek için örnek ikiye bölündü** (`crc32("v5:" + id) % 2`, kullanıcının bildirdiği 8
hata zorunlu olarak geliştirme yarısında):

- **Geliştirme yarısı (107):** hatalar buradan çıkarıldı, kurallar buna göre yazıldı.
- **Holdout yarısı (82):** kurallar bitene kadar başlığına ve sonucuna **bakılmadı**; bir kez ölçüldü,
  ölçümden sonra kural değiştirilmedi.

Ek regresyon kümeleri: 196'lık v4 örneği (v5 geliştirmesinde kullanılmadı) ve depodaki 216 satırlık
model-etiketli küme (0139). **İnsan etiketi yok:** "doğru/yanlış" yargıları geliştiricinin (model)
yargısıdır, kesin doğruluk oranı iddia edilmez.

## 2. Kök nedenler (geliştirme yarısında doğrulandı)

| # | Kök neden | Örnek (v4) |
| --- | --- | --- |
| K1 | **Karışık kaynak kovasına aşırı güven.** "Beauty & Health > Fragrances & Deodorants" güven 90 ile parfüm sayılıyor; kova boş şişe, roll-on kabı, difüzör, pisuar koku gidericisi de içeriyor. Başlıkta "perfume" geçmesi ("Perfume Containers") kaynağı "destekliyor". | 509568 pisuar koku gidericisi, 510176 / 505938 boş şişe, 510427 difüzör → parfüm |
| K2 | **Kaynak adı ile dal anlamı farklı; dal eksik.** "Luggage & Bags > Travel Bags" valize eşleniyordu ("travel bag" valiz kuralındaydı). Valiz bavul demek; duffel/spor/plaj/hafta sonu çantası için dal yoktu. | 161066 spor çantası, 149220 plaj çantası → valiz (geliştirme yarısında 5, 196'lıkta 6, holdout'ta 2 ürün) |
| K3 | **Aksesuar dalında ana ürün doğrulanmıyor.** "Baby Strollers & Accessories" kovasındaki ürün bir aksesuar olabilir ama bebek arabasının değil; mama sandalyesi için kural da yoktu. | 40105 / 39644 mama sandalyesi minderi/kılıfı → bebek arabası aksesuarı |

## 3. Kararlar (kural sürümü 5)

Ürün kimliğine ya da tek ürüne bağlı kural yoktur.

1. **Güven = kovanın saflığı (K1).** Karışık koku kovası artık **zayıf kaynak (75)**: eşik altında,
   başlık parfümü kendi kuralıyla doğrulamadıkça yazılmaz. Parfüm kuralı boş kap/roll-on şişesi,
   cam şişe, "container", pisuar/tuvalet, koku giderici ve oda kokusu için eşleşmez; ortam kokusu
   (aroma/reed/oil difüzörü, oda kokusu) `ev-yasam/dekorasyon` kanıtıdır. Gerçek parfüm, kolonya ve
   roll-on **deodorant** başlıkla doğrulanır ve yazılır (testli).
2. **Yeni dal (K2), migration 0095, yalnızca ekleme:** `moda/canta/spor-seyahat-cantasi` (Spor ve
   Seyahat Çantaları). "Travel bag, duffel, gym/sports bag, weekender, holdall" bu dala; valiz kuralı
   yalnızca bavul/valiz/carry-on/trolley ve başlık yığınında "duffel/gym bag/tote" geçiyorsa valiz
   saymaz. "Luggage & Bags > Luggage" valiz olarak kalır (testli).
3. **Aksesuarın ana ürünü (K3).** `ACCESSORY_HOSTS`: kaynak bir ana ürüne bağlı aksesuar dalını
   söylüyorsa (şimdilik yalnızca bebek arabası aksesuarı), başlık ana ürünü ("stroller, pram,
   pushchair, buggy, baby carriage, bebek arabası, puset") ya da dalın kendi kuralını anmalıdır;
   anmıyorsa `accessory_host_missing` → inceleme. Onaylı eşleme muaftır. Mama sandalyesi ("high
   chair") bebek bakımı kanıtıdır; stroller kovasında çelişki üretir. Başka aksesuar dallarına
   genişletme **ölçümsüz yapılmadı.**

**Korunanlar:** v2/v3/v4 regresyon setleri ve 71 önlenmiş hata (`classify_prevented_errors.json`),
0141 vakaları (biri bilinçli güncellendi: "Cat Moon Duffel Bag" artık valiz değil spor/seyahat
çantası), mevcut/yönetici değeri koruması, marka/uyumluluk (`brands.py` dokunulmadı), kontrol
noktası, idempotans, WAL bekçisi (`run.py` dokunulmadı).

## 4. Ölçüm (v4 → v5, aynı satırlar, aynı kod yolu `evaluate.verdict_for`)

| Küme | Rol | n | Yazılan v4 → v5 | Değişen | Değişiklik niteliği (model yargısı) |
| --- | --- | --- | --- | --- | --- |
| 189 geliştirme yarısı | ayar | 107 | 74 → 68 (%69,2 → %63,6) | 11 | 8 bildirilen hata + 3 aynı kökten; 6 yanlış yazma incelemeye, 5 valiz → spor/seyahat; v5'te yeni yanlış yok |
| **189 holdout** | **bağımsız** | 82 | 56 → 56 (%68,3 → %68,3) | 2 | 2 valiz → spor/seyahat (doğru yönde); yeni yanlış ya da kayıp yok |
| 196 (v4 örneği) | regresyon | 196 | 140 → 139 (%71,4 → %70,9) | 7 | 6 valiz → spor/seyahat; 1 "Mommy Bag" stroller aksesuarı → inceleme (ana ürün anılmıyor) |
| 216 etiketli (0139) | regresyon | 216 | 139 → 140 (%64,4 → %64,8) | 1 | araç kokusu (`oto-aksesuar`) artık yazılıyor, etikete göre kesin doğru: kesin 99 → 100, yanlış 20 → 20 |

**Kapsama kaybı** yalnızca geliştirme yarısında (−6 ürün) ve yalnızca v4'ün **yanlış** yazdığı
ürünlerde oldu; holdout ve iki regresyon kümesinde kapsama ±1. Holdout'ta v5'in yazdığı 56 üründe
geliştirici yargısıyla 2–4 şüpheli atama kalıyor (§6); bu bir precision ölçümü değildir.

**Performans:** karar hızı v4 ~8.900/sn, v5 ~8.150–9.150/sn (aynı 405 başlık, iki koşu; fark ölçüm
gürültüsü içinde). Yeni maliyet: kaynak başına bir sözlük bakışı + aksesuar dalında başlıkta ifade
araması.

## 5. Güven puanının anlamı

`category_source_map.confidence` artık kovanın **saflığını** da taşır: karışık kova (koku) 75, yani
"kaynak tek başına yetmez". 0139'daki çöp kovaları ("Measurement & Analysis Instruments" vb.) ile aynı
mekanizma; yeni bir eşik ya da puan ölçeği eklenmedi. Yüksek güven (90) artık yanlış kovayı tek
başına "güvenilir" yapmaz: aksesuar dalında ana ürün, parça numarası (0141), cinsiyet (0141) ve
ürün türü çelişkisi (0138) kontrolleri güvenden bağımsız çalışır.

## 6. Kalan riskler

- İnsan etiketi yok; 0139 §7 kapısı (≥300 insan etiketi, alt sınır ≥%80) hâlâ açık.
- Holdout'ta görülen ama düzeltilmeyen (aşırı uyum riski, ölçüm sonrası kural yazılmadı):
  makyaj çantası/kozmetik kutusu → valiz, RV su filtresi → tekne, anten → bilgisayar,
  peluş sırt çantası → peluş oyuncak.
- `ACCESSORY_HOSTS` yalnızca bebek arabası aksesuarı için açık; telefon/bilgisayar/oyun aksesuarına
  genişletmek ayrı ölçüm ister (başlıkta cihaz adı çoğu zaman model kodudur).
- Spor/seyahat çantası ile el/omuz çantası sınırı başlık yığınlarında bulanık ("Tote Bag ... Travel
  Sport Bag"): yazılan değer ana dal (`moda/canta`) içinde kalır.

## 7. Migration ve geri alma

`0095_category_taxonomy_v5.sql`: `kind: data`, yalnızca INSERT, yol varsa atlanır, ebeveyn yoksa
NOTICE (0089/0091/0094 kalıbı). Numara: 0092/0093 açık PR #201'de, 0094 main'de. Geri alma (ürün
bağlanmadan önce):

```sql
DELETE FROM category c WHERE c.path = 'moda/canta/spor-seyahat-cantasi'
  AND NOT EXISTS (SELECT 1 FROM product p WHERE p.category_id = c.id)
  AND NOT EXISTS (SELECT 1 FROM category_source_map m WHERE m.category_id = c.id);
```

`RULE_VERSION` 4 → 5: kontrol noktası `(rule_version, scope)` anahtarlı; v4'ün kontrol noktası yok
(sınıflandırma çalışmadı). Lexicon yüzeyleri (`spor çantası`, `seyahat çantası`) yalnızca
`classify lexicon --apply` ile yazılır; TS fixture güncellendi.

## Reddedilen alternatifler

| Alternatif | Neden değil |
| --- | --- |
| 8 ürün için kimlik/başlık kuralı | Aşırı uyum; K1–K3 genel nedenlerdir, sentetik vakalar genellemeyi sınar |
| Tüm kaynak eşlemelerinin güvenini düşürmek | Kapsama çöker; sorun karışık kovalar ve aksesuar dalında |
| Her aksesuar dalında ana ürün şartı | Ölçülmedi; telefon/bilgisayar başlıklarında ana ürün çoğu zaman yalnızca model kodudur |
| Holdout hatalarını da kurala çevirmek | Holdout bağımsızlığını bozar; sonraki örnekte ele alınmalı |
| "Travel Bags" kovasını valizde bırakıp başlıkla düzeltmek | Kova adı zaten spor/seyahat çantası; dal eksikliği gerçek |
