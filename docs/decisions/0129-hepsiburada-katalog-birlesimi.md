# 0129 — Hepsiburada: iki toplayıcının merkezi katalogda birleşmesi

**Tarih:** 17 Ekim 2026
**Durum:** Kabul edildi (migration 0082, 0083). Kod ve testler hazır. Üretimde **hiçbir şey
çalıştırılmadı**: birleştirme, aktarım, kapı ve yayın komutları elle ve sırayla çalıştırılmalı.
**Bağlam:** 0117 (yönetici tarayıcısından toplama, `catalog_intake_record`), 0120 (sitemap keşif
defteri, `catalog_discovery`), 0121 (kaynak ilanından ürün: taslak → kapı → açık yayın), 0119
(otomatik birleştirme yalnızca kesin kimlikle), 0124 (kota).

## Sorun

- Arama toplayıcısı `catalog_intake_record`'a (fiyatlı) yazar; `hb-merge` bunları `offer`'a
  taşır. Sonra ürün açan tek yol `python -m resolve` idi: eşik altındaki her teklif için **doğrudan
  `published`** ürün açar ve başlık/görsel benzerliğiyle aday arar. Hepsiburada ürünleri kalite
  kapısı olmadan yayına çıkar, başka mağazanın ürününe benzerlikle bağlanabilirdi.
- Sitemap toplayıcısı `catalog_discovery`'ye (fiyatsız) yazar; `main`'de bu defterden ürüne giden
  bir yol yoktu. `feature/hb-sitemap-catalog` dalındaki çözüm (`discovery-publish`) fiyatsız
  **`offer` satırı** açıyordu ve migration'ı (`0074_catalog_discovery.sql`) `main`'deki 0073/0074 ile
  çakışıyordu.
- Stok bilinmediğinde teklif `in_stock = false` yazılıyor, ürün sayfası "Şu an stokta yok"
  diyordu; bu yanlış bilgi. Ayrıca `attributes_raw` `||` ile birleştiğinden sonraki koşu stok
  bildirse de eski `stock_state = unknown` kalıyordu.

## Karar

1. **Tek ürün hattı: 0121.** Hepsiburada `catalog_build/policy.py`'de bir `SourcePolicy` alır
   (kimlik = adres sonundaki kod, adres `www.hepsiburada.com/<slug>-(p|pm)-<KOD>`, sorgusuz).
   Ürün yalnızca `catalog_build build` ile **taslak** açılır, kapı `ready/held` yapar, yayın
   `publish --limit N --confirm` ister. `resolve` kaynak ilanı mağazalarından (`hepsiburada`,
   `aliexpress`) **hiç teklif seçmez** (`SOURCE_LISTING_MERCHANTS`): ürün açmaz, benzerlikle
   bağlamaz.
2. **Kimlik `product (source_merchant_id, source_external_id)`** (0074, benzersiz). İki toplayıcı
   aynı anahtarı kullanır; aynı ürün iki kez açılamaz. Anahtar mağaza kapsamlıdır: AliExpress ya
   da başka mağazada aynı dizide bir kimlik olsa bile birleşmez.
3. **Fiyatsız keşif → yalnızca taslak ürün.** `catalog_build build-discovery --merchant
   hepsiburada --limit N` defterden `draft` ürün açar; `source_offer_id` NULL kalır, **`offer`,
   `price_point` ya da fiyat üretilmez**. Kapı bu ürünleri `held(source_offer_missing)` tutar:
   yayına çıkamaz. Adı ya da görseli olmayan satır ürün olmaz (ad uydurulmaz). Her koşu açık bir
   `--limit` ister; `--dry-run` yalnızca okur. Kontrol noktası `catalog_discovery_build_state`
   (0082): metin anahtarlı, parti ile aynı işlemde.
4. **Bağ yalnızca birebir kimlikle.** Fiyatlı teklif gelince `build`, keşiften doğmuş taslağa
   teklifi bağlar (`source_offer_id`) — yalnızca **aynı mağaza + aynı kod + defterdeki adres türü
   (`p`/`pm`) teklif adresininkiyle aynı** ise. Yayınlanmış ürüne ve başka ürünün kaynağı olan
   teklife dokunulmaz. Tür farklıysa bağ kurulmaz, `discovery_kind_conflict` sayılır.
5. **`hb-merge` idempotent ve tekil.** Koşu başına danışma kilidi (`run_merge_in_progress`);
   işlenen kayıt `merged_at` alır, teklif `(merchant_id, external_id)` ile tekil, FeedSync
   değişmeyen satırı yazmaz. Birleştirme sonrası defterde birebir kimlikle (kod + tür) eşleşen
   satır `price_state = 'listing_price'` olur (fiyat değeri defterde tutulmaz; `page_verified`
   geri düşürülmez). Fiyat sıçraması nedeniyle incelemeye ayrılan kayıt işaretlenmez.
6. **Stok üç durumlu:** `available` / `unavailable` / `unknown`. `offer.in_stock` NOT NULL
   kaldığı için şema değişmez: bilinmeyen stok `in_stock = false` +
   `attributes_raw.stock_state = 'unknown'`. Anahtar **her kayıtta** yazılır. Çekirdek
   `offerStockState()` üç durumu çıkarır; ürün sayfası bilinmeyen stokta "Şu an stokta yok"
   yerine nötr "Stok durumu mağazada görülür" yazar, JSON-LD `availability` vermez, birincil
   çıkış stokta yok olduğu bilinen teklife değil önce bilinmeyene gider, stok alarmı önerilmez.
   Diğer beslemeler için anahtar yoktur ve davranış değişmez.
7. **Yönetim hunisi** (`/yonetim/katalog/toplama`, `getCatalogFunnel`): arama toplayıcısı kaydı,
   sitemap keşif kaydı, birleştirilmiş kayıt (teklif), ürüne aktarılan, fiyatı olan, fiyat
   bekleyen, yayınlanan, hatalı/incelemede ve atlanma nedenleri. Salt okunur, 4 sn zaman aşımı.
   Büyük tablolar üst sınırlı sayılır (1.000.000'da durur, "en az" gösterilir); ürün durumları
   `product_source_state_idx`, fiyatlı keşif durumları `catalog_discovery_priced_idx` (0083,
   `kind: concurrent`) ile sayılır.

## `-p-` ve `-pm-` (model/varyant) araştırması

Bu görevde Hepsiburada'ya **istek atılmadı**; yalnızca depodaki kanıt incelendi.

| Kanıt | Kaynak |
| --- | --- |
| Ürün sitemap'i yalnızca `-pm-HBC…` adresleri verir (7.470 dosya × 10.000) | araştırma notu, 15 Ekim 2026 |
| Kategori/arama listesi JSON-LD `sku` `HBCV…`, adres `-p-HBCV…` | aynı araştırma; `extract-hepsiburada.ts` fixture'ları |
| Ürün sayfasında GTIN ve varyant `barcode` var; diğer renklerin fiyatı görünür | `docs/research/hepsiburada/README.md` (arşiv dalı) |
| 0117: "aynı ürünün `-p-` ve `-pm-` kodlarıyla iki ayrı teklif olması mümkündür (doğrulanmadı)" | karar 0117 |

Sonuç: `-pm-` büyük olasılıkla ürün **modeli/grubu** (renk/kapasite seçeneklerini toplar), `-p-`
tek bir **varyant**; ilişki 1:N olabilir. Gözlenen kod önekleri de farklıdır (`HBC…` / `HBCV…`),
yani birebir kod eşleşmesi iki tür arasında pratikte hiç bağ kurmaz. **İlişki doğrulanmadı.**
Doğrulamak ürün sayfasını okumayı (ör. JSON-LD `ProductGroup`/`hasVariant`, varyant barkodu)
gerektirir; bu ayrı ve onaylı bir toplama işidir. Doğrulanana kadar:

- `-p-` ve `-pm-` kodları **birbirine bağlanmaz**; ad benzerliğiyle birleştirme yapılmaz.
- Aynı fiziksel ürün en kötü durumda iki ayrı kayıt olabilir: keşiften gelen fiyatsız `-pm-`
  taslağı (yayına çıkamaz) ve fiyatlı `-p-` ürünü (yayınlanabilir). Kullanıcıya görünen tek kayıt
  fiyatlı olandır; çift kayıt kullanıcıya yansımaz.

## Eski `feature/hb-sitemap-catalog` dalı (3739843)

Dal `main`'e birleştirilmez; `main`'deki 0073 keşif defteri ve keşif toplayıcısı aynı işi daha
yeni bir tasarımla zaten yapıyor.

| Daldaki parça | Karar |
| --- | --- |
| `0074_catalog_discovery.sql` (ayrı defter + işlem tabloları) | Alınmadı: `main` 0073 ile çakışır, aynı kavramı iki tabloda kaydırırdı |
| `catalog-discovery/` (TS akışlı ayrıştırıcı, koşucu) | Alınmadı: `main`'de `catalog-collection/discovery-*` |
| `discovery_catalog.link_prices` (teklif ↔ defter birebir kod) | **Alındı, uyarlandı:** `hb-merge` → `listing_price`, ayrıca tür (`p`/`pm`) denetimi |
| `discovery_catalog.publish` (fiyatsız `offer` + `search_outbox`) | Reddedildi: fiyatsız teklif, "fiyatsız ürün için sahte teklif açılmaz" kuralına aykırı; yerine fiyatsız **taslak ürün** |
| `discovery_catalog.finalize` (kaldırılma/bayatlık) | Ertelendi: `main` defterinde kaldırılma kolonu yok; ayrı karar |
| Ürün sayfasında fiyatsız `/git` çıkışı, `SEO_UNPRICED_PRODUCTS_ENABLED` | Ertelendi: fiyatsız ürün yayına çıkmadığı için gereksiz |

## Çalıştırma sırası (elle)

```
python -m feeds ensure-merchant --profile hbcollect:hepsiburada   # bir kez
python -m feeds hb-merge --run <kapalı koşu>
python -m catalog_build audit --merchant hepsiburada              # yalnız okur
python -m catalog_build build --merchant hepsiburada
python -m catalog_build build-discovery --merchant hepsiburada --limit 10000 --dry-run
python -m catalog_build build-discovery --merchant hepsiburada --limit 10000
python -m catalog_build gate
python -m catalog_build publish --merchant hepsiburada --limit 50 --confirm
```

## Reddedilen alternatifler

| Alternatif | Neden değil |
| --- | --- |
| `resolve` ile Hepsiburada ürünü açmak | Kapısız `published`; başlık benzerliği kimlik değil (0119), AliExpress dahil başka mağazayla yanlış bağ riski |
| `offer.in_stock`'u NULL yapılabilir ya da yeni `offer.stock_state` kolonu | 2,8 milyon AliExpress teklifinin yazıcısı ve parmak izi değişir (yeniden yazım, WAL); onlarca okuyucu değişir. Bilinmeyen stok yalnızca Hepsiburada'da |
| Fiyatsız keşif satırından `offer` açmak | Fiyatsız teklif fiyat karşılaştırmasını, alarmları ve özetleri kirletir; sahte teklif |
| `-p-` ↔ `-pm-` ad benzerliğiyle eşleştirme | Varyant/model farkı (renk, kapasite) adda olmayabilir; doğrulanmamış kimlik |
| Defterdeki tüm satırları tek komutla ürüne aktarmak | ~75 milyon adres → ~44 GB ürün tablosu/indeks; yalnızca açık `--limit` ile kontrollü |
| Panelde `count(*)` | Milyonlarca satırda yavaş; indeks + üst sınır + zaman aşımı |

## Sonuçlar ve riskler

- Hepsiburada teklifleri artık `resolve`'da görünmez; ürünleri yalnızca `catalog_build` açar. Kapı
  7 gün görülmeyen teklifi `held(stale_source_offer)` yapar: toplama haftalık değilse taslaklar
  beklemeye düşer (yayınlanmışlar etkilenmez).
- Keşiften toplu taslak üretimi disk ister (0121 ölçümü ~590 B/ürün). Önce `--dry-run`, sonra
  küçük `--limit`.
- 0083 üretimde `product` ve `catalog_discovery` üzerinde işlem dışı indeks kurar (yazımı
  kilitlemez); boyut ürün sayısıyla orantılı.
