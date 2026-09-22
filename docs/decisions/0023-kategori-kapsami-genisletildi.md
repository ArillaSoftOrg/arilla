# 0023 — MVP kategori kapsamı Trendyol ana kategorilerine genişletildi

**Tarih:** 2026-09
**Durum:** kabul edildi

## Karar

MVP kategori kapsamı, önceki dar kapsamdan (moda, kozmetik) Trendyol'un tüm
ana kategorilerine genişletiliyor: Elektronik, Ev/Yaşam, Anne/Bebek, Moda,
Kitap/Müzik/Hobi, Spor/Outdoor, Sağlık/Kozmetik, Oto/Bahçe, Petshop,
Süpermarket.

Bu **kullanıcının bilinçli tercihidir**, özellikle Elektronik için: komisyon
ekonomisinin bu kategoride çalıştığı henüz doğrulanmadı, risk bilerek kabul
edildi. `CLAUDE.md`'nin "Kesinlikle yapılmayacaklar" listesindeki "Elektronik
kategorisini eklemek" maddesi bu kararla birlikte kaldırıldı.

## Gerekçe

Önceki dar kapsam ayrı bir karar dosyasında değil, doğrudan `CLAUDE.md`
kuralı olarak duruyordu ("Komisyon ekonomisi bu kategoride çalışmıyor").
Platform büyüdükçe kategori çeşitliliğinin keşif ve arama hacmini artıracağı
değerlendirildi; Elektronik'in komisyon ekonomisi ayrı bir doğrulama konusu
olarak açık kalıyor ama kapsamı bloke etmiyor.

Bu genişleme `docs/decisions/0017-eslestirme-esikleri.md`'nin "kategori
açılmaz, kategori ağacı kurumsal bir karardır" ilkesini **bozmuyor**: yeni
kategoriler elle ve bilinçli olarak (bu karar + migration ile) ekleniyor,
feed'in ham metninden otomatik türetilmiyor. 0017'nin asıl ilkesi — eşleşme
eşiğinin altında kalan offer için kategori asla otomatik açılmaz, yalnızca
mevcut bir `category.path` ile eşleşirse bağlanır — aynen geçerli.

`is_discoverable = false` kararı Petshop ve Süpermarket için korundu, ama
gerekçesi düzeltildi: bu bayrak yalnızca keşfet feed'i, curated pool ve
sitemap indexlemeyi kontrolü ediyor
(`packages/core/src/product/sitemap-eligibility.ts`,
`packages/core/src/discovery-feed/curated-pool.ts`) — "benzer ürün"
eşleştirme/similarity pipeline'ını (`services/ingest/resolve`,
`similarity_edge`) etkilemiyor. Yani bu iki kategorinin ürünleri fiyat
karşılaştırma ve alternatif bulmada tam olarak yer alacak; yalnızca
keşfet ızgarasında ve sitemap'te görünmeyecekler. Karar bu düzeltilmiş
etkiyle bilerek korundu.

Mevcut `kozmetik` üst kategorisi (parfum, cilt-bakimi çocuklarıyla) yeni
"Sağlık/Kozmetik" ana kategorisiyle örtüştüğü için yeniden ebeveynlendi:
yeni `saglik-kozmetik` üst kategori açıldı, `kozmetik` onun altına taşındı.
Bu, taksonomiyi tam 10 ana kategoriyle tutarlı tutar. `/kategori` rotası
henüz yayında olmadığı için (Faz 4, bkz. `docs/routes.md`) bu yeniden
ebeveynlemenin geriye dönük URL maliyeti yok.

**Brand-discovery / endpoint-verification / connector-ingest zinciri —
veri kaynağı olarak neden kabul edildi:** Yeni kategorilerde gerçek merchant
feed'i veya API anahtarı yok (bkz. Faz 0 durumu — hiçbir merchant ile resmi
anlaşma yok, Admitad'a henüz başvurulmadı). Bunun yerine Shopify altyapılı
mağazaların kendi isteğiyle herkese açık bıraktığı `/products.json` uç
noktası kullanılıyor — bu, Trendyol/Hepsiburada gibi token-korumalı kapalı
sistemlerin aksine, merchant'ın bilerek açık bıraktığı bir veri kaynağı
olduğu için "API" kategorisine giriyor sayıldı, "scraping" değil.

Bununla birlikte bu **açık bir gri alan**: hiçbir resmi sözleşme veya
affiliate ağı onayı yok, yalnızca merchant'ın teknik olarak açık bıraktığı
bir uç nokta kullanılıyor. Kullanıcı bunu şu sınırlarla bilerek kabul etti:

- **Tek deneme kuralı.** Doğrulama isteği başarısız olursa (timeout, 4xx/5xx,
  geçersiz JSON, TRY dışı para birimi) aday listeden çıkar, ikinci deneme
  yapılmaz.
- **Rate limit.** Saniyede 1-2 istekten fazla değil.
- **Ürün tavanı.** Merchant başına en fazla 20-30 ürün.
- **Kapalı sistem yasağı.** Trendyol, Hepsiburada gibi token-korumalı,
  kapalı sistemlere kesinlikle dokunulmaz.

## Sonucu

- `CLAUDE.md`'den Elektronik yasağı kaldırıldı.
- `packages/db/migrations/0016_category_expansion.sql` ile 8 yeni ana
  kategori eklendi, `kozmetik` `saglik-kozmetik` altına taşındı,
  `category.slug` üzerindeki eksik UNIQUE kısıtı düzeltildi.
- `docs/routes.md`, `docs/decisions/0017-eslestirme-esikleri.md` ve
  `services/ingest/resolve/products.py` içindeki "elektronik bilerek
  dışarıda" örnekleri güncellendi/kaldırıldı.
- brand-discovery → endpoint-verification → connector-ingest zinciri 10
  kategoriye uygulandı: 43 aday bulundu, 29'u orta+ güven notuyla
  doğrulamaya alındı, 22'si `/products.json`'dan geçerli JSON döndürdü, 3'ü
  veri kalitesi nedeniyle (boş katalog, test/placeholder fiyat, EU/toptan
  sinyali) elendi. Kalan **19 merchant**
  `packages/db/migrations/0018_merchant_shopify_discovery.sql` ile
  `is_active = FALSE` olarak kaydedildi. Elektronik ve Süpermarket'te
  beklendiği gibi zayıf sinyal çıktı (sırasıyla 1 ve 0 doğrulanmış aday);
  Oto/Bahçe ve Kitap/Müzik/Hobi/Petshop kategorilerinde de bu turda hiç
  merchant doğrulanamadı — bu bir hata değil, kaynak kısıtının kendisi.
- **Yeni, daha ciddi bir bulgu ingest sırasında ortaya çıktı:**
  `services/ingest/collect/sources/rest_api.py` ve
  `collect/normalize.py`, bir kaynağın `groups` (liste-of-dict) alanının
  ilk ögesinden skaler bir değer çekme mekanizmasına sahip değil. Shopify
  `products.json`'da hem fiyat (`variants[].price`) hem görsel
  (`images[].src`) yalnızca bu türden alanlarda durduğu için, **mevcut
  kodla bu 19 merchant'tan hiçbiri gerçek bir ingest çalıştırıldığında
  veri üretemez** — her kayıt "fiyat yok" ile reddedilir. Bu yüzden
  hepsi `is_active = FALSE` ile eklendi ve `feed_config.mapping` hiç
  yazılmadı (yanlış/çalışmayan bir eşleme veritabanına yazılıp
  `0012`'nin "config gerçek dökümdür" ilkesini ihlal etmesin diye).
  Bu, ayrı, insan onaylı bir B1 görevi olarak ele alınmalı: mapping/
  normalize katmanına "gruptaki ilk ögenin bir alanı" (örn.
  `variants.0.price`) biçiminde bir yol desteği eklemek. Para birimi
  doğrulaması da aynı çalışmada ele alınmalı (`currency_verified: false`
  notu `feed_config`'te duruyor).

## Reddedilen alternatif

- **Toplu/izinsiz kazıma.** CLAUDE.md'nin "Scraping'i birincil veri kaynağı
  yapmak" yasağıyla doğrudan çelişir; bu yüzden yalnızca merchant'ın kendi
  isteğiyle açık bıraktığı JSON uç noktaları kullanılıyor, HTML kazıma yok.
- **Resmi merchant anlaşması/Admitad onayı çıkana kadar beklemek.** MVP'yi
  Faz 0 blokajına tamamen bağımlı kılardı; kullanıcı bunun yerine sınırlı,
  düşük hacimli bir keşif+doğrulama zinciriyle ilerlemeyi tercih etti.
