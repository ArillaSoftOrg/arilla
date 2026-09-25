# services/ingest

Python 3.12 toplu isleri. Feed toplama, zenginlestirme, eslestirme ve benzerlik
uretimi burada calisir.

## Mimari sinir

**Bu servis hicbir HTTP endpoint sunmaz.** TypeScript tarafi bu servisi asla
cagirmaz; tek iletisim kanali PostgreSQL ve Redis kuyrugudur. Servis kuyruktan
is alir ve veritabanina yazar.

Sema uzerinde okuma ve yazma yetkisi vardir, **migration uretme yetkisi
yoktur** — semanin tek sahibi `packages/db`.

Baglanti `DATABASE_URL` ile, yani **`arilla_app`** rolu ile kurulur. Bu rol
superuser degildir: `price_point` ve `variant_stock_event` uzerinde yalnizca
SELECT ve INSERT yapabilir. Yanlislikla yazilan bir `UPDATE price_point`
veritabani tarafindan reddedilir.

## Klasorler

| Klasor | Ne yapar | Gorev |
| --- | --- | --- |
| `collect/` | Feed, API ve ag dokumu okuma (Katman 1) | B1 ✅ |
| `collect/link/` | Kullanici linki cozumleme (Katman 2) | B2 ✅ |
| `enrich/` | Gorsel indirme, hash, embedding uretimi | B3 ✅ |
| `resolve/` | Katmanli eslestirme, `match_candidate` yazimi | B4 ✅ |
| `similarity/` | Gecelik `similarity_edge` ve `product_price_stats` | B5 ✅ |
| `db/` | Ortak veritabani baglantisi | — |

## Kurulum

Python 3.12 gerekir.

```bash
cd services/ingest
python -m venv .venv
.venv/Scripts/activate        # Windows; Linux/macOS: source .venv/bin/activate
pip install -e ".[dev]"
```

## Calistirma

```bash
python -m collect --merchant <slug>
```

Cikis kodu: `success` icin 0, `partial` ve `failed` icin 1 — cron ve izleme
bunu kullanir. Her kosu `ingest_run` tablosuna yazilir; kosu patlasa bile satir
`failed` olarak kapanir. **Sessiz basarisizlik yoktur.**

### Toplama kapisi (0031)

Connector kurulmadan once `collect/gate.py` sorulur. Kapi kapaliysa magazaya
istek gitmez, offer ve `price_point` yazilmaz; `ingest_run` `failed` kapanir,
`error_text` `refused:<kod>` ile baslar, CLI `refused <kod>` basar.

| Kosul | Kod |
| --- | --- |
| `merchant.is_active` false (her kaynak) | `merchant_inactive` |
| Shopify: `feed_config.currency_verified` tam olarak JSON `true` degil | `currency_unverified` |
| Shopify: `feed_config.currency` tam olarak `"TRY"` degil | `currency_not_try` |
| Shopify: `feed_config` JSON nesnesi degil | `feed_config_invalid` |

`collect.bootstrap` da `run_ingest` uzerinden ayni kapidan gecer.

### Shopify para birimi dogrulamasi (salt okunur)

```bash
python -m collect.verify_currency                        # tum Shopify merchant'lari
python -m collect.verify_currency --merchant <slug>      # tekrarlanabilir
python -m collect.verify_currency --report rapor.json    # JSON kanit dosyasi
```

Merchant basina `https://<merchant.domain>/meta.json` adresine **tek istek**;
yeniden deneme yok, yonlendirme izlenmez, saniyede en fazla 1 istek, 10 sn zaman
asimi. Yalnizca `currency` tam olarak `"TRY"` ise PASS. Zaman asimi, ag hatasi,
2xx disi yanit, bozuk JSON, eksik/TRY disi para birimi ve gecersiz alan adi o
merchant icin FAIL; rapor devam eder. Cikis: hepsi PASS ise 0, FAIL varsa 1,
bilinmeyen `--merchant` ise 2 (istek atilmaz).

Komut **hicbir sey yazmaz**: baglanti `read_only`, `currency_verified`,
`is_active` ve `feed_config` degismez. Canli kosu ve sonucun veritabanina
tasinmasi (migration) ayri, onayli adimlardir.

## Test

```bash
.venv/Scripts/python -m pytest -q                      # tumu
.venv/Scripts/python -m pytest -q -m "not integration" # veritabani olmadan
.venv/Scripts/python -m ruff check .
```

Entegrasyon testleri kurulum ve temizligi **sahip rolle** (`DATABASE_URL_OWNER`),
boru hattini **uygulama rolu** ile calistirir. `arilla_app` `price_point`
satirlarini silemedigi icin temizlik baska turlu zaten yapilamaz.

---

## `feed_config` sozlesmesi

Alan eslemesi ve tasima ayari tamamen `merchant.feed_config` (JSONB) icinden
gelir. **Hicbir saglayicinin alan semasi koda gomulu degildir**; yeni bir
merchant veya ag eklemek bir config satiri yazmaktir, kod degistirmek degil.
Bkz. `docs/decisions/0012-connector-arayuzu.md`.

```jsonc
{
  "transport": {
    "record_path": "channel/item",   // XML dugumu | JSON yolu (data.products)
    "auth":       { "kind": "bearer_env", "env": "MERCHANT_X_TOKEN" },
    "pagination": { "kind": "page_number", "param": "page",
                    "size_param": "limit", "size": 100 },
    "rate_limit": { "requests_per_second": 2 },
    "format": "xml",                 // ag dokumu XML ise
    "gzip": true, "delimiter": ";", "encoding": "utf-8"
  },
  "mapping": {
    "external_id": "g:id",           // ZORUNLU
    "url":         "g:link",         // ZORUNLU
    "title":       "g:title",        // ZORUNLU
    "price":       "g:price",
    "list_price":  "g:sale_price",
    "image_url":   "g:image_link",
    "brand":       "g:brand",
    "category":    "g:product_type",
    "gtin":        "g:gtin",
    "availability": "g:availability",
    "shipping_days": "g:shipping_days",
    "shipping_cost": "g:shipping",
    "variants": { "path": "g:sizes", "size": "g:size", "availability": "g:stock" }
  },
  "value_formats": {
    "decimal_separator": ",", "thousands_separator": ".",
    "in_stock_values": ["in stock", "1", "var"]
  },
  "full_dump": false
}
```

### Onemli alanlar

**`auth.env`** okunacak ortam degiskeninin **adidir**; token degeri ne burada
ne depoda durur (`docs/ops.md`). Degisken bossa kosu hic baslamaz.

**`full_dump`** varsayilan `false`. `true` yapilirsa, feed'de gorunmeyen
teklifler koşu `success` bittiginde `is_active = false` olur. Delta feed veya
yarim inmis bir dosyayi tam dokum sanmak katalogu sessizce kapatir; bu yuzden
acikca isaretlenmesi gerekir.

**`value_formats`** fiyat metnini kurusa cevirir. Ara adimda `Decimal`
kullanilir, `float` hic devreye girmez — para tamsayidir.

## `source_type` ve connector

| `merchant.source_type` | Connector | Tasimanin getirdigi |
| --- | --- | --- |
| `xml_feed` | `XmlFeedConnector` | Tek GET, `iterparse` ile akis |
| `api` | `RestApiConnector` | Auth, sayfalama (`page_number` / `cursor`), oran siniri |
| `affiliate_network` | `NetworkDumpConnector` | CSV/XML dokum, gzip, kodlama |
| `shopify` | `ShopifyConnector` | `/products.json` sayfalama, renk bolme, urun tavani |
| `user_discovered` | — | Toplu kaynak degil; kullanici linki B2'nin isi |

Yeni bir tasima eklemek: `collect/sources/` altina modul yaz ve
`register("<source_type>", factory)` cagir.

## Toplama kurallari

1. **Idempotent.** `(merchant_id, external_id)` uzerinde upsert; ayni feed iki
   kez islendiginde yeni `offer` satiri olusmaz.
2. **`price_point` her kosuda yazilir**, fiyat degismemis olsa bile.
   Surekliligin kendisi veridir.
3. **`variant_stock_event` yalnizca durum DEGISTIGINDE.** Yazmadan once mevcut
   durum okunur; her kosuda yazilirsa tablo siser.
4. **`offer.product_id`'ye dokunulmaz.** Eslestirme B4'un isi; eslesmemis offer
   sistemde yasayabilir.
5. **Reddedilen kayit kosuyu durdurmaz.** Sayilir, kosu `partial` biter. Tek
   bozuk satir yuzunden 10.000 urun birakilmaz.
6. **Para birimi uydurulmaz.** `NormalizedOffer.currency` varsayilansizdir:
   kaynagin alani ya da dogrulanmis `feed_config.currency` (0029). Shopify
   teklifi TRY disinda yazilmaz (0031); doviz cevrimi yok.
7. **Shopify urun tavani.** `transport.shopify.max_products` yoksa 30. Yalnizca
   1–3500 arasi JSON tamsayisi; gecersiz deger istekten once hata verir. Tavan
   kanonik urun sayisidir (renk bolmesinden once), sayfalar arasinda da gecerli;
   tavan dolunca sonraki sayfa istenmez.

---

## Katman 2 — kullanici linki cozumleme

Kullanici katalogda olmayan bir urun linki yapistirdiginda **yalnizca o URL**
getirilir. Sonuc cache degil, kalici katalog kaydidir
(`discovery_source = 'user_link'`).

```bash
python -m collect.link "https://magaza.example/urun/canta"   # tek link
python -m collect.link --refresh                              # fiyat rotasyonu
```

### Sinirlar

- **Yalnizca kullanici istegiyle.** Zamanlanmis tarama yoktur.
- **Yalnizca verilen URL.** Sayfadaki linkler izlenmez; bu bir tarayici degil.
- **`robots.txt` atlatilmaz.** Izin yoksa cozumleme reddedilir ve kataloga
  hicbir sey yazilmaz. Atlatma bayragi yoktur.
- **Toplu kazima yoktur** ve eklenmeyecektir (`docs/decisions/0004`).

### Cikarim sirasi

| Sira | Kaynak | Guven |
| --- | --- | --- |
| 1 | JSON-LD (`schema.org/Product`) | yuksek — yayinlanmis standart |
| 2 | OpenGraph / microdata | orta |
| 3 | HTML sezgisel | **dusuk** — `attributes_raw.low_confidence = "true"` |

Ucuncu katman son caredir ve ciktisi kalici olarak isaretlenir: yanlis fiyat
gostermek, fiyat gostermemekten kotudur.

### Kimlik ve idempotentlik

`external_id` normalize URL'den turetilir: izleme parametreleri (`utm_*`,
`gclid`, `fbclid`, `ref`) atilir, `www.` ve fragment duser, kalan parametreler
siralanir. Boylece ayni urun farkli paylasim linkleriyle geldiginde tek bir
`offer` olur — ama her cozumleme bir `price_point` ekler.

Standart disi port korunur; `merchant.domain` porta bagli degildir.

### Bilinmeyen magaza

Taninmayan alan adi icin `source_type = 'user_discovered'`,
`affiliate_status = 'none'` ile yeni bir `merchant` acilir. Katalog talebe gore
buyur. Gerekce: `docs/decisions/0014`.

---

## Zenginlestirme — embedding uretimi

Embedding'ler barindirilan cok-kipli bir API'den alinir (Jina CLIP v2, 768
boyut, metin ve gorsel ayni uzayda). Karar: `docs/decisions/0015`, kullanim
kararlari: `docs/decisions/0016`.

```bash
python -m enrich --kind both                  # gorsel + metin
python -m enrich --kind image --limit 100     # yalnizca gorsel, ilk 100
python -m enrich --kind both --fake-client    # API anahtari olmadan
```

### Tek kural

> Her offer icin bir `embedding` satiri; her FARKLI icerik icin bir API cagrisi.

Arama offer embedding'leri uzerinden gider (`embedding_ann_idx`,
`WHERE target_type = 'offer'`), o yuzden her offer'in kendi satiri olmali.
Ama pahali olan satir degil, model cagrisi: ayni gorsel yuz offer'da gecse
bile saglayiciya bir kez gider. Tohum katalogunda 400 offer / 8 farkli gorsel
→ 400 satir, 8 gorsel.

Ikinci kosu embedding satiri olan offer'lari hic secmez → **sifir cagri.**

### Saklanmayanlar

Indirilen gorsel bayti **hicbir yere yazilmaz**. Kalici olan yalnizca
`offer.image_hash` (SHA-256) ve vektor.

### Maliyet

Her API cagrisi `api_usage`'a yazilir (`CLAUDE.md` 9. kural). `units` token
sayisidir; `cost_micros` `EMBEDDING_COST_MICROS_PER_1K_TOKENS` ile hesaplanir
ve o degisken **gercek fiyat bilinene kadar 0'dir**. Sifir maliyet "maliyet
yok" demek degil, "fiyat henuz baglanmadi" demektir.

Yineleme isabetleri `api_usage` satiri uretmez — onlar model cagrisi degil;
sayilari kosu ciktisinda raporlanir.

### Yerel gosterim (API anahtari olmadan)

```bash
# 8 farkli PNG'yi her yola eslestiren fixture sunucusu
python scripts/fixture_image_server.py --port 8099 &

# tohum verisinin gorsellerini oraya yonelt
SEED_IMAGE_BASE_URL=http://127.0.0.1:8099 pnpm seed

python -m enrich --kind both --fake-client
```

`--fake-client` deterministik ve normalize vektorler uretir ama **anlamsal
degildir**; yalnizca boru hattinin dogrulugunu (yineleme, idempotentlik,
satir sayilari) sinar. CLI her kosuda bunu uyarir.

---

## Eslestirme (B4)

```bash
python -m resolve                    # eslesmemis offer'lari eslestir
python -m resolve --merchant-id 12   # yalnizca bir magaza
python -m resolve --dry-run          # yaz, commit etme
python -m resolve --no-create        # eslesmeyen icin yeni urun ACMA
python -m resolve --calibrate        # esik olcumu (veritabani gerekmez)
```

### Akis

```
offer (product_id NULL)
  -> adaylar: gtin/mpn, baslik trigram, gorsel ANN
  -> skorla, veto uygula
       >= 0.87  auto_accepted + offer.product_id BAGLANIR
       >= 0.66  pending — insan kuyrugu (D5), BAGLANMAZ
       <  0.66  yeni product acilir + offer baglanir
```

### Vetolar

Renk, hacim, beden, model kademesi (`Pro`/`Plus`) ve marka uyusmazligi
eslesmeyi **sifirlar**, skoru dusurmez. Yalnizca iki tarafta da bilinen bir
ozellik catisirsa veto edilir — eksik bilgi veto sebebi degildir.

Renk vetosu zorunlu: `product` renk duzeyinde kanoniktir, "Bilekli Bot Siyah"
ile "Bilekli Bot Bej" baslikta neredeyse ayni.

### Esikler ve regresyon seti

Esikler UYDURULMADI: `tests/fixtures/matching/pairs.json` icindeki 30 eslesme
+ 30 eslesmeme ciftinden olculdu. `--calibrate` olcumu yeniden uretir.

`CLAUDE.md` bu seti zorunlu kiliyor — esik degistiginde neyin bozuldugu baska
turlu gorulemez. Set ilk kosuda skorlamanin zayif oldugunu gosterdi:
"Kosu Ayakkabisi Pro" ile "Kosu Ayakkabisi" 1.000 aliyordu. Gerekce ve olculen
degerler: `docs/decisions/0017-eslestirme-esikleri.md`.

Insan karari (`accepted` / `rejected`) makine tarafindan **ezilmez**.

---

## Benzerlik ve fiyat istatistikleri (B5)

```bash
python -m similarity            # kenarlar + istatistikler
python -m similarity --edges    # yalnizca kenarlar
python -m similarity --prices   # yalnizca fiyat istatistikleri
python -m similarity --dry-run
```

**`pnpm seed` bu tablolari ARTIK doldurmuyor.** Tek dogru kaynak burasi.
Gelistirme akisi:

```bash
SEED_IMAGE_BASE_URL=http://127.0.0.1:8099 pnpm seed
python -m enrich --kind both --fake-client
python -m similarity
```

### Kenarlar

| Kenar | Kaynak | Taban |
| --- | --- | --- |
| `visual` | `embedding.kind = 'image'` | 0.55 |
| `semantic` | `embedding.kind = 'text'` | 0.45 |

Urun basina en fazla 8 kenar; tabani gecmeyen aday YAZILMAZ. Kenarlar cift
yonlu yazilir (`similarity_lookup_idx` sorguyu `product_a` uzerinden yapiyor).

`same` ve `substitute` uretilmez — biri B4 sonrasi anlamsiz, digeri tiklama
verisi gerektiriyor.

### Fiyat istatistikleri

`min/medyan/max/yuzdelik` tum teklifler uzerinden; **siraya bagli olanlar
(dusus sayisi, sahte indirim) TEKLIF BASINA** hesaplanip urune toplanir.

Bu ayrim kritik: bir urunun iki magazadaki liste fiyatlari farkli oldugu icin
serileri karistirmak hayali "liste zammi" uretir. Ilk surum boyle yapiyordu ve
200 urunun 75'ini sahte indirim isaretlemisti; duzeltmeden sonra tam 5 buluyor
(tohumun kasitli urettigi sayi).

Gerekce ve olculen degerler: `docs/decisions/0018-benzerlik-uretimi.md`.
