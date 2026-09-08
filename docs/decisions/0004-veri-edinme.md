# 0004 — Üç katmanlı veri edinme, sorgu anında kazıma yok

**Tarih:** 2026-09 · **Durum:** kabul edildi

## Karar

Katman 1: feed, API, affiliate ağı (omurga).
Katman 2: kullanıcı tetikli tek URL çözümleme, sonuç kalıcı olarak kataloğa yazılır.
Katman 3: yoktur. Toplu kazıma altyapıya girmez.

## Gerekçe

Ürün "benzerini bul" diyor; benzerini bulmak için içinde arama yapılacak bir
katalog gerekiyor. Kazıma sadece bilinen bir URL'yi getirir, corpus içinde
arama problemini çözmez.

Ayrıca sorgu anında canlı kazıma 3 saniyelik hedefi tutturamaz, hızla
bloklanır, birim ekonomisini tek başına bozar ve affiliate programlarından
çıkarılma sebebidir.

## Sonucu

- `offer.discovery_source` alanı hangi yoldan geldiğini kaydeder.
- Katalog talebe göre büyür: insanların gerçekten karşılaştırdığı ürünler
  indekslenir, bütün internet değil.
- Katman 2'de `robots.txt` dinlenir, önce schema.org verisi denenir.
