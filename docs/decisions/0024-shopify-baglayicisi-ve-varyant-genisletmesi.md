# 0024 — Shopify bağlayıcısı ve varyant (renk/beden/SKU) genişletmesi

**Tarih:** 2026-09
**Durum:** kabul edildi

## Karar

`services/ingest/collect/sources/shopify.py` adında dördüncü, jenerik bir
taşıma eklendi (`xml_feed`, `api`, `affiliate_network` yanına;
`merchant.source_type` CHECK kısıtına `'shopify'` eklendi —
`packages/db/migrations/0017_offer_variant_sku_and_shopify_source.sql`).

Bu connector, bir Shopify ürününü `feed_config.transport.shopify.color_option`
config'i varsa o alana göre gruplar ve her renk grubu için **ayrı bir ham
kayıt** üretir. Bölme işlemi tamamen connector içinde biter;
`normalize()` / `pipeline.py` / `writer.py` ve diğer iki connector (xml_feed,
network_dump) hiç değişmedi.

`offer_variant` tablosuna `sku TEXT` kolonu eklendi (aynı migration).
`services/ingest/collect/mapping.py`'deki `VariantMapping` artık her beden
girdisi için opsiyonel `price`/`sku` alanları okuyabiliyor;
`NormalizedVariant` bu ikisini taşıyor, `writer.py` `offer_variant.price_override`/
`offer_variant.sku`'ya yazıyor.

`packages/db/migrations/0018_merchant_shopify_discovery.sql` (bu oturumda
yazılmış, hiçbir ortama uygulanmamış) yerinde güncellendi: `source_type`
`'shopify'` oldu, gerçek bir `feed_config.mapping` tanımlandı,
`known_blocker` notu kaldırıldı. `currency_verified: false` ve
`is_active = FALSE` **korundu** — para birimi doğrulaması bu kararın kapsamı
dışında, hâlâ ayrı bir açık konu.

## Gerekçe

**Neden yeni bir connector, jenerik `mapping.py`'ye dot-path eklemek değil.**
İlk yaklaşım (`"variants.0.price"` gibi bir nokta-yolu ekleyerek `groups`'un
ilk ögesinden skaler çekmek) yalnızca fiyat/görsel açığını kapatırdı; renk
sorununu çözmezdi, çünkü `pipeline.py`/`normalize()`/`writer.py` "1 ham kayıt
→ 1 `offer`" sözleşmesine sıkı bağlı ve bunu kırmak XML/ağ-dökümü
connector'larını da etkiler (bkz. araştırma: `test_pipeline.py`'nin idempotentlik
testleri, `test_sources.py`'nin `groups` testleri — hiçbiri "1 kayıt → N
offer" senaryosu tanımıyor). Bölmeyi connector seviyesinde (yalnızca Shopify
JSON'ını okuyan katmanda) yapmak, paylaşılan pipeline'a hiç dokunmadan aynı
sonucu veriyor — regresyon riski yalnızca yeni dosyayla sınırlı.

**Neden bu, `docs/decisions/0012`'nin "merchant başına elle yazılmış
connector" reddiyle çelişmiyor.** 0012 tek bir MERCHANT için yazılan
connector'ı reddetti ("otuzuncuda otuz dosya bakımı... farklılıklar veri
değil kod haline gelirdi"). Burada eklenen bir PLATFORM connector'ı — tıpkı
`rest_api.py`'nin tek bir merchant değil, "sayfalama + oran sınırı olan
herhangi bir REST API" biçimini kapsaması gibi, `shopify.py` da "Shopify
altyapılı herhangi bir mağaza" biçimini kapsıyor. 19 merchant'ın hepsi AYNI
dosyayı kullanıyor; alan adları (`price`, `title`, `vendor`, ...) yine
`feed_config.mapping`'ten geliyor, koda gömülü değil — 0012'nin asıl ilkesi
(sağlayıcı şeması koda gömülmez) bozulmadı, yalnızca YAPISAL bir farklılık
(iç içe renk/beden) config'in ifade edemeyeceği bir dönüşüm olduğu için
koda taşındı.

**Neden `offer_variant.sku` yeni bir kolon.** `docs/decisions/0005` zaten
beden farkını `offer_variant`de, nadir fiyat farkını `price_override`'da
çözmüştü; ama SKU hiç düşünülmemişti çünkü o zamana kadar SKU'nun
per-varyant değişebileceği bir kaynak (Shopify) yoktu. Kolon eklemek
geriye uyumlu (`ALTER TABLE ... ADD COLUMN`, nullable) — mevcut hiçbir
satırı bozmuyor.

**Neden `color_option` tüm merchant'lara uygulandı, seçici değil.** Tek
varyantlı bir üründe (`option1`/`option2` yok ya da tüm varyantlar aynı
`option1` değerini paylaşıyor) gruplama zaten tek gruba düşer — bölme
olmaz. Yani ayarı her yere koymak zararsız; hangi merchant'ın gerçekten
renk çeşitliliğine sahip olduğunu şimdiden bilmek gerekmiyor.

**Tuzak: Shopify fiyat formatı Türkçe değil.** `ValueFormats`'ın varsayılanı
(`decimal_separator=","`, `thousands_separator="."`) Türk feed'lerine göre
seçilmişti. Shopify `variants[].price` alanını hep `"2100.00"` biçiminde
(nokta ondalık, virgül yok) döndürüyor — varsayılanla parse edilirse nokta
binlik ayracı sanılıp silinir ve fiyat **100 kat büyük** okunur (`"2100.00"`
→ 21000 TL yerine 210 TL değil, tam tersi: 210000 kuruş yerine 21000000
kuruş). Bu yüzden 19 merchant satırının hepsine `feed_config.value_formats:
{"decimal_separator":".","thousands_separator":","}` eklendi
(`0018_merchant_shopify_discovery.sql`, üst seviye anahtar — `mapping`
içine değil, `ValueFormats.from_config` tüm `feed_config`'i okuyor).

**Neden `is_active` hâlâ `FALSE`.** Bu değişiklik yalnızca "kod çalışabilir
mi" sorusunu çözüyor. Para biriminin gerçekten TRY olduğu (Shopify'ın düz
`/products.json`'ı bunu döndürmüyor) hâlâ doğrulanmadı — bu, `0023`'te
açıkça bırakılmış, bağımsız bir karar noktası. İkisini birbirine
bağlamamak için `is_active` burada değiştirilmedi.

## Sonucu

- `services/ingest/collect/sources/shopify.py` (yeni).
- `services/ingest/collect/{mapping.py,normalize.py,records.py,writer.py}`
  küçük, geriye uyumlu eklemeler (yeni alanlar hep opsiyonel/`None` varsayılan).
- `packages/db/migrations/0017_offer_variant_sku_and_shopify_source.sql`.
- `packages/db/migrations/0018_merchant_shopify_discovery.sql` yerinde
  güncellendi (henüz hiçbir ortama uygulanmadığı için).
- `services/ingest/tests/test_shopify_source.py` (yeni) + `test_mapping.py`/
  `test_sources.py`'ye eklenen varyant price/sku testleri.
- xml_feed/network_dump connector'ları ve `pipeline.py`/`writer.py`'nin
  paylaşılan sözleşmesi **değişmedi** — mevcut merchant'lar için regresyon
  beklenmiyor.

## Reddedilen alternatifler

- **Jenerik `mapping.py`'ye dot-path/gruplama eklemek.** Yalnızca fiyat/
  görsel açığını kapatır, renk sorununu çözmez; renk çözümü için
  `pipeline.py`/`normalize()`/`writer.py`'nin paylaşılan sözleşmesini
  kırmak gerekirdi — tüm connector'ları etkileyen, gereksiz büyük bir
  değişiklik.
- **Yalnızca acil fiyat/görsel açığını kapatıp renk/SKU'yu ertelemek.**
  Kullanıcı tarafından değerlendirildi, tam kapsam tercih edildi.
- **`offer_variant`i çok boyutlu (renk+beden) yapacak şekilde yeniden
  tasarlamak.** `docs/decisions/0005` zaten rengi `product` düzeyinde
  kanonik kılmıştı; bunu bozmak hem şemayı hem eşleştirme (B4) katmanını
  etkilerdi. Connector seviyesinde bölme, mevcut modele hiç dokunmadan
  aynı sonucu veriyor.
