# 0028 — Katalog görseli ön işleme ve embedding hız sınırı

**Tarih:** 2026-09 · **Durum:** kabul edildi

`0015` sağlayıcıyı, `0016` üretim kurallarını belirledi. Bu dosya ilk gerçek
Jina koşularında ortaya çıkan iki sorunu kapatır: **görsel başına token** ve
**429 ile yaşayan istemci**.

## Ölçülen sorun

Jina `jina-clip-v2` görseli 512 px'lik karolara bölüp **karo başına 4.000
token** yazıyor. Ölçüm (`api_usage.units`, 2026-09-24):

| Kaynak boyutu | Karo | Token |
| --- | --- | --- |
| 1200×1200, 1500×1500 | 3×3 | 36.000 |
| 1200×1800 | 3×4 | 48.000 |
| 1920×2560 | 4×5 | 80.000 |
| 2000×2680 | 4×6 | 96.000 |
| uzun kenarı 512'ye indirilmiş (her biri) | 1 | 4.000 |

Formül `4000 × ⌈w/512⌉ × ⌈h/512⌉` on ölçümün onunda da tuttu. Hesap sınırı
dakikada 100.000 token: tam boy bir Shopify görseli tek başına bütçenin yarısı,
2000×2680'lik tek bir görsel sınırın neredeyse tamamı. Eski varsayılanlar
(8'lik parti, 1/2/4 sn geri çekilme, 4 deneme) sürekli 429 alıyordu.

## Karar

### 1. Görsel, sağlayıcıya gitmeden yerelde küçültülür

`enrich/images.py` — `PREPROCESS_VERSION = "img512-v1"`:

- Baytlar **gerçekten çözülür** (Pillow). Başlıktaki `content-type` artık
  yalnızca ön filtre; `application/octet-stream` da kabul edilir çünkü asıl
  kontrol çözmedir. Çözücü listesi sözleşmeyle aynı: JPEG, PNG, WebP, AVIF.
  GIF/BMP/TIFF/SVG, başlık yalan söylese de reddedilir.
- EXIF yönü uygulanır; en-boy oranı korunur; **uzun kenar ≤ 512**; küçük
  görsel **asla büyütülmez**. Animasyonlu görselde ilk kare.
- Çıktı JPEG (kalite 90); gerçek saydamlık varsa PNG. Tamamen opak alfa JPEG'e
  düşer.
- Bellek korumaları: gövde akış olarak okunur ve 8 MB'yi aştığı anda kesilir
  (`Content-Length` yoksa da); piksel sayısı başlıktan okunur ve 40 MP'yi
  aşarsa **çözülmeden** reddedilir; JPEG'de `draft` ile DCT ölçekleme (tam boy
  bitmap hiç oluşmaz).
- Shopify CDN'inin `?width=` parametresi **kullanılmaz**. Sağlayıcıdan bağımsız
  yol yerel küçültmedir. CDN ipucu indirme bant genişliğini azaltırdı ama
  darboğaz bant genişliği değil token bütçesi; üstelik `image_hash` CDN'in
  kodlayıcısına bağımlı hâle gelirdi.

### 2. Kimlik: hash orijinalin, vektör sürümü ayrı izlenir

`offer.image_hash` **orijinal indirilen baytların** SHA-256'sı olarak kalır
(ön işlenmiş çıktının değil). Hash içeriği tanımlar — "aynı görsel iki
offer'da mı?" — ve ön işleme değişince değişmemelidir.

`embedding.model_version` **`jina-clip-v2` olarak kalır**. Değiştirilseydi
`packages/core/src/search/visual-search.ts` (`model_version = <sorgu modeli>`
filtresi) ve `packages/core/src/embedding/client.ts` (sabit `"jina-clip-v2"`)
birlikte değişmek zorundaydı. Bu kararın dayanağı aşağıdaki ölçüm.

Ön işleme sürümü embedding satırında taşınmaz (kolon yok; migration
istemiyoruz). Bunun yerine:

- `PREPROCESS_VERSION` her koşunun logunda ve CLI raporunda görünür.
- `IMAGE_VECTORS_VALID_FROM` (şimdilik `None`): doluysa bu andan **eski**
  görsel embedding satırları bayat sayılır — `PENDING_OFFERS` onları yeniden
  seçer, yinelemede (`VECTOR_BY_IMAGE_HASH`) kullanılmaz, yazım
  `ON CONFLICT … DO UPDATE … WHERE created_at < valid_from` ile yerinde
  yeniler. `None` iken davranış eskisinin aynısı (`DO NOTHING`). Ön işleme
  **anlamlı** değişirse sürüm artırılır ve bu sabit dağıtım anına (UTC) set
  edilir; eski vektör sessizce kalmaz.
- `api_usage`'a yeni bilgi yazılmadı: tabloda uygun kolon yok (`session_id`
  kullanıcı oturumu anlamı taşıyor), `operation` değiştirmek maliyet raporunu
  böler.

### 3. Hız: 429'dan önce bekleyen bütçe

`enrich/ratelimit.py` — `TokenBudget`:

- Kayan 60 sn pencere, varsayılan **80.000 token/dk**
  (`JINA_TOKENS_PER_MINUTE`). Sınırın %80'i: tahmin hatası ve TypeScript
  istek yolundaki kullanıcı görseli için pay.
- İstek gönderilmeden önce **tahmini** token pencereye yazılır (ön işlenmiş
  boyuttan karo formülü); yanıt gelince `usage.total_tokens` ile düzeltilir.
- Eşzamanlılık 1. Tek başına bütçeyi aşan bir istek pencere boşken geçer
  (aksi hâlde sonsuza kadar beklerdi).
- 429'da `Retry-After` dinlenir (saniye veya HTTP tarihi, en fazla 120 sn),
  yoksa üssel geri çekilme 2/4/8/16 sn (tavan 60). 5xx ve bağlantı hataları da
  tekrar denenir; diğer 4xx denenmez. **En fazla 5 deneme.**
- Başarısız parti koşuyu durdurmaz: o offer'lar embedding'siz kalır,
  `PENDING_OFFERS` sonraki koşuda onları yeniden seçer. Art arda 3 parti
  başarısızsa koşu durur (sağlayıcı çöktü; beklemek boşa).
- Boru hattı **her partiden sonra commit eder**: ödenmiş bir çağrının vektörü
  ve `api_usage` satırı, sonraki bir hatayla geri alınmaz. `api_usage` yalnızca
  başarılı çağrı için yazılır (başarısız çağrı sağlayıcıdan vektör getirmedi).

## Ölçüm: tam boy ile 512 aynı vektör mü?

Aynı görselin tam boy ve ön işlenmiş embedding'i arasındaki kosinüs, 10
bootstrap görseli (3 kare, 7 dikey; derimod, korendy, normod, north-sails,
wraith, flavus, manu-atelier, quzu):

| Karşılaştırma | min | medyan | max |
| --- | --- | --- | --- |
| tam boy ↔ uzun kenar 512 (`img512-v1`), 10 görsel | 0,925 | 0,976 | 0,994 |
| tam boy ↔ CDN `width=512` (önceki 40 vektörün yöntemi), 5 görsel | 0,971 | 0,995 | 0,999 |
| tam boy ↔ kısa kenar 512 / uzun ≤ 1024, 5 dikey görsel | 0,976 | 0,991 | 0,994 |

Kare görsellerde fark ihmal edilebilir (≥ 0,988). Dikey görsellerde uzun
kenarı 512'ye indirmek vektörü daha çok oynatıyor (0,925–0,986).

Sıralama testi: 5 tam boy sorgu, havuz = 5 ön işlenmiş vektör + önceki 40
gerçek vektör. Her iki ön işlemede de **5/5 sorgunun ilk sonucu kendi
görseli**; en yakın başka ürüne fark 0,09–0,36.

**Sonuç:** kosinüs her görselde 0,98'in üstünde değil, ama arama sonucunu
bozan bir fark ölçülmedi. `model_version` değişmedi, `img512-v1` kabul edildi.

## Sonucu

- İlk 50 + 250 gerçek koşuda görsel başına token **4.000** (önceki CDN 512
  koşusu ortalama 6.400; tam boy 36.000–96.000); **0 adet 429**.
- Bütçe 80.000 TPM iken teorik tavan 20 görsel/dk; 250 koşusunda ölçülen **15,5 görsel/dk** (16,7 offer/dk, 896 sn). 3.500'lük bootstrap
  kataloğunun kalan kısmı ~3 saat sürer; hız yükseltmek bütçe işidir, kod değil.
- Pillow bağımlılığı eklendi (`pyproject.toml`).

## Açık kalan / başka klasörün işi

- **Kullanıcı yüklemesi hâlâ tam boy gidiyor** (`packages/core`). 12 MP'lik bir
  telefon fotoğrafı 4000×3000 → 48 karo → ~192.000 token: tek istek hesap
  sınırını aşar ve maliyeti katalog görselinin ~50 katı. TypeScript tarafı
  **aynı ön işlemeyi** (uzun kenar 512, EXIF, büyütme yok) uygularsa hem maliyet
  düşer hem sorgu ile katalog aynı dağılımdan gelir; yukarıdaki kosinüs farkı
  ortadan kalkar. Ayrı bir TS görevi.
- **Görsel URL'i değişen offer.** `collect/writer.py` `image_url`'i güncelliyor
  ama `image_hash`'i sıfırlamıyor; embedding satırı olan offer bir daha
  seçilmediği için vektör eski görselde kalır. Düzeltme toplama tarafında
  (`image_url` değişince `image_hash = NULL`) ve enrich'te o offer'ı bayat
  sayacak bir koşulla yapılmalı.
- Kalıcı olarak alınamayan görsel (404) her koşuda yeniden seçilir ve
  `ORDER BY o.id LIMIT` penceresinde yer kaplar.

## Reddedilen alternatifler

- **Görsel kütüphanesi olmadan (yalnızca başlık okuma).** Küçültme, EXIF ve
  gerçek biçim doğrulaması yapılamaz. Pillow Python'da standart, tekerlekleri
  JPEG/PNG/WebP/AVIF çözücülerini içeriyor; sistem bağımlılığı yok.
- **Kısa kenar 512 (uzun ≤ 1024).** Tam boya daha yakın (dikeyde medyan
  0,991) ama dikey görselde 2 karo, yani 8.000 token. Moda kataloğu
  çoğunlukla dikey; maliyet ve süre ~2 katı. Sıralama testinde fark yok.
  TS tarafı aynı ön işlemeye geçtiğinde bu fark tamamen anlamsızlaşır.
- **Shopify CDN `?width=512`.** Sağlayıcıya ve Shopify'a bağımlı, dikeyde
  yine 2 karo; yalnızca Shopify merchant'larında çalışır.
- **`model_version`'ı `jina-clip-v2@img512-v1` yapmak.** Tek adımda görsel
  aramayı kırar (TS filtresi); ölçüm gerekli olmadığını gösterdi.
- **429 alıp geri çekilmeye devam etmek.** Her 429 bir boşa istek ve öngörülemez
  süre; bütçe baştan uymayı sağlıyor.
