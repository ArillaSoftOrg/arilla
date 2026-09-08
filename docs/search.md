# Arama

Arama motorunun sözleşmesi. Üç giriş noktası (metin, görsel, link) tek bir
sorgu nesnesine çıkar; nesne katalogda çalışır. Sorgu anında internetten arama
yapılmaz.

## Sorgu nesnesi

```json
{
  "intent": "similar_cheaper",
  "anchor": { "type": "product", "id": 84213 },
  "text": "siyah spor ayakkabı",
  "filters": {
    "category_path": "ayakkabi/sneaker",
    "color": ["black"],
    "price_min": null,
    "price_max": 300000,
    "size_norm": "42",
    "brand_include": [],
    "brand_exclude": ["nike"],
    "in_stock_only": true,
    "merchant_ids": null
  },
  "style_tags": ["minimal"],
  "sort": "balanced",
  "unparsed": "geniş kalıp",
  "confidence": 0.82
}
```

### intent

Hangi `similarity_edge.kind` ile sorgulanacağını belirler. Bu alan olmadan
sıralama anlamsızdır.

| intent | Anlamı | Kullanılan kenar |
| --- | --- | --- |
| `exact` | Bu ürünü bul | — |
| `same_cheaper` | Aynı ürün, ucuz mağaza | `same` |
| `similar_cheaper` | Benzer ama uygun fiyatlı | `visual`, `semantic` |
| `browse` | Keşif, çapa yok | — |

### anchor

Üç giriş noktasını birleştirir. `browse` dışında her sorguda vardır.

- `{ "type": "product", "id": 84213 }` — katalogdaki ürün
- `{ "type": "image", "hash": "…" }` — yüklenen görsel
- `{ "type": "url", "value": "https://…" }` — yapıştırılan link

### filters

Her alan bir indekse karşılık gelir. Karşılığı olmayan alan nesneye eklenmez.

| Alan | Karşılığı |
| --- | --- |
| `category_path` | `category_path_idx` |
| `color` | `product.color` |
| `price_max` / `price_min` | `product_min_price_idx`. Kuruş cinsinden tamsayı. |
| `size_norm` | `offer_variant` join |
| `brand_include` / `brand_exclude` | `product.brand_id` |
| `in_stock_only` | `offer.in_stock` |
| `merchant_ids` | `offer.merchant_id`. Kullanıcı nadiren kullanır. |

`brand_include` ile `brand_exclude` ayrı olmak zorunda: "Nike tarzı ama Nike
olmasın" en sık senaryolardan biri ve tek alanla ifade edilemez.

### style_tags

**Filtre değil, sıralama sinyali.** Zenginleştirme bu etiketleri üretene kadar
çoğu üründe boştur; filtre olarak kullanılırsa boş sonuç döner.

### unparsed

Ayrıştırıcının eşleyemediği kısım. Hata ayıklama için ve kullanıcıya "geniş
kalıp bilgisine sahip değiliz" diyebilmek için tutulur.

### Değerler normalize edilir

Kullanıcı Türkçe yazar, nesne normalize enum tutar. `siyah`, `Siyah`, `black`
hepsi `"black"` olur. Aksi halde aynı şey için üç ayrı değer oluşur.

## Ayrıştırıcı kademeleri

Sırayla denenir, ilk başarıda durulur. Amaç model çağrısını istisna haline
getirmek.

**Kademe 0 — Link.** URL parse, merchant tanı, offer bul. Model yok.

**Kademe 1 — Görsel.** Embedding üret (hash cache'e bakılır), `anchor.image`.
Filtreler boş. Tek zorunlu model çağrısı buradadır.

**Kademe 2 — Sözlük tabanlı ayrıştırma.** Türkçe alışveriş sorgularının büyük
kısmı kalıptır:

- Renk sözlüğü: siyah, beyaz, bej, ekru…
- Kategori sözlüğü ve eşanlamlıları: sneaker / spor ayakkabı / spor ayakkabısı
- Fiyat kalıpları: `3000 tl altı`, `3000 altında`, `-3000₺`, `2000-3000 arası`
- Beden kalıpları: `42 numara`, `M beden`
- Marka listesi: katalogdaki `brand.name_norm` üzerinden

Eşleşme başarılıysa model çağrılmaz.

**Kademe 3 — Küçük model.** Kademe 2 yetersiz kaldığında. Sonuç
`query_resolution` tablosuna normalize sorgu metnine göre yazılır. Aynı sorguyu
yazan ikinci kullanıcı için maliyet sıfırdır. Sorgular ağır tekrar eder.

## Netleştirme

Elle yazılmış şablon yoktur. Netleştirme kategori ağacından türetilir, böylece
katalog değiştikçe kendini günceller.

**Kural:** sorgu birden fazla kategori yoluna anlamlı hacimle düşüyorsa
netleştirme sunulur. Tek kategoriye düşüyorsa sunulmaz.

**Sonuçlar asla bekletilmez.** En olası yorumla sonuçlar hemen gösterilir,
netleştirme sonuçların üstünde tek dokunuşluk seçenek olarak durur.

```
Bisiklet kaskı için 32 sonuç
[ motosiklet ] [ kaykay ] [ iş güvenliği ] [ başka bir şey ]
```

Doğru tahmin ettiysek kullanıcı hiç dokunmaz; yanlış tahmin ettiysek tek
dokunuşla düzeltir. İkisinde de bekleme yoktur.

Kategoriler arasında hacim dengeliyse ve hiçbiri baskın değilse soru çubuğu
sonuçların önüne alınır — ama yine sonuçların yerine geçmez.

`başka bir şey` seçeneği serbest metin girişi açar; her netleştirmede bulunur.

### Yardımcı cümle

"Bisiklet kasklarında şehir modeliyle daha korumacı seçenekler yan yana
duruyor" tipi yönlendirici cümle **kategori başına bir kez** üretilir ve
`generated_content` tablosuna yazılır. Her kullanıcı için üretilmez. Maliyet
kategori sayısına bağlanır, kullanıcı sayısına değil.

## Sıralama

Üç sekme. Her birinin tanımı sabittir; tanımsız sekme kullanıcıyı yanıltır.

**Bizim seçtiklerimiz** (varsayılan)
Alaka × satıcı güveni (`merchant.trust_score`) × stok durumu × fiyat konumu
(`product_price_stats.current_percentile`). Komisyon oranı sıralamada
**belirleyici değildir**; yalnızca diğer her şey eşitken ayrıştırıcıdır.

**En iyi fırsatlar**
Ürünün kendi geçmişine göre şu an ucuz olanlar. Mutlak en düşük fiyat değil.
`current_percentile` düşük olanlar üste çıkar.
`product_price_stats.list_price_inflated = TRUE` olan ürünler bu sekmeden
düşürülür — sahte indirimi fırsat diye sunmak güveni yok eder.

**En yakın eşleşmeler**
Saf `similarity_edge.score`. Fiyat hesaba katılmaz.

## Sonuç sayısı ve sayfalama

Varsayılan 24 sonuç, `?sayfa=` ile devam. `maxResults` sorgu nesnesinin parçası
değil, API çağrısının parametresidir.

## Gereken tablolar

```sql
-- Ayrıştırma sonucu cache'i. Aynı sorgu iki kez modele gitmez.
CREATE TABLE query_resolution (
    query_norm      TEXT        PRIMARY KEY,
    parsed          JSONB       NOT NULL,
    candidate_categories BIGINT[],
    needs_clarification  BOOLEAN NOT NULL DEFAULT FALSE,
    parser_tier     SMALLINT    NOT NULL,      -- 2 = sözlük, 3 = model
    hit_count       INTEGER     NOT NULL DEFAULT 1,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX query_resolution_popular_idx ON query_resolution (hit_count DESC);

-- Sözlükler. Veritabanında tutulur ki kod değişmeden güncellenebilsin.
CREATE TABLE lexicon (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind        TEXT   NOT NULL
                CHECK (kind IN ('color','category','brand','size','material','style')),
    surface     TEXT   NOT NULL,              -- 'spor ayakkabı'
    normalized  TEXT   NOT NULL,              -- 'ayakkabi/sneaker'
    weight      REAL   NOT NULL DEFAULT 1.0,
    CONSTRAINT lexicon_uniq UNIQUE (kind, surface)
);
CREATE INDEX lexicon_surface_idx ON lexicon (surface);
```

`lexicon` tablosunun veritabanında olması önemli: yeni bir eşanlamlı eklemek
için sürüm çıkmaya gerek kalmaz.

## Ölçüm

Her arama `api_usage` tablosuna yazılır: hangi kademede çözüldü, cache'e
düştü mü, maliyeti ne. Kademe 3'e düşen sorguların oranı **birim ekonomisinin
ana göstergesidir**. Bu oran yükseliyorsa sözlükler eksik demektir; çözüm daha
büyük model değil, sözlüğü genişletmektir.
