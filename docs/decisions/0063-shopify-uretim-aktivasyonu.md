# 0063 — Shopify merchant'larının üretimde aktivasyonu

**Tarih:** 2026-10-06
**Durum:** kabul edildi (1 mağaza canlı toplandı; geri kalanı robots yönlendirmesi nedeniyle bekliyor)

## Karar

`0021`'in para birimini doğruladığı 18 Shopify merchant'ı `0048` migration'ı ile
aktifleştirilir ve `feed_config.transport.shopify.max_products = 3500`,
`transport.retry.max_retries = 2` yazılır. `0027`'nin "yalnızca yerel veritabanı"
sınırı bu mağazalar için kullanıcı kararıyla kaldırıldı. Kapılar (`0031` para
birimi, `0042` robots) değişmedi. `turkish-finds` (PHP) kapsam dışı.

## Canlı koşu bulguları

- `termos-dunyasi`: başarılı, 564 offer.
- `riva-istanbul`, `yutas-yapi-urunleri`, `halicizade-hali-kilim`,
  `north-sails-turkiye`, `spor-plus`: `myshopify.com/robots.txt` özel alan
  adına 301 verdiği için `refused:robots_unavailable`. Kapı doğru çalışıyor;
  çözüm kapıyı gevşetmek değil, `merchant.domain`/`feed_url`'u gerçek alan adına
  taşıyıp para birimini orada yeniden doğrulamak (ayrı migration).
- `happy-place-home-decor`: 25 dk zaman aşımı; yazma yolu satır satır uzak
  veritabanına gittiği için büyük katalog tek işlemde yetişmedi (geri alındı).

## Reddedilen alternatifler

Yönlendirmeyi izlemek ya da robots denetimini atlamak; `turkish-finds`'i zorla
aktifleştirmek; doğrudan SQL ile aktivasyon.
