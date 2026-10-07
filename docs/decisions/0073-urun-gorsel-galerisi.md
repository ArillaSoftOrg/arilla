# 0073 - Urun gorsel galerisi (offer_image)

## Karar

Tek gorsel modelinden (`offer.image_url` -> `product.primary_image_url`) coklu
galeriye gecilir. Gorsel ilk olarak offer'dan gelir; yeni tablo **`offer_image`**
(migration 0053) offer'a baglidir, urun galerisi okuma aninda tek offer'in
gorsellerinden kurulur.

- Kaynakta en fazla `MAX_SOURCE_IMAGES = 6`, kullaniciya en fazla
  `MAX_DISPLAY_IMAGES = 3` (tek yer: `services/ingest/collect/images.py`; okuma
  tarafi `packages/core/src/media/gallery-config.ts`, esitligi test dogrular).
- `source_position` (magaza sirasi) ile `display_rank` (bizim sira, NULL =
  saklanir ama gosterilmez) ayridir.
- Secim deterministiktir, model yok: gecersiz URL ele, normalize URL ile tekrari
  ele, GUCLU isaretli yer tutucu/beden tablosu/ikon/kucuk resmi ele, temsili
  gorsel `display_rank=0`, kalan iki yer once varyanta bagli, sonra kaynak sirasi.
  Eleme tek gorsel birakmazsa geri alinir (tahminle gercek gorsel silinmez).
- Varyant: Shopify `images[].variant_ids` kanitliysa (urun renklere bolunmusse)
  gorsel yalniz o rengin offer'ina girer (`is_variant_specific`), baska rengin
  gorseli alinmaz, bagi olmayan ortak sayilir. Kanit yoksa iliski uydurulmaz.
- Okuma: `r2_url ?? source_url ?? legacy primary_image_url ?? yer tutucu`.
  Liste/arama kartlari yalniz `product.primary_image_url` okur (tek gorsel);
  `offer_image` yalniz urun detayinda okunur (test kilitler).
- Ingest gorsel indirmez: yalniz metadata, offer basina TEK toplu ifade
  (`unnest`); degisim yoksa UPDATE yok. Kaldirilan gorsel `removed` olur
  (silinmez), geri gelirse yeniden `active`. `r2_url`/`image_hash` ingest'e
  dokunulmaz. R2 aynalama ayri, sonradan yazilacak is (karar 0062).
- `product.primary_image_url` ve `offer.image_url` KALIR (geri donus yolu).
  Kaldirilmasi ayri, gelecekteki migration.

## Neden `offer_image` (product_image degil)

- Gorselin kaynagi offer: `offer_id` zaten provenance; ayri `source_offer_id`
  kolonu gerekmez.
- Offer, urunden ONCE olusur ve eslesmemis offer yasayabilir (`offer.product_id`
  NULL). Gorsel yazimi eslestirmeye bagimli olmaz; ingest ile resolve ayrik kalir.
- Ayni urun baska merchant'ta baska gorselle gelince galeri karismaz; hangi
  offer'in gorselinin gosterildigi belli ve degistirilebilir (`getProductGallery`
  once `primary_image_url`in geldigi offer'i, sonra stoklu/ucuz olani secer).
- `product_image` urun duzeyinde projeksiyon ister: eslesme/yeniden eslesme,
  offer degisimi ve cok merchant'ta tutarlilik isi cikarir. Gerekirse ileride
  `offer_image` uzerinden turetilir.

## Depolama (olculen; yerel PostgreSQL 17, gercekci URL uzunlugu)

Satir basina ~345 bayt (heap + 3 indeks: PK, `(offer_id,url_hash)`,
`(offer_id,display_rank)`).

| Senaryo (9.137 offer) | Satir | Heap | Indeks | Toplam |
| --- | ---: | ---: | ---: | ---: |
| ort. 1 gorsel | 9.137 | 1,93 MB | 0,95 MB | 2,9 MB |
| ort. 3 gorsel | 27.411 | 5,79 MB | 3,45 MB | 9,3 MB |
| en fazla 6 gorsel | 54.822 | 11,43 MB | 6,59 MB | 18,1 MB |

Mevcut DB ~47 MB: en kotu durum (+18 MB) DB'yi ~%38 buyutur; beklenen (3-4
gorsel) +9-12 MB. Bloat/ek indeks icin %30 pay birakin.

## 120M olcek: her offer icin 6 PostgreSQL satiri uygun degil

Lineer: 120M x 6 = 720M satir x ~345 B = **~250 GB** (bloat ile ~320 GB), mevcut
cekirdek katalogun (~396 GB) uzerine %63 ekler; ayrica 3 indeksin RAM'de
tutulmasi, vacuum ve yedek maliyeti. 120M x 3 gosterilen = ~125 GB; 120M x 1 =
~41 GB. Bu yuzden iki asamali model:

1. **Shopify/mevcut olcek (< ~10M offer):** `offer_image` bugunku haliyle (<=6
   satir/offer; 10M offer ~ 21 GB).
2. **Admitad olcegi:** ham kaynak dizisi (<=6 URL) feed staging/R2'de kalir;
   PostgreSQL'e yalniz **gosterilen** gorseller (rank 0 her offer, rank 1-2 yalniz
   goruntulenen/populer urunler) ve provenance girer. `offer_image` bunun icin
   ayni sema ile kullanilir (`display_rank IS NOT NULL` satirlari); `removed`
   satirlar periyodik budanir. Gerekirse tablo `offer_id` hash partition'a alinir.
   Bu gecis sema degistirmez, yazma politikasini (hangi satir yazilir) degistirir.

## Lazy R2 aynalama (uygulanmadi; uzanti noktasi hazir)

Ayri, yeniden calistirilabilir worker: `r2_url IS NULL AND display_rank IS NOT
NULL AND status='active'` satirlarini onceliklendirir (goruntulenen, populer,
kaynak URL'si sorunlu, stratejik), indirir, `processImage`/`buildMediaKey`
(karar 0062) ile `products/` altina yazar, `r2_url`, `image_hash`, boyutu
doldurur; olu kaynak icin `status='broken'`. Ingest bu kolonlara dokunmaz.
Aynalamanin sirasi icin kismi indeks gerektiginde worker kendi migration'ini ekler.

## Production backfill plani (bu gorevde CALISTIRILMADI)

- **A (guvenli):** `python -m collect.backfill_images` (varsayilan dry-run) ->
  `--apply`. Aktif offer'lardan `offer.image_url` -> `display_rank=0`; yalniz hic
  `offer_image` satiri olmayan offer'lara yazar, anahtar kumeli 500'luk gruplar,
  her grup tek ifade + commit, yarida kesilirse yeniden calistirilabilir.
  Tahmin: ~9.1k satir (~3 MB), ~19 grup, saniyeler; ag yok.
- **B:** normal Shopify ingest'in yeniden calistirilmasi (idempotent upsert).
  Request hacmi: sayfa boyutu 50 -> en fazla ~183 `products.json` istegi (offer
  >= urun; renk bolunmesi urun sayisini offer sayisinin altinda tutar) + magaza
  basina robots; hiz sinirlari 1,5 rps -> ~2-5 dk istek suresi, toplam ~10-20 dk.
  Yazma: offer basina 1 ifade (~9.1k), ~27k-55k satir (9-18 MB). Retry/checkpoint:
  mevcut ingest davranisi (2 retry; chunk/checkpoint dali `feature/shopify-
  canonical-domains`ta - o dal birlesince `write_offer_images` chunk basina tek
  cagriyla kullanilmali). Sira: once migration 0053 prod'a, sonra kod, sonra A, sonra B.
- A ve B sonrasinda `getProductGallery` otomatik galeriyi kullanir; geri alma:
  kodu geri al (tablo zararsiz kalir) ya da `TRUNCATE offer_image`.

## Reddedilen

- `product.image_url_2/3` sabit kolonlari: sayi sabitlenir, provenance yok.
- Gorsel binary/base64'u PostgreSQL'de: depolama ve yedek maliyeti.
- Ingest icinde indirme/R2 yukleme: ana transaction'i ag gecikmesine baglar.
- Model/AI ile gorsel secimi: kural 1 ve maliyet; deterministik yeterli.
- Liste kartinda `offer_image` JOIN'i: her sorguyu agirlastirir, kart basina
  birden cok gorsel indirir.

## Bilinen kisitlar / sonraki adimlar

- `product.primary_image_url` offer gorseli degisince guncellenmez (bugunku
  davranis); aynalama worker'i rank 0'i R2'ye alirken proje edebilir.
- Shopify'da temsili varyant gorseli yoksa `image_url` (eski davranis) rank 0 olur;
  iliski iddiasi tasimaz (`is_variant_specific=false`).
- Gorsel hash/perceptual hash ile gelismis tekrar tespiti indirme isi gelince.
- Migration numarasi (0053) ve karar numarasi (0073) acik dallarla cakisirsa
  birlestirirken yeniden numaralandirilir.
