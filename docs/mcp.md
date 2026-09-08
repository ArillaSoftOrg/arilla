# MCP sunucusu

`apps/mcp` — ChatGPT, Claude ve MCP Apps spesifikasyonunu destekleyen diğer
istemcilerde çalışır. Tek sunucu, birden çok istemci.

## Temel kural

**İçinde iş mantığı yoktur.** Her araç `packages/core` içindeki fonksiyona
delege eder. Web ile MCP aynı çekirdeği çağırır; ikisi ayrışırsa iki farklı
ürün ortaya çıkar.

Taşıma: StreamableHTTP. SSE kullanılmaz.

## Araçlar

### `search_products`

Doğal dil ile ürün arama.

| Parametre | Tip | Zorunlu |
| --- | --- | --- |
| `query` | string | evet |
| `category` | string | hayır |
| `max_price` | integer (kuruş) | hayır |
| `size` | string | hayır |
| `limit` | integer, varsayılan 12, en fazla 24 | hayır |

Dönen: ürün listesi — ad, marka, en düşük fiyat, mağaza sayısı, ürün URL'si.

Çekirdek: `search()`. Aynı ayrıştırıcı kademelerinden geçer (`search.md`).

### `find_alternatives`

Bir üründen yola çıkarak daha uygun alternatifler.

| Parametre | Tip | Zorunlu |
| --- | --- | --- |
| `product_url` | string — merchant URL'si veya bizim ürün URL'miz | evet* |
| `product_id` | string | evet* |
| `max_price` | integer | hayır |
| `exclude_brands` | string[] | hayır |

\* İkisinden biri.

`product_url` katalogda yoksa Katman 2 çözümlemesi tetiklenir
(`architecture.md`). Çözümleme uzun sürerse araç "işleniyor" döner, istemci
tekrar sorar.

### `compare_merchants`

Bir ürünün mağazalar arası karşılaştırması.

| Parametre | Tip |
| --- | --- |
| `product_id` | string |
| `size` | string, opsiyonel |

Dönen: mağaza, fiyat, kargo dahil toplam, stok, teslimat süresi, çıkış URL'si.
**Kargo dahil toplama göre sıralanır.**

### `get_price_history`

| Parametre | Tip |
| --- | --- |
| `product_id` | string |
| `days` | integer, varsayılan 90, en fazla 365 |

Dönen: örneklenmiş fiyat serisi + `product_price_stats` özeti (90 günlük min,
güncel yüzdelik dilim, düşüş sayısı).

**Tam seri dönmez**, örneklenmiş hali döner. Fiyat geçmişi korunan varlıktır
(`ops.md`).

## Görsel arama neden yok

MCP istemcileri görsel yüklemeyi standart biçimde taşımıyor ve görsel arama tek
model çağrısı gerektiren en pahalı işlem. Web'de kalır. İstemci desteği
netleştiğinde yeniden değerlendirilir.

## Widget

Sonuçlar metin olarak da anlamlı olmalı; widget bir zenginleştirmedir, tek
gösterim yolu değildir. Widget kaynağının URI'si her derlemede değişir, aksi
halde istemci eski sürümü önbellekten servis eder.

## Kimlik doğrulama

MVP'de anonim. Kaydetme ve alarm araçları yok, dolayısıyla oturum gerekmiyor.

Kullanıcıya bağlı araçlar eklendiğinde OAuth akışı gerekir; o noktada
`session` tablosu üzerinden aynı hesapla eşleşilir.

## Attribution

MCP'den gelen her çıkış `click` kaydı üretir ve `channel = 'mcp'` taşır. Bu
kanalın dönüşümü web'den ayrı ölçülür; ikisinin davranışı farklı olacak.

## Oran sınırı

İstemci başına dakikalık sınır. `api_usage` tablosuna `channel = 'mcp'` ile
yazılır; maliyet takibi web ile aynı yerden yapılır.

## Faz

Faz 4. MVP-0'da çekirdek servisler API-first kurulur ama MCP sunucusu
yazılmaz. Web doğrulanmadan ikinci bir yüzey açmak dikkat dağıtır.
