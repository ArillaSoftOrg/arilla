# Kaynaklar — products.ts (demo ürün kataloğu)

Bu dosya `products.ts` içindeki (Trendler ve Keşif ızgarasının TEK ortak veri
kaynağı) her ürünün nereden geldiğini kaydeder. Amaç: demo veri temizlenip
gerçek Admitad/feed entegrasyonuna geçilirken hangi satırların "gerçek ama
geçici" olduğunu kaybetmemek. Bu metadata kullanıcı arayüzünde gösterilmez.

Araştırma yöntemi: her ürün için resmi marka/perakendeci ürün sayfası tek
seferlik olarak getirildi (WebFetch/curl, tek istek), sayfanın herkese açık
`og:image`/`og:title` meta etiketlerinden veya görünür sayfa içeriğinden ürün
adı, marka ve görsel URL'si çıkarıldı. Agresif tarama, kimlik doğrulama atlatma
veya bot korumasını aşma girişimi yapılmadı — 403/engelleme dönen hiçbir
kaynağa tekrar denenmedi (bkz. "Erişilemeyen kaynaklar").

## Kullanılan ürünler

| id | Ürün | Marka | Kaynak sayfa | Görsel kaynağı | Kaynak türü | Erişim tarihi |
| --- | --- | --- | --- | --- | --- | --- |
| `nike-air-force-1-07` | Air Force 1 '07 | Nike | https://www.nike.com/t/air-force-1-07-mens-shoes-XVPIszaq/FJ4146-129 | static.nike.com CDN (sayfa meta verisinden) | Resmi marka sayfası | 2026-09-16 |
| `puma-suede-classic-xxi` | Suede Classic XXI | Puma | https://us.puma.com/us/en/pd/suede-classic-xxi-sneakers/374915 | images.puma.com CDN (sayfa meta verisinden) | Resmi marka sayfası | 2026-09-16 |
| `veja-campo-leather-white-black` | Campo Leather | Veja | https://www.veja-store.com/en_us/p/campo-leather-white-black-CP0501537.html | media.veja-store.com CDN (og:image meta etiketi) | Resmi marka sayfası | 2026-09-16 |
| `veja-esplar-leather-white-black` | Esplar Leather | Veja | https://www.veja-store.com/en_us/p/esplar-leather-white-black-EO0200005.html | media.veja-store.com CDN (og:image meta etiketi) | Resmi marka sayfası | 2026-09-16 |
| `ikea-markus-chair` | MARKUS ofis koltuğu | IKEA | https://www.ikea.com/us/en/p/markus-office-chair-vissle-dark-gray-90289172/ | ikea.com ürün görseli | Resmi perakendeci sayfası | 2026-09-16 |
| `ikea-forsa-lamp` | FORSÅ masa lambası | IKEA | https://www.ikea.com/us/en/p/forsa-work-lamp-nickel-plated-60146764/ | ikea.com ürün görseli | Resmi perakendeci sayfası | 2026-09-16 |
| `ikea-ovning-organizer` | ÖVNING masaüstü düzenleyici | IKEA | https://www.ikea.com/us/en/p/oevning-desk-accessories-organizer-30552014/ | ikea.com ürün görseli | Resmi perakendeci sayfası | 2026-09-16 |
| `carhartt-wip-detroit-jacket` | Detroit Ceket | Carhartt WIP | https://us.carhartt-wip.com/en-us/products/detroit-jacket-black-black-rinsed-1743 | cdn.shopify.com (mağaza CDN'i) | Resmi marka sayfası | 2026-09-16 |
| `la-apparel-heavy-fleece-crewneck` | Heavy Fleece Crewneck | Los Angeles Apparel | https://losangelesapparel.net/products/hf07-heavy-fleece-crewneck-sweater-garment-dye | losangelesapparel.net CDN (og:image meta etiketi) | Resmi marka sayfası | 2026-09-16 |
| `herschel-little-america-backpack` | Little America Sırt Çantası | Herschel | https://herschel.com/products/herschel-little-america-backpack | herschel.com CDN (sayfa meta verisinden) | Resmi marka sayfası | 2026-09-16 |
| `ikea-fejka-plant` | FEJKA yapay saksı bitkisi | IKEA | https://www.ikea.com/us/en/p/fejka-artificial-potted-plant-indoor-outdoor-aralia-60600853/ | ikea.com ürün görseli | Resmi perakendeci sayfası | 2026-09-16 |
| `ikea-billy-bookcase` | BILLY kitaplık | IKEA | https://www.ikea.com/us/en/p/billy-bookcase-white-50522040/ | ikea.com ürün görseli | Resmi perakendeci sayfası | 2026-09-16 |
| `ikea-vallkrassing-cushion-cover` | VALLKRASSING yastık kılıfı | IKEA | https://www.ikea.com/us/en/p/vallkrassing-cushion-cover-off-white-70570959/ | ikea.com ürün görseli | Resmi perakendeci sayfası | 2026-09-16 |
| `ikea-lindbyn-mirror` | LINDBYN ayna | IKEA | https://www.ikea.com/us/en/p/lindbyn-mirror-black-30506116/ | ikea.com ürün görseli | Resmi perakendeci sayfası | 2026-09-16 |
| `ikea-hektar-floor-lamp` | HEKTAR lambader | IKEA | https://www.ikea.com/us/en/p/hektar-floor-lamp-dark-gray-70216544/ | ikea.com ürün görseli | Resmi perakendeci sayfası | 2026-09-16 |
| `ikea-lohals-rug` | LOHALS halı | IKEA | https://www.ikea.com/us/en/p/lohals-rug-flatwoven-natural-30511288/ | ikea.com ürün görseli | Resmi perakendeci sayfası | 2026-09-16 |
| `nike-club-hoodie` | Club Pullover Hoodie | Nike | https://www.nike.com/t/club-mens-pullover-fleece-hoodie-00eeWNwD | static.nike.com CDN (sayfa meta verisinden) | Resmi marka sayfası | 2026-09-16 |
| `nike-featherlight-cap` | Dri-FIT Featherlight Cap | Nike | https://www.nike.com/t/dri-fit-club-unstructured-featherlight-cap-b0cNxd | static.nike.com CDN (sayfa meta verisinden) | Resmi marka sayfası | 2026-09-16 |
| `puma-essentials-tee` | Essentials Tee | Puma | https://us.puma.com/us/en/pd/puma-essentials-mens-tee/688845 | images.puma.com CDN (sayfa meta verisinden) | Resmi marka sayfası | 2026-09-16 |
| `herschel-classic-hip-pack` | Classic Hip Pack | Herschel | https://herschel.com/shop/hip-packs/fifteen-hip-pack | herschel.com CDN (og:image meta etiketi) | Resmi marka sayfası | 2026-09-16 |
| `carhartt-wip-gabe-beanie` | Gabe Beanie | Carhartt WIP | https://us.carhartt-wip.com/en-us/products/gabe-beanie-black-662 | cdn.shopify.com (og:image:url meta etiketi) | Resmi marka sayfası | 2026-09-16 |
| `la-apparel-1801-tee` | The 1801 Garment Dye Tee | Los Angeles Apparel | https://losangelesapparel.net/products/the-1801-garment-dye | losangelesapparel.net CDN (og:image meta etiketi) | Resmi marka sayfası | 2026-09-16 |

Not: IKEA `ÖVNING` sayfası ürün-varyant yönlendirmesi nedeniyle "canonical"
alanında bir kategori sayfası döndürdü; kayıtta yukarıdaki, doğrudan istek
attığım ve 200 döndüren URL kullanıldı. Görsel URL'lerinin genişlik
parametreleri (`width=`) performans için makul boyuta küçültülmüştür
(orijinal kaynak sayfadaki gibi devasa varyantlar kullanılmaz).

## Fiyat/etiket politikası

Hiçbir üründe fiyat, indirim yüzdesi, eski fiyat, "fırsat" etiketi, kullanıcı
sayısı, satış sayısı veya popülerlik skoru gösterilmiyor — bu Faz 2'de
editorial keşif amaçlı, kesin/güncel fiyat doğrulaması yapılmadı.

## Erişilemeyen kaynaklar (denenip vazgeçilen)

Aşağıdaki resmi marka sayfaları tek seferlik istekte bot koruması veya bölgesel
kısıtlama nedeniyle erişilemez döndü; tekrar denenmedi, bypass girişimi
yapılmadı:

| Marka | Durum |
| --- | --- |
| adidas.com | HTTP 403 |
| newbalance.com | HTTP 403 |
| levi.com | HTTP 403 (`Retry-After: 10800`) |
| fjallraven.com | HTTP 403 |
| converse.com | HTTP 403 |
| vans.com | HTTP 403 |
| champion.com | HTTP 404 (URL geçersiz olmuş olabilir) |
| patagonia.com | Geçici bakım sayfası döndürdü |
| gap.com | Bölgesel yönlendirme (ABD dışı erişimi kısıtlıyor) |
| uniqlo.com | Bağlantı hatası (ECONNRESET, iki denemede de) |
| allbirds.com | Sayfa yapısı meta etiketlerini sunucu tarafında render etmiyor |

"Günlük sneaker seçkisi" başlangıçta (Faz 2) 2 ürünle sınırlı kalmıştı (Nike +
Puma); Faz 2.1'de Veja (Shopify-tabanlı, erişilebilir) eklenerek 3'e
tamamlandı.

Faz 3'te keşif ızgarası için katalog 13 yeni üründen 22 üründe genişletildi
(9 Trendler ürünü + 13 yeni). Yine adidas, New Balance, Levi's, Fjällräven,
Converse, Vans, Champion, Patagonia, Gap, Uniqlo, Allbirds gibi markalar
denenmedi (yukarıdaki liste hâlâ geçerli) — yeni ürünler yalnızca daha önce
erişilebilir olduğu doğrulanmış IKEA, Nike, Puma, Herschel, Carhartt WIP,
Los Angeles Apparel ve Veja'dan (Shopify-tabanlı mağazalar dahil) eklendi.
