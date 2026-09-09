# 0019 — Ürün sayfası fiyat grafiği: `price_point`'e sınırlı sorgu istisnası

**Tarih:** 2026-09 · **Durum:** kabul edildi

## Karar

`docs/architecture.md` §3b'nin "İstek yolu fiyat geçmişini asla taramaz,
sadece bu tabloyu okur" kuralına tek bir istisna eklenir: ürün sayfasının
fiyat grafiği, tek bir ürünün tekliflerine sınırlı, 90 günlük, tam indeksli
bir `price_point` sorgusuyla doldurulur (`offer_product_idx` +
`price_point_offer_time_idx`, `EXPLAIN` ile sıralı tarama olmadığı
doğrulanmış).

## Gerekçe

D3'ün ("Ürün sayfası") kabul kriteri açıkça "fiyat grafiği görünüyor"
diyor. `product_price_stats` yalnızca skaler değerler tutuyor
(`min30d/min90d/max90d/median90d`) — günlük bir seri yok, hiçbir tabloda
da yok. Grafik olmadan bu görev bitmiş sayılamaz.

Doğru uzun vadeli çözüm — `services/ingest`'te gece hesaplanan bir
günlük-seri tablosu (`product_price_daily` gibi) — yeni bir Python işi ve
yeni bir migration gerektirir; ikisi de bu görevin kapsamı dışında.

Kuralın asıl amacı katalog geneli veya sıralama/filtreleme amaçlı
tekrarlanan taramaları önlemektir (`search()`'ün zaten `product_price_stats`
okuduğu gibi). Tek bir ürün sayfası yüklemesinde, tek ürüne, 90 güne ve
indekslere sınırlı bir okuma bu riski taşımıyor — canlı `EXPLAIN (COSTS
OFF)` ile doğrulandı: `offer` üzerinde `offer_product_idx` ile bitmap heap
scan, her partition için `price_point_offer_time_idx` ile index scan,
hiçbir sequential scan yok.

## Reddedilen alternatifler

- **Yalnızca `product_price_stats`'ın 4 skaler noktasından kaba bir çizgi
  çizmek** (min90d → median90d → güncel fiyat → max90d). Kurala tam uyar,
  yeni sorgu gerektirmez — ama gerçek bir fiyat geçmişi grafiği değil,
  dört noktalı bir özet çubuğu olurdu. Kullanıcı gerçek günlük grafiği
  tercih etti.
- **Grafiği bu görevde hiç yapmamak**, ayrı bir günlük-seri tablosu
  gelene kadar ertelemek. D3'ün kendi kabul kriteriyle doğrudan çelişir.

## Sonucu

- `packages/core/src/product/get-price-history.ts`, `price_point` JOIN
  `offer` WHERE `offer.product_id = $1 AND observed_at >= now() -
  interval '90 days'`, günlük `MIN(price)` ile gruplanır.
- Bu, `packages/core` içinde `price_point`'e dokunan **tek** sorgu olarak
  kalır — başka hiçbir yerde (arama, sıralama, filtreleme) bu tabloya
  gidilmez.
