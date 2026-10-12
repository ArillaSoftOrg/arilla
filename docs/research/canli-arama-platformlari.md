# Türkiye platformları — eklentisiz canlı ürün araması (araştırma, 2026-10-12)

Dal: `research/tr-live-product-search` (commit'siz). Yöntem: kullanıcının gerçek
Chrome'u, nötr kaynak `https://example.com`, `fetch(url, {mode:"cors", credentials:"omit"})`.
UA taklidi, çerez, proxy, CAPTCHA aşma yok. Önce robots.txt, sonra normal arama
sayfasının veri akışı (normal ziyaret), sonra cross-origin okuma.

## Hepsiburada çelişkisinin nedeni

| | Önceki çalışma (`research/live-search-extension`, `apps/live-search-web-probe/probe.js`) | Benim ilk testim |
|---|---|---|
| URL | `https://www.hepsiburada.com/ara?q=<sorgu>` | `https://www.hepsiburada.com/robots.txt` |
| Yöntem / kaynak | GET, `mode:"cors"`, `credentials:"omit"`, localhost / example.com | aynı, example.com |
| Sonuç | 200, ACAO `*`, 2–4,6 MB HTML | tarayıcıdan **503**, ACAO yok → `Failed to fetch` |

Fark yalnızca URL: arama sayfası CORS'a açık, robots.txt değil. Aynı koşullarda
yeniden doğrulandı (yönlendirme yok, `response.ok`). Veri: `<script id="reduxStore">` →
`voltranState.fragmentsMap.*.ProductList.seoState.itemListElement` (schema.org
ItemList, JSON metni). Normal ziyarette robots.txt okundu: `/ara` için kural yok.
Sunucudan istek (honest UA) 403 (Akamai) — bu yöntem tarayıcıya özgü.

## Sınıflandırma

| Platform | Sınıf | Kanıt |
|---|---|---|
| Hepsiburada | **Çalışıyor, gerçek ürünle doğrulandı** | iPhone 16 Pro 128 GB: 3 ürün; Adidas Samba 36; Siyah kadın elbise 36; Sony WH-1000XM5 25. Her üründe ad, fiyat (TRY), görsel (yüklendi, 300x400), ürün URL'si, `InStock`. Satıcı alanı listede yok. |
| ÇiçekSepeti | **Çalışıyor, gerçek ürünle doğrulandı** | `/arama?query=` cross-origin okunur. Veri Next.js RSC akışında (`self.__next_f.push`) `products` dizisi: `name`, `image`, `link`, `price.finalPrice`. 4 sorgunun hepsinde 30 ürün, alanlar tam, görsel yüklendi (278x306). Ama iPhone 16 Pro 128 GB ve Sony WH-1000XM5 için **birebir eşleşme 0** (iPhone 17 / kulaklık pedi döndü); Adidas Samba 30/30 eşleşti. Satıcı ve stok listede yok. robots: `/arama` yasak değil. |
| n11 | Erişim engeliyle karşılaşıldı | Arama sayfası SSR JSON-LD `ItemList` taşıyor (20 ürün; ad, fiyat, görsel, URL, `InStock` — normal ziyarette görüldü). Cross-origin: CORS yok. Sunucudan durust UA: 1. istek 200, 2. istek (Node) 403 → durduruldu. robots: `/arama?q=` yasak değil. |
| Amazon TR | Erişim engeli + koşullar | Arama sayfası HTML kart (55), JSON-LD yok. Cross-origin: CORS yok. Resmî yol Creators API (PA-API kapatıldı); TR erişimi doğrulanmadı. |
| PTTAVM | Kullanım koşulları (robots) nedeniyle uygulanamaz | robots `Disallow: *?q=*`. Sayfada SSR JSON-LD `ItemList` var; Cloudflare challenge betiği çalışıyor. Cross-origin denenmedi. |
| Pazarama | Robots nedeniyle uygulanamaz | robots `/arama`, `/search` yasak. Nuxt; sonuçlar `bff.pazarama.com/v2/search/...` XHR'dan. Cross-origin denenmedi. |
| Sahibinden | Robots + erişim engeli | robots `/arama?`, `/search_result.php*` yasak. Normal ziyaret `/cs/tloading` doğrulama ara sayfasına yönlendi; durdum. |
| Dolap | Robots nedeniyle uygulanamaz | robots `/arama?` ve `/api/` yasak. Sonuçlar istemci tarafında. |
| Letgo | Robots nedeniyle uygulanamaz | Gerçek arama URL'si `/arama?query_text=…&isSearchCall=true`; robots `Disallow: /arama?*`, `/*?query_text=*`, `isSearchCall`. Bir cross-origin denemesi zaman aşımına uğradı (sonuç yok); tekrarlanmadı. |

Ticari kullanım koşulları hiçbir platformda doğrulanmadı. CORS izni içerik lisansı değildir.

## Doğrulanmayan / açık

- Liste fiyatı ile ürün sayfasındaki fiyat çapraz kontrol edilmedi (HB, ÇS).
- HB listesinde satıcı yok; ÇS listesinde satıcı ve stok yok.
- ÇS'de bazı ilanlar (ör. %58 indirimli Samba) özgünlük riski taşıyabilir; yalnızca kaynak verisi aktarılır.
- Bu ortamın IP'sinden ölçüldü; başka ağlarda davranış farklı olabilir.

## Üretim engelleri (HB + ÇS için)

KVKK/üçüncü taraf istek (ziyaretçi IP'si ve sorgusu mağazaya gider; CLAUDE.md
font/betik kuralı ve karar 0087 ruhu), CSP `connect-src`/`img-src`, kural 8
(`click` yok), kural 3 (saklanmaz), resmî olmayan veri yapısı (haber vermeden
değişebilir), arama başına 2–4,6 MB (HB) mobil veri, hukuki onay. Ayrı ADR gerekir.
