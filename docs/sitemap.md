# Sitemap ve makine okunur uçlar

## Yapı

Tek bir index, altında konuya göre bölünmüş haritalar. Bölme keyfi değil:
her grubun güncellenme sıklığı farklı, tek dosyada toplanırsa her ürün
değişiminde 2 MB'lık dosya yeniden üretilir.

```
/sitemap.xml                        index
├── /sitemap-sayfalar.xml           statik sayfalar + kategoriler (~150 URL)
├── /sitemaps/urun/index.xml        → 1.xml … N.xml
├── /sitemaps/alternatif/index.xml  → 1.xml … N.xml
├── /sitemaps/magaza/index.xml      mağaza bazlı sayfalar
├── /sitemaps/trend/index.xml       dönemsel trend sayfaları
└── /sitemaps/creator/index.xml     creator vitrinleri ve koleksiyonlar
```

## Parçalama kuralları

- Dosya başına en fazla **50.000 URL** ve sıkıştırılmamış **50 MB**.
- Tüm haritalar gzip ile servis edilir (`.xml.gz` de kabul edilir, biz `.xml`
  üretip `Content-Encoding: gzip` veriyoruz).
- Parça numarası ürün ID aralığına göre sabittir, yeniden numaralandırılmaz.
  Aksi halde her yeniden üretimde tüm parçalar değişmiş görünür.
- `lastmod` **gerçek** değişiklik zamanıdır. Her gece tüm sayfalara bugünün
  tarihini yazmak sinyali işe yaramaz hale getirir ve güven kaybettirir.

### priority ve changefreq hakkında

Dupe bu alanları dolduruyor (0.8–0.9, weekly) ama Google bu iki alanı uzun
süredir dikkate almadığını açıkça belirtti. Biz de **yazmıyoruz.** Yalnızca
`loc` ve `lastmod` üretilir. Daha az kod, daha az yalan sinyal.

## Hangi sayfa haritaya girer

Bu bölüm en önemlisi. Katalog kullanıcı linkleriyle büyüdüğü için tek teklifli,
içi boş ürün sayfaları hızla birikecek. Bunları haritaya koymak site geneli
kalite algısını düşürür.

Bir ürün sayfası haritaya girer, ancak:

- En az **2 aktif teklifi** varsa (karşılaştırılacak bir şey var demektir), veya
- Tek teklifi var ama en az **14 günlük fiyat geçmişi** birikmişse, ve
- Ürünün görseli ve başlığı varsa, ve
- Kategorisi `is_discoverable` ise.

Şartı sağlamayan sayfa yayında kalır ama haritaya girmez ve `noindex` alır.
Şart sonradan sağlanınca otomatik olarak haritaya girer.

Alternatif sayfası (`/alternatif/<slug>`) haritaya girer, ancak en az
**3 alternatifi** varsa. Boş bir "benzer ürünler" sayfası zararlıdır.

## Sayfa grupları

### Statik sayfalar

```
/                          ana sayfa
/hakkinda /iletisim /sss
/gizlilik /kosullar /cerez
/kesfet /firsatlar /trend
```

### Kategori sayfaları

```
/kategori/<path>
/kategori/<path>/<fiyat-araligi>     '2000-tl-alti-omuz-cantalari'
```

Fiyat aralığı sayfaları yalnızca anlamlı hacim varsa üretilir; her kategori ×
her aralık kombinasyonu üretilirse binlerce ince sayfa oluşur.

### Ürün sayfaları

```
/urun/<slug>
```

Hacmin tamamını bu grup taşır. Parça başına 50.000 URL.

### Alternatif sayfaları

Dupe'un "reports" katmanının bizdeki karşılığı. Onlar "best X dupes" kalıbıyla
yüzlerce sayfa üretmiş; biz aynı işi ürün ilişkilerinden otomatik yapıyoruz.

```
/alternatif/<product-slug>          "X'e benzer daha uygun fiyatlı ürünler"
```

Başlık kalıbı sabit tutulmaz — aynı kalıbın binlerce kopyası şablon içerik
sinyali verir. En az üç farklı başlık şablonu dönüşümlü kullanılır ve sayfa
gövdesi gerçek veriden (fiyat aralığı, mağaza sayısı, tasarruf tutarı) üretilir.

### Mağaza sayfaları

Dupe'un "steals" katmanının karşılığı.

```
/magaza/<domain>                    o mağazadaki fiyatı düşen ürünler
```

Her merchant için bir sayfa. Bölgesel alt alan adları ayrı sayılmaz — bizim
merchant tablomuz zaten tekil.

### Trend sayfaları

```
/trend                              tüm listeler
/trend/<slug>                       'yaz-trend-parfumleri'
```

**Dönem boyunca sabit kalır.** Günlük değişen sayfa sıralanmaz.

### Creator sayfaları

```
/@<handle>
/@<handle>/<collection-slug>
```

Dupe'da bu katman yok; bizim ayırt edici tarafımız. Yalnızca `is_public`
koleksiyonlar ve en az bir ürünü olan vitrinler girer.

## robots.txt

```
User-agent: *
Disallow: /git/
Disallow: /panel/
Disallow: /yonetim/
Disallow: /gecmis
Disallow: /hesap
Disallow: /ara
Allow: /

Sitemap: https://<alan-adi>/sitemap.xml
```

`/ara` kapalı çünkü arama sonucu sayfaları hem sonsuz sayıda hem düşük değerli.
Aranan kelimeye karşılık gelen kalıcı sayfamız zaten `/kategori` ve
`/alternatif`.

## Üretim

- Haritalar **toplu işle** üretilir, istek anında değil.
- Ürün ve alternatif haritaları gecelik, statik ve kategori haritaları haftalık.
- Üretim sonrası doğrulama: URL sayısı, dosya boyutu, ölü bağlantı örneklemesi.
- Arama konsoluna index gönderilir; alt haritalar ayrıca gönderilmez.

## Makine okunur uçlar

Dupe bunları eklemiş ve mantıklı: AI istemcilerinin siteyi anlaması için.
Bizim zaten bir MCP sunucumuz olacağı için maliyeti düşük.

```
/llms.txt                              site ne yapar, ana uçlar, kullanım koşulları
/.well-known/mcp/server-card.json      MCP sunucu tanıtım kartı
```

`llms.txt` içeriği: ürünün ne yaptığı, hangi kategorileri kapsadığı, veri
kaynağının ne olduğu, ticari kullanım koşulları ve MCP sunucusunun adresi.

Bu uçlar `robots.txt` ile engellenmez.

**Not:** Kendi kataloğumuzun toplu olarak kazınmasını istemiyoruz
(bkz. `ops.md`). `llms.txt` siteyi anlatır, veri dökümü sunmaz. İkisi farklı
şeyler ve karıştırılmamalı.

## Faz dağılımı

| Faz | Haritalar |
| --- | --- |
| MVP-0 | `/sitemap.xml`, `/sitemap-sayfalar.xml`, ürün parçaları |
| MVP-1 | `/firsatlar`, mağaza sayfaları |
| MVP-2 | creator haritası |
| Faz 4 | alternatif ve trend haritaları, `llms.txt`, MCP kartı |

Alternatif haritası bilinçli olarak geç: yeterli `similarity_edge` verisi
birikmeden üretilen sayfalar boş çıkar ve ilk izlenim kalıcıdır.
