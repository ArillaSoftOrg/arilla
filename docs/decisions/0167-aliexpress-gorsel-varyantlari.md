# 0167 — AliExpress görsel varyantları (veri aktarımını azaltma)

## Bağlam

Admitad'dan gelen tek reklamveren AliExpress WW'dir (`admitad:6115`); katalogun ~%99,9'u.
`primary_image_url` ve `offer_image.source_url` AliExpress'in **orijinal** dosyasıdır
(`ae-pic-a1.aliexpress-media.com/kf/<kimlik>.<uzantı>`, boyut eki yok). Kalite sorunu yok:
160 rastgele görselin %98,8'i ≥ 800 px, medyan en uzun kenar ~1000 px, <500 px yalnızca 1/160.
Asıl sorun **ağırlık**: kartta 130–320 CSS px'lik kutu için tam dosya iniyordu (medyan ~45 KB,
en büyük 250–660 KB); ürün galerisinde 62 px'lik küçük resimler bile tam orijinali indiriyordu.

## Karar

- `image-variants.ts` AliExpress için ikinci bir kural alır; Hepsiburada (karar 0166) değişmez.
- Varyant URL'si tam URL'nin sonuna `_{N}x{N}.jpg` eklenerek türetilir. Katalogdaki URL'ye
  dokunulmaz (migration ve toplu işlem yok).
- **Yalnızca doğrulanmış boyutlar:** N ∈ {220, 300, 350, 480, 640, 720, 960, 1200}. Dört farklı
  orijinalde `max(w,h) = min(N, orijinal)` ile doğrulandı. CDN **desteklenmeyen** N için hata
  vermez, sessizce **tam orijinali** döner (400, 560, 1000, 1100, 1600, 1800, 2400, 4000 ölçüldü);
  bu yüzden merdivene yalnızca doğrulananlar girer ve testle desteklenmeyenlerin eklenmediği
  kontrol edilir. 1200 üzeri yeniden boyutlanmaz. (800 de desteklenir ama HTML boyutunu şişirmemek
  için merdivene alınmadı.)
- Yalnızca doğrulanmış URL aileleri: `/kf/{S|H|A}<32 hex><harf>.{jpg|jpeg|png}` ve eski
  `/kf/HTB1<16–40 alfanümerik>.{jpg|jpeg|png}`; sorgu, `http`, başka host, zaten boyutlu URL → dokunulmaz.
- Büyütme yok (CDN orijinalin üstüne çıkmaz); küçük kaynak (ör. 384 px) bugünkü kalitesini korur.
- Mevcut `ProductImage` + `VariantImage` altyapısı: `srcset`/`sizes`, varyant yüklenemezse
  orijinal URL'ye fallback, ikisi de kırıksa nötr kutu + ikon (karar 0166).
- `sizes` değerleri tahminle değil, gerçek Chrome ölçümüyle (aşağıda).

## Bayrak (kapatma mekanizması)

- `IMAGE_VARIANTS_ALIEXPRESS_ENABLED=true`; **varsayılan kapalı**. Mevcut bayrak kalıbı (`*_ENABLED`,
  `packages/core/.../config.ts`, yönetim `config-view`) yeniden kullanıldı; yeni servis yok.
- Yalnızca sunucuda okunur, `NEXT_PUBLIC_` değil: **yeni imaj derlemek gerekmez**, ancak sunucu
  sürecinin yeniden başlatılması gerekir (ortam değişkeni süreç başında okunur). Anlık (yeniden
  başlatmasız) kapatma için DB/Redis tabanlı bir ayar altyapısı gerekir; bugün yok ve eklenmedi.
- Tüketici rotalar (`/ara`, `/sohbet/[id]`, `/urun/[slug]`) `ƒ Dynamic`: bayrak her istekte okunur,
  derleme sırasında gömülmez. İstemci bileşenlerinde ortam okunamayacağından bayrak prop olarak
  iner (SSR ve hidrasyon aynı değeri görür).
- Kapsam şimdilik: `/ara` ve `/sohbet` kartları ile ürün galerisi. Diğer `ProductCard` kullanıcıları
  (`/firsatlar`, `/gecmis` vb.) bayrağı geçirmediği için eskisi gibi kalır (aşamalı açılış).

## Ölçüm (üretim derlemesi, başsız Chrome; örneklem, katalog geneli için kesin sonuç değildir)

Aynı 16 görsellik örnek (12 AliExpress + 4 Hepsiburada), bayrak kapalı → açık, aynı derleme:

| Yüzey | Aktarılan AliExpress verisi |
|---|---|
| Kartlar (`/sohbet`, `/ara`; 6 ekran/DPR kombinasyonu) | 6.115 KB → 1.304 KB (−%79) |
| Ürün galerisi (9 kombinasyon, 3 görsel) | 3.001 KB → 433 KB (−%86) |

- Seçilen varyant gereken pikselin altında kalmadı: 108 görselin 0'ında yetersiz çözünürlük; yeterli
  olan en küçük basamak seçildi (ör. 390 px DPR 3 kartta 441 px gerekir → 480; 1280 px DPR 2'de
  647 px → 720). Bkz. kaynak/ekran tablosu için PR açıklaması.
- Kalite: CDN varyantı ile orijinalden yerel LANCZOS küçültme karşılaştırması PSNR 36–48 dB
  (medyan 40–41 dB, n=10).
- HTML yükü: 16 kartlık sayfada +~27 KB ham, **+~1,3 KB gzip**.
- Hepsiburada: bayrak kapalıyken de açıkken de seçilen varyantlar birebir aynı (regresyon yok).
- Fallback (gerçek Chrome, varyant istekleri ağ katmanında engellendi): 12/12 kart ve galeri
  görseli orijinal URL'den, tam kalitede yüklendi.

## Açma planı (üretim)

1. Birleşme ve dağıtım (bayrak kapalı = davranış değişmez; Hepsiburada zaten açık).
2. Doğrulama: canlı HTML'de (örnek ürün) `srcset`, `currentSrc`, ağ boyutları; fallback oranı.
3. `compose.env`'de bayrak açılır, `web` konteyneri yeniden başlatılır (imaj aynı).
4. Sorun halinde bayrak boşaltılır + yeniden başlatma; veri/URL değişmediği için geri alma güvenli.

## Riskler

- AliExpress CDN boyut listesini değiştirirse: desteklenmeyen N tam orijinali döner (yavaşlama,
  bozulma değil); bayrak kapatılır.
- Admitad/AliExpress program şartlarının görsel kullanımı (boyutlandırma parametresi dahil) ayrıca
  hukuken gözden geçirilmedi; bayrak bu yüzden kapalı gelir.
- `sizes` CSS'e bağlıdır (`ara.module.css`, `sohbet.module.css`, `product-page.module.css`).
  Ürün sayfası düzeni değişirse (ör. galeri iç boşluğu) galeri `sizes` yeniden ölçülmelidir.
- Safari/AVIF olmayan tarayıcılarda bayt sayıları farklı olabilir (ölçülmedi).

## Reddedilen alternatifler

- `next/image` ya da kendi proxy'miz: dönüştürme maliyeti, yeni bağımlılık; CDN boyutları zaten veriyor.
- Katalogdaki URL'leri yeniden yazmak: geri alması zor, toplu işlem, üretim verisi değişikliği.
- Bilinmeyen boyutlar (400/800/1000/1600) için deneme-yanılma: sessizce tam dosya döner.
