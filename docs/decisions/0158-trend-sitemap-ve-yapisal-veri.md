# 0158 — Trend sayfaları: sitemap ve yapılandırılmış veri

**Tarih:** 30 Ekim 2026
**Durum:** Önerildi (PR). Migration yok.
**İlişkili:** 0077 (trend koleksiyonları), 0147/0149 (elle seçilen trendler), docs/sitemap.md

## Karar

1. **Harita:** trend detay adresleri `/sitemap-sayfalar.xml` içine eklenir; ayrı
   `/sitemaps/trend/` yok (en fazla birkaç düzine adres, yeni uç gerekmez). Ürün kapalıyken
   (P2) hiçbiri girmez; `robots.txt` o durumda `/trendler`i zaten kapatır.
2. **Kim girer:** `/trendler`in gösterdiği her trend: yayında (`status = 'published'`) ve
   `MIN_PUBLIC_TREND_PRODUCTS` (4) gösterilebilir ürünü (görselli, fiyatlı, stokta, yayında)
   olan. Kural tek yerdedir (`loadPublicTrendRows`); liste sayfası ve harita aynı sorguyu okur.
   Görünmeyen trend 404'tür, haritada da yoktur.
3. **Yayın penceresi bakılmaz:** `active_from/until` 0077'ye göre editoryal tahmindir ve
   yalnızca "Şu An Trend" kesitini belirler (`isTrendActiveNow`); erişim sınırı değildir.
   Pencere dışındaki mevsimlik/kampanya sayfası yayında kalır, haritada kalır ve `noindex`
   almaz: yıl boyu organik trafik kazanabilir. Bir trend arama motorundan çekilmek
   isteniyorsa yolu yayından kaldırmaktır (`archived`/`draft`).
4. **Önbellek yok:** liste istek anında okunur. Yayından kalkan, arşivlenen ya da eşik altına
   düşen trend bir sonraki istekte çıkar; sayfanın 404 kararıyla aynı an. Trend sorgusu hata
   verirse harita düşmez, trendler o istekte atlanır.
5. **Adres:** kanonik adresle birebir (`/trendler/<slug>`); sayfanın kabul etmediği slug
   (404 olurdu) girmez. `lastmod` yazılmaz: ürün bağları değişince trend satırı güncellenmez,
   yanlış `lastmod` hiç yazmamaktan kötüdür.
6. **JSON-LD:** `BreadcrumbList` (site → Trendler → trend) ve `ItemList` (yalnız ızgaradaki
   ürünler, aynı sırayla: konum, ad, ürün adresi). Fiyat, marka, stok, puan yazılmaz; o veri
   ürün sayfasının `Product` kaydındadır. Site adresi yoksa hiç üretilmez (mutlak adres şartı).
   Kapalı üründe ve görünmeyen trendde sayfa üretilmediği için yapılandırılmış veri de yoktur.

## Reddedilen alternatifler

- **Pencere dışı trendi haritadan çıkarıp `noindex` vermek:** pencere erişim sınırı değil
  (0077); mevsimlik sayfa sezon dışında da aranır ve trafiğini kaybederdi.
- **Ayrı `/sitemaps/trend/` ucu:** bu hacimde gereksiz uç ve bakım.
- **`unstable_cache` ile 24 saat:** yayından kalkan trend bir gün haritada kalırdı; sorgu küçük.
- **`ItemList` içinde `Product` + fiyat:** fiyat bayatlar ve ürün sayfasıyla çelişir (0156).
