# 0027 — Geçici Shopify bootstrap kataloğu

**Tarih:** 2026-09
**Durum:** kabul edildi

## Karar

Admitad başvurusundan önce arama, eşleştirme ve görsel benzerliği gerçek ve
çeşitli ürünlerle denemek için **yalnızca yerel geliştirme veritabanına**
1.000–3.500 ürünlük geçici bir katalog yüklenir. Kaynak, `0023`'teki gibi
Shopify mağazalarının herkese açık `/products.json` uç noktasıdır.

`0023`'ün **merchant başına 20–30 ürün** tavanı bu katalog için kaldırıldı
(kullanıcı kararı). Yerine şu sınırlar geçerlidir:

- Merchant başına en fazla **300 kanonik Shopify ürünü**
  (`feed_config.transport.shopify.max_products`; renk bölmesinden önce sayılır).
- Toplam sert tavan **3.500** (`collect/bootstrap.py` manifesti reddeder).
- Merchant'lar **sırayla** işlenir (eşzamanlılık 1), mağaza başına
  **≤ 0,5 istek/sn**, sayfa boyu 250.
- Yeniden deneme yalnızca geçici hatalarda (429, 5xx, bağlantı hatası): en
  fazla 2 kez, üssel geri çekilme, `Retry-After` dinlenir ama sınırlanır.
  403 ve diğer 4xx yanıtlar **tekrar denenmez**. Ayar yoksa varsayılan hâlâ
  tek denemedir.

`0023`'ün diğer sınırları aynen geçerlidir: HTML kazıma yok, bot koruması
aşılmaz, `robots.txt` `/products` yolunu yasaklıyorsa mağaza kullanılmaz,
Trendyol/Hepsiburada gibi kapalı sistemlere dokunulmaz.

## Ayırt edilebilirlik — şema değişmedi

`merchant.source_type` zaten `'shopify'`; `offer.discovery_source` CHECK'i
yalnızca `feed/api/user_link` kabul ediyor. Yeni bir enum değeri migration
gerektirirdi ve migration production'a da gider. Bunun yerine:

- Her bootstrap merchant'ı `feed_config.bootstrap_source = "bootstrap_shopify"`
  taşır (JSONB, şemasız).
- Offer'lar `offer.merchant_id` üzerinden, product'lar o offer'lara bağlı
  olmaları üzerinden bulunur. Temizlik adımları `docs/ops.md` içinde.

## Kategori: `category_hint` geri dönüşü

Shopify `product_type` serbest metindir ve kategori ağacındaki bir `path` ile
neredeyse hiç birebir eşleşmez; bu yüzden `resolve` yeni ürünlerin çoğunu
kategorisiz açıyordu. `0018`'in yazdığı `feed_config.category_hint` hiçbir
kodda okunmuyordu. Artık `resolve/products.create_from_offer` ham kategori
ağaçta bulunamazsa merchant'ın `category_hint`ini dener. Hint de yalnızca
**mevcut** bir yola bağlanır; `0017`'nin "kategori yoktan açılmaz" ilkesi
bozulmaz. Hint ana kategori düzeyindedir, alt kategori ataması ayrı bir iş.

## Bootstrap'in ortaya çıkardığı üç düzeltme

İlk gerçek koşu, fixture'ların göremediği üç hatayı gösterdi:

1. **Renk kardeşleri tek ürüne birleşiyordu.** 1.250 otomatik kabulün
   1.049'u aynı Shopify ürününün farklı renkleriydi; çünkü "Defne Yeşili",
   "Kumtaşı" gibi renkler sözlükte yok ve renk vetosu çalışmıyordu. İki kural:
   - `ProductKey.build` açıkça verilen, ama sözlükte olmayan rengi normalize
     edilmiş hâliyle tutar. Böylece veto çalışır.
   - `resolve`, aynı merchant'ın zaten bağlı teklifi olan ürünü aday
     listesinden çıkarır. Bir mağaza aynı kanonik ürünü iki ayrı kayıtla
     satmaz; iki kayıt pratikte renk kardeşi ya da tekil parçadır (aynı
     başlıklı iki el dokuma halı).
   Regresyon setine gerçek katalogdan üç renk kardeşi çifti eklendi.
2. **Beden, renk sanılıyordu.** Shopify seçenek sırası mağazaya göre
   değişiyor: Casadora'da `option1` beden, For Fun'da `option2` renk,
   Normod'da `option2` ayak tipi. Connector artık seçeneği **adıyla** bulur
   (`shopify.color_option_names`, `shopify.size_option_names`). Konuma
   dayalı `color_option` geriye uyumlu olarak kalır; 0018 satırları
   değişmedi.
3. **Sıfır fiyat teklif değildir.** `normalize` fiyatı ≤ 0 olan kaydı
   reddeder: kumaş numunesi, hediye kartı, muhasebe satırı.

## Gerekçe

Gerçek katalog olmadan eşik, normalizasyon ve görsel benzerlik sorunları
ancak Admitad'dan sonra görülürdü; o noktada düzeltmek hem daha pahalı hem
de canlı kullanıcıya yansır. Yerel veritabanıyla sınırlamak, gri alandaki bu
veriyi yayın yüzeyinden (production, sitemap, SEO) uzak tutar.

## Reddedilen alternatifler

- **`bootstrap_shopify` için yeni `discovery_source`/`source_type` değeri.**
  Migration ister, production şemasına geçici bir kavram sokar.
- **Supabase'e yazmak.** Hangi ortam olduğu depodan kesin ayırt edilemedi;
  kör ingest reddedildi.
- **20–30 tavanında kalmak.** 10–12 mağazada ~300 ürün verir; görsel
  benzerlik ve eşleştirme testi için yetersiz.
