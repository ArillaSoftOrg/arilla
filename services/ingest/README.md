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
| `collect/` | Feed, API ve ag dokumu okuma; kullanici linki cozumleme | B1 ✅, B2 |
| `enrich/` | Gorsel indirme, hash, embedding, oznitelik cikarimi | B3 |
| `resolve/` | Katmanli eslestirme, `match_candidate` yazimi | B4 |
| `similarity/` | Gecelik `similarity_edge` ve `product_price_stats` | B5 |
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
