# 0002 — Kayıt duvarı rota bazlıdır

**Tarih:** 2026-09
**Durum:** kabul edildi (v2 — ilk sürüm duvarı tamamen reddediyordu)

## Karar

Duvar genel bir kural değil, rota bazlı bir politikadır.

- SEO sayfaları (`/urun/`, `/kategori/`, `/alternatif/`, `/trend/`,
  `/firsatlar`) ve creator sayfaları: duvar yok.
- `/ara` üzerindeki metin, sohbet ve görsel arama: ilk 2-3 sorgu serbest,
  sonrasında modal.
- Kaydetme, alarm, geçmiş, beden profili: her zaman hesap gerekir.

## Gerekçe

İlk sürümde duvarı tamamen reddetmiştik. Dupe.com incelemesi gösterdi ki duvar
sohbet aramasından sonra çıkarsa SEO ve creator dağıtımı zarar görmüyor —
çünkü o iki kanal farklı rotalardan geliyor.

Modal sonuçların üstüne gelir, içerik HTML'de kalır. Arama motoru görür,
kullanıcı sürtünmeyi hisseder. Duvar güvenlik değil sürtünmedir.

## Sonucu

- Sorgu sayacı anonim oturumda `session_id` üzerinden tutulur.
- SEO rotalarında modal render edilmez; Google araya girici modalları
  mobilde cezalandırır.
- Modal metni kaydolmayı kazanç olarak sunar, engel olarak değil.

## Reddedilen alternatif

Tüm sonuçları her yerde açık bırakmak. Kayıt oranı gereksiz yere düşük kalırdı.
Tüm sonuçları her yerde kapatmak da reddedildi: iki büyüme kanalını da kırıyor.
