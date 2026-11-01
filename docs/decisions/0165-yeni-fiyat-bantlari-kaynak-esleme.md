# 0165 — Yeni fiyat bantlarının kaynak yollarını üst kategori haritasına eklemek

Durum: kabul edildi (1 Kasım 2026). `source_bridge.tsv` ve `source_parent_map.tsv` 275 → **403** kaynak
yoluna çıkar. Yöntem karar 0157'dir; **kural, eşik ve yazma mekanizması değişmez**. Üretime hiçbir şey
yazılmadı; sayılar salt okunur oturumda ölçüldü.

## Bağlam

Karar 0157 haritası yalnızca "10–25$" bandının 275 kaynak yolunu kapsıyordu. Admitad AliExpress
programı fiyat bandına göre bölünmüş beslemeler sunuyor; "до 10$" bandı (feed 14) içe aktarıldı ve yeni
kaynak yolları getirdi. `classify parents-report` (1 Kasım 2026) 10.029.608 kategorisiz ürünün
**2.898.488'ini `unknown`** (kaynak yolu haritada yok) saydı. `parents` komutu `unknown` ürüne
hiçbir şey yazmaz; yani yeni bantların ürünleri güvenli üst kategori kanıtı olduğu hâlde kategorisiz
kalıyordu. Üretimde 128 yeni kaynak yolu vardı (`offer.category_raw`, 2.924.510 teklif).

## Karar

1. **128 yeni yol, karar 0157'nin yöntemiyle eklenir:** her yol için Trendyol bölgeleri
   (`source_bridge.tsv`), bölgelerden türeyen durum (`source_parent_map.tsv`):
   - Bölgeler tek yolda ya da aynı kökte ise ortak ata → **`yuksek`** (kabul edilen alt kategori
     üstün dışına çıkamaz; test bunu denetler).
   - Bölgeler farklı köklere yayılıyorsa → **`inceleme`**; ortak üst uydurulmaz, `aday_yolu` yalnızca ipucudur.
   - Ağaçta karşılığı yoksa → **`eslesmedi`**. Elektronik komponent/devre/üretim makinesi (Electronics
     Stocks, Active/Passive Components, EL Products, Electronics Production Machinery, Electronic Data
     Systems) için Trendyol ağacında düğüm yok (`komponent`, `devre`, `direnc` aramaları 0 sonuç); kategori uydurulmaz.
2. **Sonuç:** 102 `yuksek`, 20 `inceleme`, 6 `eslesmedi`. Harita toplamı 304 / 83 / 16 (403).
3. **Aydınlatma** (`Indoor Lighting`, `LED Lighting`, `Lighting Bulbs & Tubes`, `Night Lights`) Trendyol'da
   `ev-mobilya/mobilya/elektrik-aydinlatma` altındadır ve oraya eşlenir. Açık hava, taşınabilir, tatil
   ışığı ve aksesuarları iki kökü kapsadığı için `inceleme`dir. Aynı L1'in karar 0157'deki "akıllı ev" eşlemeleri
   değiştirilmedi.
4. **Hiçbir yazma mekanizması değişmedi:** `parents` yalnızca `yuksek` satırı yazar, yalnızca
   `category_id IS NULL` ürüne, geri alınabilir (`parents-undo`), karar 0161'in tüm sınırlarıyla.
   Bu karar yalnızca **haritanın kapsamını** büyütür.
5. **Önceden taranmış ürünler:** `parents` imleci ürün kimliğiyledir. Yeni yolları `unknown` görüp
   geçen ürünler imlecin gerisinde kalır; dağıtımdan sonra bir kez `parents --confirm --rescan` gerekir
   (idempotent: yalnızca hâlâ `NULL` olan ürünlere yazar).
6. **Harita sürümü değişir** (`source_map_version`): `classify suggest finalize` koşusu 403 yolluk
   haritayla yeniden başlatılmalıdır; eski haritayla başlamış yarım koşu devam edemez (karar 0157'deki koruma).

## Ölçüm (salt okunur, ürün bazında, 1 Kasım 2026)

2.898.488 `unknown` ürün, yeni 128 yolun durumuna göre:

| Yeni yol durumu | Ürün | Kategorisiz |
| --- | --- | --- |
| `yuksek` (üst kategori yazılır) | 2.398.956 (taslak 2.398.928, yayında 28) | 2.398.956 |
| `inceleme` | 368.388 | 368.388 |
| `eslesmedi` | 131.144 | 131.144 |

- Yeni yolların **%82,8'i** (ürün) güvenilir üst kategori alır.
- Genel kapsama: önceden `parent` 5.436.740 + yeni 2.398.956 = **7.835.696 / 10.029.608 = %78,1**
  kategorisiz ürün üst kategori alabilir (önceki: %54,2). Kalan: 1.622.650 + 368.388 `inceleme`,
  71.730 + 131.144 `eslesmedi`.

## Kalite uyarısı (dürüst sınırlar)

- Eşlemeler **AI/yöntem önerisidir**; insan doğrulaması değildir (karar 0139 §7 ve 0161'deki açık onay
  koşulları geçerli). Karar 0157'nin ölçümü (400 ürün, AI etiketi, örnek içi → iyimser) kaynak üst
  kategorisinde %81,8 doğru buldu; **yeni 128 yol için ayrı bir doğruluk ölçümü yapılmadı**. %81,8'i bu
  yollara aktarmak varsayımdır, kanıt değildir.
- Yanlışların başlıca nedeni satıcının ürünü yanlış AliExpress kategorisine koymasıdır; bu kaynak
  verisinin sınırıdır, harita bunu düzeltmez.
- Geniş eşlemeler (kök düzeyinde `giyim`, `ev-mobilya`, `elektronik`) bilinçlidir: ürün yanlış alt dala
  değil, doğru köke gider. Dar tek bölgeli yollar (`bahce`, `elektrikli-el-aletleri`, `aksesuar/canta/cuzdan`)
  satıcı hatasına daha duyarlıdır.
- Alt kategori yazılmaz (karar 0157: ~%56 yanlış).

## Reddedilen alternatifler

- **Yeni yolları otomatik `yuksek` yapmak (bölgesi olmayan veya çok köklü yollar dahil):** kategori
  uydurmak olurdu; `inceleme`/`eslesmedi` bilerek korunur.
- **Elektronik komponentleri `elektronik` köküne atmak:** ağaçta komponent dalı yok; kök kategori anlamsız
  (telefon, bilgisayar ve beyaz eşya ile karışır). `eslesmedi` daha dürüst.
- **Haritayı veritabanı tablosuna taşımak:** gereksiz mimari değişiklik; dosya + test yeterli (karar 0157).
