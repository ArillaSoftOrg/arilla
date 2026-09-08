# Sözlük

Terimler kodda İngilizce, arayüzde Türkçe kullanılır. Bu tablo ikisi arasındaki
karşılığı sabitler.

| Terim | Arayüzdeki karşılığı | Tanım |
| --- | --- | --- |
| `product` | ürün | Kanonik ürün. Renk düzeyinde tekildir: siyah ve bej ayrı `product`. |
| `offer` | mağaza teklifi | Bir merchant'ın bir ürün sayfası. Bir `product`'ın birden çok `offer`'ı olur. |
| `offer_variant` | beden | Bir `offer`'ın beden satırı. Stok bu düzeyde takip edilir. |
| `merchant` | mağaza | Satıcı site. Trendyol, bağımsız marka, vb. |
| `model_key` | — | Aynı modelin farklı renklerini bağlayan anahtar. Arayüzde "diğer renkler". |
| `price_point` | fiyat geçmişi | Zaman içindeki fiyat gözlemi. Sadece eklenir. |
| `similarity_edge` | alternatif | İki ürün arasındaki benzerlik ilişkisi. |
| `anchor` | — | Aramanın çıkış noktası: ürün, görsel veya link. |
| `intent` | — | Aramanın amacı: aynısının ucuzu, benzeri, keşif. |
| `match_candidate` | eşleştirme adayı | İki kaydın aynı ürün olabileceği iddiası, skorlu. |
| `click` | çıkış | Kullanıcının merchant'a yönlendirildiği an. Attribution buradan başlar. |
| `conversion` | dönüşüm | Merchant'ta gerçekleşen satın alma. |
| `creator` | creator | İçerik üreticisi. Türkçeleştirilmez, sektörde bu haliyle kullanılıyor. |
| `collection` | koleksiyon | Creator'ın ürün listesi. |
| `public_find` | keşif | Keşfet akışındaki ürün. `curated` veya `organic`. |
| `curated` | seçilmiş | Elle seçilmiş havuz. "Kullanıcıların bulduğu" diye etiketlenmez. |
| `organic` | kullanıcı keşfi | Gerçekten kullanıcılar tarafından bulunmuş. |
| `trend_snapshot` | trend | Dönemsel trend listesi. Dönem boyunca sabittir. |
| `lexicon` | sözlük | Arama ayrıştırıcısının eşanlamlı tablosu. |
| `alert` | alarm | Fiyat, stok veya beden bildirimi. |

## Kullanılmayan terimler

- **"dupe"** arayüzde geçmez. İç konuşmada kullanılabilir, kullanıcıya
  "daha uygun alternatif" denir. Marka hakları açısından da güvenli taraf budur.
- **"satın al"** hiçbir butonda geçmez. Satışı biz yapmıyoruz.
- **"ucuz"** yerine "daha uygun fiyatlı". Ucuz kelimesi kalitesizlik çağrıştırır.
