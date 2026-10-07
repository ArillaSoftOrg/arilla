---
paths:
  - "apps/web/**"
  - "apps/mcp/**"
  - "packages/ui/**"
---

# Arayüz kuralları

## Tema ve tipografi

- Varsayılan açık tema; cihaz tercihi koyuysa koyu. İki tema da tanımlı olmalı.
- Renk belirteçleri `docs/design.md` içinde; hiçbir renk kod içine gömülmez.
- Font IBM Plex Sans, **depodan servis edilir**. Google Fonts veya başka bir
  üçüncü taraf CDN'inden font, ikon veya betik çekilmez — kullanıcı IP'sini yurt
  dışına aktarır. Bkz. `docs/decisions/0009-font.md`.

## Akış ve rota kuralları

- `localStorage` / `sessionStorage` olmadan çalışamayan akış kurulmaz.
- SEO rotalarında giriş modali gösterilmez. Bkz. `docs/decisions/0002`.
- Trend sayfaları günlük değişmez; günlük rotasyon yalnızca `/kesfet` içindir.
- `public_find.source` ayrımı (seçilmiş vs. kullanıcı keşfi) arayüzde korunur.
- Sponsorlu içerik rozeti arayüzde gizlenemez.
- Merchant'a giden her link `click` attribution kaydından geçer.
- Analitik olay adları yalnızca `docs/events.md` içindekilerdir; yükte kişisel veri yok.

## Metin

- ALL CAPS yok: Türkçede büyük harf dönüşümü i/ı ve I/İ nedeniyle bozulur.
- "Satın al", "dupe", "ucuz" geçmez; karşılıkları `docs/glossary.md`, metinler `docs/copy.md`.
