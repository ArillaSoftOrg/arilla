# 0166 — Kaynak bazlı görsel varyantları (ürün kartı netliği)

## Bağlam

AI yanıtında (`/sohbet`) ve aramada ürün kartları aynı `ProductCard` →
`ProductImage` yolundan geçer. Üretim kataloğunda Hepsiburada ürünlerinin
`primary_image_url` değeri küçük resim yolunu taşıyor
(`…/s/{n}/222-222/…jpg`, 2.017 ürünün 1.750'si; 267'si `300-400`). Kart görseli
yaklaşık 190 CSS px olduğundan 222 px'lik dosya DPR 2'de 1,7, DPR 3'te 2,6 kat
büyütülüp bulanık görünüyordu. `ProductImage` düz `<img src>` idi; `srcset` yoktu.
AliExpress görselleri (katalogun ~%99,9'u) zaten 800+ px orijinal.

## Karar

- `packages/ui/src/image-variants.ts`: saf, kaynak bazlı çözümleyici. Katalogdaki
  URL **değiştirilmez**; varyant çizim anında türetilir.
- Yalnızca **doğrulanmış** biçim: `https://productimages.hepsiburada.net/s/{n}/{W}-{H}/{id}.{jpg|jpeg|png|webp}`
  (sorgu yok, genişlik < 600). Aynı yolda `W-H` değiştirilir, oran korunur;
  genişlikler 300/450/680/1000 (gerçek CDN'de 200 döndü; çok büyük boyut 400
  döner, bu yüzden üst sınır 1000). Taninmayan her URL için `null` → olduğu gibi.
- `ProductImage` `sizes` alır; varyant varsa `srcset` + `sizes`, yoksa tek orta
  boyut (450). `ProductCard` ve ürün galerisi `sizes` verir.
- Varyant yüklenemezse `VariantImage` (istemci, `FallbackImage` ile aynı desen,
  karar 0077) bir kez orijinal URL'ye düşer; orijinal de kırıksa mevcut `--surface` kutusu.
- Varyant da orijinal de yüklenemezse (ya da hiçbir kaynakta görsel yüklenmezse) boş kutu
  yerine aynı `--surface` kutusunda `ImageIcon` motifi görünür: yalnızca CSS
  (`ProductImage.module.css` `::after`, maske + `--ink-muted` belirteci, yeni bileşen/ikon
  yok; `data:` CSP `img-src`de izinli). Yalnızca kırık görselde çizilir, dekoratiftir
  (`alt` ve erişilebilirlik ağacı değişmez). Safari kırık `<img>`te pseudo-öğe çizmez; orada
  önceki düz kutu kalır.
- AliExpress ve diğer kaynaklarda **dönüşüm yok**. `_640x640.jpg` eki 3 örnekte
  çalıştı ama bütün katalog için doğrulanmadı; ayrı bir kararla ele alınır.

## Gerekçe

Veri taşıma, migration, yeni servis, CDN ya da proxy gerektirmez; kural 14 ve
"kayıtlı URL'ler değişmez" sınırı korunur. Görsel hâlâ mağaza CDN'inden hotlink
(yeni üçüncü taraf yok). Tek bileşen olduğu için AI yanıtı, `/ara` ve diğer
kartlar tutarlı olur.

## Reddedilen alternatifler

- `next/image` ya da kendi görsel proxy'miz: dönüştürme maliyeti (Vercel/sunucu)
  ve yeni bağımlılık; mağaza CDN'i zaten istenen boyutu veriyor.
- Katalogdaki URL'leri toplu yeniden yazmak: geri alınması zor, toplu işlem,
  üretim verisi değişikliği.
- Tüm kataloğa AliExpress eki dönüşümü: mevcut kalite yeterli, doğrulama kapsamı dar.

## Sonuçlar ve açık riskler

- Hepsiburada kart görseli ~5–8 KB → ~14–26 KB (DPR'a göre 300/450/680).
- Görsel yolu şeması mağaza tarafından değişirse çözümleyici `null` döner veya
  varyant 4xx verir; ikisinde de orijinal URL gösterilir.
- Mağaza CDN'inin görsel kullanım şartları ayrıca hukuken gözden geçirilmedi.
- İleride: `offer_image.width/height` doldurulması ve ingest'te büyük görseli
  tercih etme (bu karar kapsamında değil).
