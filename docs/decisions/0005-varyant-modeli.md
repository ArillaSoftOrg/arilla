# 0005 — Renk ürün düzeyinde, beden varyant düzeyinde

**Tarih:** 2026-09 · **Durum:** kabul edildi

## Karar

`product` renk düzeyinde kanoniktir. Beden `offer_variant` tablosunda tutulur.
Fiyat geçmişi `offer` düzeyinde kalır, varyant düzeyine inmez.

## Gerekçe

Bu bir görsel arama ürünü. Kullanıcı siyah çanta fotoğrafı yüklediğinde bej
olanı "aynı ürün" diye göstermek yanlış sonuçtur. Türk moda feed'lerinde renk
zaten ayrı ürün sayfası olarak geliyor, model gerçeğe uyuyor. Aynı modelin
renkleri `model_key` ile bağlanır.

Beden ayrı satır olmalı çünkü stok bedene göre değişir ve "senin bedenin var
mı" sorusu modada satın alma kararının kendisidir.

Fiyat geçmişi varyant düzeyine inseydi 10 bedenli bir ayakkabı `price_point`
tablosunu on katına çıkarırdı; karşılığında Türkiye'de neredeyse hiç
görülmeyen bedenler arası fiyat farkı kazanılırdı. Nadir istisna için
`offer_variant.price_override` yeterli.

## Geri dönüş

Beden bazlı fiyat farkı yaygınlaşırsa `variant_price_point` tablosu eklenir,
mevcut veri bozulmaz.
