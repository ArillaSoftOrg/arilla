# 0008 — Marka rengi ile arayüz paleti ayrı tutulur

**Tarih:** 2026-09 · **Durum:** kabul edildi

## Karar

Şirket adı Arilla. Marka mavisi logo, pazarlama ve e-posta başlığında
kullanılır; ürün arayüzü nötr palet + tasarruf yeşili ile devam eder.

Mevcut logo geçici yer tutucudur; üretim öncesi düz ve SVG olarak yeniden
çizilir.

`yusufsari.info` yalnızca geliştirme alan adıdır. Gerçek kullanıcıya çıkmadan
önce Arilla adına alan adı alınır.

## Gerekçe

Arayüzdeki tek vurgu rengi tasarruf tutarıdır; ikinci bir güçlü renk o vurgunun
anlamını böler. Mevcut logo raster, 3B ve gradyanlı olduğu için hem
ölçeklenmiyor hem `design.md` düz yüzey kuralıyla çelişiyor.

`.info` uzantısı e-posta teslimatında düşük itibarlı sayılıyor. Giriş akışı
tamamen e-postaya bağlı olduğundan bu doğrudan ürünü kırar.

## Sonucu

- Marka adı ve alan adı koda gömülmez, yapılandırmadan okunur (ikisi de
  değişecek).
- Font olarak IBM Plex Sans öneriliyor, Inter alternatif. Türkçe ve tabular
  rakam testinden geçmeden hiçbiri kullanılmaz.
