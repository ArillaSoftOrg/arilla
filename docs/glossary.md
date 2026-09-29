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
| `ai_quota_day` | günlük arama hakkı | Fotoğraf ve link araması için her gün (Europe/Istanbul) yenilenen hak. Birikmez. |
| `bonus_account` | bonus hak | Günlük hak bitince harcanan, sıfırlanmayan hak. Davet ve ilk geri bildirimle kazanılır. |
| `ai_search_charge` | — | Bir pahalı aramanın hak kaydı: ayrıldı, kesinleşti ya da iade edildi. |
| `referral` | davet | Davet linkiyle açılan hesap. İlk hak harcayan aramadan sonra ödüllendirilir. |

## Kullanılmayan terimler

- **"dupe"** arayüzde geçmez. İç konuşmada kullanılabilir, kullanıcıya
  "daha uygun alternatif" denir. Marka hakları açısından da güvenli taraf budur.
- **"satın al"** hiçbir butonda geçmez. Satışı biz yapmıyoruz.
- **"coin"**, **"kredi"**, **"jeton"** arayüzde geçmez. Doğrusu "arama hakkı" ve "bonus hak" (0046).
- **"ucuz"** yerine "daha uygun fiyatlı". Ucuz kelimesi kalitesizlik çağrıştırır.
