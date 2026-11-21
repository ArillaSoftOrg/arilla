# PRODUCT_ACCESS bayrağına bağlı davranışlar

`PRODUCT_ACCESS=open` ise ürün herkese açık; tanımsız ya da başka her değer **kapalı**
(fail-closed, `packages/core/src/access/product-access.ts`). Canlıda açma kararı için
bayrağın kapalıyken ve açılınca neyi değiştirdiği:

| Yer | Kapalı (bugün) | Açık |
| --- | --- | --- |
| `/` ana sayfa | Erken erişim landing'i; metadata "yakında" başlığı | Ürün ana sayfası (arama, keşif, trendler) |
| `proxy.ts` | Oturumsuz ziyaretçi `/urun`, `/kesfet`, `/firsatlar`, `/trendler`, `/sohbet`, `/git` yollarında `/`'e yönlenir | Yönlendirme yok |
| `robots.ts` | Ek olarak `/urun/`, `/kesfet`, `/firsatlar`, `/trendler`, `/erken-erisim` taramaya kapalı | Bu beşi taramaya açılır |
| `sitemap.xml`, `sitemaps/urun/*` | Ürün parçaları (shard) haritada yok | Ürün parçaları listelenir |
| `sitemap-sayfalar.xml` | `/kesfet`, `/firsatlar`, `/trendler` yok | Bu üçü listelenir |
| `/giris`, `/nasil-calisir`, `public-site-shell`, `not-found` | Erken erişim metni ve bağlantıları | Ürün bağlantıları |
| `sohbet/actions`, `chat-product-actions`, `sohbet/gorsel/*` | Yalnızca `product.preview` yetkili rol (admin) | Girişli kullanıcı |
| `layout.tsx` (karar 0219) | WebSite JSON-LD'de SearchAction yok | SearchAction (`/sohbet?q=`) var |

Search Console notu: kapalıyken ürün yolları hem robots'ta engelli hem proxy'de yönlendirmeli
olduğundan "dizine eklenmedi" listesinde bu sınıf URL'lerin görünmesi beklenen davranıştır.
Bayrak açıldıktan sonra robots/sitemap değişikliği yeniden taranana kadar gecikir.
