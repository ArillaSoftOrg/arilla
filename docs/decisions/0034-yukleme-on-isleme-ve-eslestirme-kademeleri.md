# 0034 — Kullanıcı yüklemesi ön işleme, barkod zenginleştirmesi ve eşleştirme kademeleri

**Tarih:** 2026-09
**Durum:** kabul edildi

## 1. Kullanıcı yüklemesi Jina'ya ön işlenmiş gider

**Sorun.** Katalog görselleri 512 px'e indiriliyordu (0028), fotoğrafla arama
ise ham dosyayı gönderiyordu. 12 MP telefon fotoğrafı ~190 bin token, tek
istekte dakikalık limiti (100 bin) aşar.

**Karar.** Tek sözleşme, runtime başına ayrı uygulama:

- Sözleşme: `packages/core/src/embedding/image-preprocess-contract.json`
  (`img512-v1`: uzun kenar 512, büyütme yok, 40 MP üstü decode öncesi red,
  JPEG q90, gerçek saydamlıkta PNG, izinli biçimler, karo/token formülü).
- TypeScript: `preprocess-image.ts` (sharp; Next.js ile zaten kurulu, yeni
  indirme yok). Python: `enrich/images.py` (Pillow). Python testi
  (`test_enrich_preprocess_contract.py`) sabitlerin sözleşmeyle aynı
  kaldığını doğrular.
- EXIF yönü uygulanır, metadata (EXIF/GPS) çıkarılır, çıktı deterministiktir.
  Görsel yalnızca bellekte işlenir, diske veya depoya yazılmaz.
- Ön işleme günlük hak **harcanmadan önce** yapılır. Decode edilemeyen ya da
  sözleşme dışı görsel hakkı yakmaz, sağlayıcıya gitmez. Kullanıcı durumu
  `unprocessable`, metin "Bu görseli işleyemedik…". Sahte sonuç yok.
- Token koruması: ön işlenmiş görselin tahmini maliyeti tek karoyu
  (4.000 token) aşarsa istek gönderilmez.
- `image_upload.image_hash` artık ön işlenmiş çıktının hash'idir. Çıktı
  deterministik olduğu için aynı fotoğraf aynı anahtarı verir; ön işleme
  sürümü değişirse eski (tam boy) vektör yeniden kullanılmaz.
  `model_version` `jina-clip-v2` kalır; tam boy ile 512 arası kosinüs
  0.925–0.994 ölçüldü (0028), sıralama bozulmadı.

## 2. Barkod zenginleştirmesi

`/products.json` barkod taşımaz; Shopify'ın herkese açık
`/products/<handle>.js` karşılığı her varyant için `barcode` taşır.
`collect/identifiers.py`:

- Yalnızca bootstrap merchant'ları ve yalnızca **birden fazla mağazada
  görülen markaların** offer'ları. Karşı taraf yoksa barkod aranmaz; toplu
  tarama değildir.
- `robots.txt` dinlenir, sıralı, ≤ 0,5 istek/sn, tek deneme; 403/429'da o
  mağaza için durulur.
- Barkod yalnızca GS1 kontrol basamağı doğruysa kabul edilir. Offer (renk
  grubu) birden fazla farklı barkod taşıyorsa (60/100 ml aynı offer'da) tek
  kimlik yoktur, yazılmaz.
- Ağ kullanmadan: kontrol basamağı doğru SKU barkod sayılır (Vionine EAN'ı
  SKU'ya yazıyor).
- Sonuç `offer.attributes_raw.gtin` + `gtin_source`; şema değişmedi. Yeniden
  toplamada korunur (`writer.py`). Ürünlere tek ve tutarlı barkod geri
  doldurulur.

## 3. Eşleştirme özellikleri

- **Ticari çekirdek başlık** (`commercial_title`): 3+ kelimelik parantez
  açıklaması silinir. Boşluklu tireyle bölünür, yalnızca markadan oluşan parça
  atılır, ilk kalan parça çekirdektir. Hacim/beden/renk/kademe tam başlıktan
  çıkarılmaya devam eder; çekirdek yalnızca metin benzerliği içindir. LLM yok.
- **Başlıktan marka**: markasız offer için yalnızca katalogda zaten var olan
  bir marka, başlığın ilk 1–3 kelimesiyle birebir eşleşirse.
- **Renk seçeneğinde hacim** ("100ml") renk sayılmaz.
- **Renk karşılaştırması**: açık renk ifadesinin tüm kelimeleri karşı başlıkta
  geçiyorsa ("Dried Pine" / "… Dried Pine (Haki)") aynı renktir.
- **İki farklı geçerli barkod veto**: aynı modelin farklı hacmi/rengi.
- Aday kanalı başına 30 (Stanley'nin onlarca kardeşi ilk 10'u dolduruyordu).

## 4. Kademeler

| Kademe | Koşul |
|---|---|
| AUTO_ACCEPT | Kesin kimlik (gtin/mpn eşit, veto yok) **ya da** skor ≥ oto eşiği ve marka iki tarafta biliniyor ve aynı ve renk doğrulanabildi |
| REVIEW | Skor ≥ kuyruk eşiği ama AUTO koşulu yok (marka bir tarafta bilinmiyor, renk doğrulanamadı…) |
| REJECT | Veto (renk/hacim/beden/kademe/barkod/marka çatışması) ya da skor < kuyruk eşiği |

Görsel benzerlik tek başına hiçbir kademede yeterli değildir: hibrit skorda da
marka ve metin koşulu aranır.

## Reddedilen alternatifler

- **HTML/JSON-LD sayfası kazımak.** `products/<handle>.js` aynı kaynağın
  yapılandırılmış hali, daha küçük ve robots'a tabi.
- **Tüm katalogda barkod aramak.** Karşı tarafı olmayan offer için istek
  anlamsız ve kazımaya yaklaşır.
- **LLM ile başlık ayıklama.** İstek yolu dışında olsa da deterministik değil;
  kural önce ölçüldü.
- **Kuyruk eşiğini düşürüp geri çağırmayı artırmak.** Kanıtı güçlendirmek
  yerine gürültüyü kuyruğa taşır.
