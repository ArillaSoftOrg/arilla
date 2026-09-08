# Proje dokümanları

Kod yazmadan önce okunacak sıra:

1. `CLAUDE.md` — çalışma kuralları. Her oturumda okunur.
2. `docs/architecture.md` — katmanlar ve sınırlar
3. `docs/schema.sql` — veri modeli. Mimarinin geri alınamaz kısmı.
4. `docs/search.md` — sorgu nesnesi, ayrıştırıcı, sıralama
5. `docs/routes.md` — URL yapısı ve sitemap
6. `docs/sitemap.md` — sitemap yapısı ve indeksleme kuralları
7. `docs/design.md` — tema, bileşenler, metin kuralları
8. `docs/brand.md` — isim, alan adı, logo, tipografi
9. `docs/kvkk.md` — hukuki uyum ve veri saklama
10. `docs/ops.md` — ortamlar, yedekleme, izleme, dağıtım
11. `docs/events.md` — analitik olay sözlüğü
12. `docs/glossary.md` — terim karşılıkları
13. `docs/pages.md` — sayfa sayfa içerik dökümü
14. `docs/copy.md` — Türkçe metin bankası
15. `docs/mcp.md` — MCP araç sözleşmesi
16. `docs/backlog.md` — sıralı görev listesi
17. `docs/decisions/` — alınmış mimari kararlar ve gerekçeleri

Bir kural değişecekse önce ilgili doküman güncellenir, sonra kod yazılır.
Yeni bir mimari karar alındığında `docs/decisions/` altına kısa bir dosya
eklenir: karar, gerekçe, reddedilen alternatif.
