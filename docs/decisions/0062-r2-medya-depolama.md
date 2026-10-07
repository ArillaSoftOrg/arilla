# 0062 - Cloudflare R2 medya deposu

## Karar

Kalıcı medya (blog, ürün, kategori, marka, diğer) Cloudflare R2'de tutulur;
S3 uyumlu API ile erişilir. Erişim tek yerde: `packages/core/src/storage/`.
`object-storage.ts` SDK'yı import eden tek dosyadır; bileşenler
`ObjectStorage` arayüzüne ve `uploadImage` servisine bağlanır.

- Anahtar: `<namespace>/[<scope>/]<sha256 ilk 32 hex>.<webp|avif>`;
  namespace: `blog | products | categories | brands | other`.
- İçerik-adresli: aynı içerik aynı anahtar (dedup, yüklemeden önce `head`),
  nesne değişmez; `Cache-Control: public, max-age=31536000, immutable`.
- Yükleme hattı: gerçek decode ile doğrulama (jpeg/png/webp/avif/heif/gif;
  SVG yok), 10 MB / 50 MP sınırı, EXIF yönü, metadata atılır, en uzun kenar
  <= 2400, büyütme yok, WebP (q82) ya da AVIF (q60).
- Public URL `R2_PUBLIC_BASE_URL` (özel alan adı) üzerinden üretilir; üretimde
  `*.r2.dev` ve http reddedilir. Baz URL tanımlı değilse blog yerel
  yer tutucuya düşer.
- Bu yeni bir üçüncü taraf CDN'i değildir: alan adı bizim, bucket bizim.
  Mevcut `graphassets` dış görselleri bununla değiştirilir.

## Gerekçe

Medya büyüyecek (ürün/kategori/marka); sağlayıcı bağımlılığı tek dosyada,
anahtar yapısı baştan ölçeklenebilir olmalı. `r2.dev` hız sınırlı ve
üretim için önerilmez.

## Reddedilen

- Bileşenlerde doğrudan SDK çağrısı: sağlayıcı değişiminde her yer değişir.
- Rastgele/UUID anahtar: dedup yok, aynı görsel tekrar tekrar yüklenir.
- Şimdi presigned/direct upload: UI yok, gereksiz. Gerekince aynı
  `processImage` + `buildMediaKey` üstüne eklenir (sunucuda doğrulanarak).
