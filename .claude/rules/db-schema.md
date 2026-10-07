---
paths:
  - "packages/db/**"
  - "docs/schema.sql"
---

# Şema ve migration kuralları

- Şemanın tek sahibi `packages/db`. Migration yalnızca burada yazılır.
- Şema değişikliği önce `docs/schema.sql` + migration ile başlar, sonra kod.
- Geriye uyumluluk: önce kolon eklenir, kod dağıtılır, sonra eski kolon
  kaldırılır. Tek adımda kolon silen migration reddedilir.
- `price_point` sadece INSERT; UPDATE/DELETE yazan kod veya trigger reddedilir.
- `(merchant_id, external_id)` unique kısıtı korunur (idempotent toplama).
- Sponsorlu içerik rozeti DB kısıtı ile zorunludur; kısıt gevşetilmez.
- Fiyat kuruş cinsinden tamsayı, zaman `timestamptz` (UTC).
