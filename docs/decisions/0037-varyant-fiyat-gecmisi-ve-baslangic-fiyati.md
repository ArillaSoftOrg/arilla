# 0037 — Varyant fiyat geçmişi, "başlangıç fiyatı" kartları ve varyant stok alarmı

**Tarih:** 2026-09
**Durum:** kabul edildi

0033 fiyat karşılaştırmasını varyanta duyarlı yaptı ama üç şeyi açık bıraktı:
fiyat geçmişi boyutları karıştırdığı için varyant modunda gizlendi, ürün
kartları `min_price`'ı düz fiyat gibi gösteriyordu, varyant modunda beden
stok alarmı yoktu.

## 1. Varyant fiyat geçmişi

**Sorun.** `price_point` teklif düzeyindedir. Teklifin `current_price`'ını, yani
**en ucuz varyantın** fiyatını tutar. Çok boyutlu bir teklifte (Korendy 60 ml +
100 ml) hangi gün hangi boyutun fiyatı olduğu hiç kaydedilmez, geçmişten de
çıkarılamaz.

**Karar.** Migration 0026, `variant_price_event`: `variant_stock_event` ile aynı
desen. Varyantın etkin fiyatı (`price_override`, yoksa teklif fiyatı)
yalnızca ilk görülmede ve **değiştiğinde** yazılır. Tablo append-only;
`arilla_app` yalnızca SELECT + INSERT yapabilir.

Seçili varyantın serisi (`getVariantPriceHistory`):

| Teklif | Kaynak |
|---|---|
| Tek ticari varyant (varyant satırı yok ve başlıktaki miktar seçili anahtar; ya da tüm satırlar aynı anahtar) | `price_point`: teklif fiyatı zaten o varyantın fiyatı |
| Çok boyutlu teklif | `variant_price_event`: günün fiyatı = gün sonuna kadarki son olay, yalnızca teklifin o gün görüldüğü günler |
| Seçili varyantı satmayan teklif | katılmaz |

Nokta sentezlenmez. Olaylar migration'dan sonra birikmeye başlar; geriye dönük
doldurma yapılmaz, çünkü eski günlerin varyant fiyatı bilinmiyor. Grafik en az
iki gerçek günle çizilir. Aksi halde "{boyut} için henüz yeterli fiyat geçmişi
yok" yazar. Seçim yoksa grafik yoktur: "Fiyat geçmişi, bir boyut seçildiğinde
yalnızca o boyut için gösterilir." Seri tam değilse, yani uyumlu tekliflerin
bir kısmının güvenilir geçmişi yoksa, kapsama notu gösterilir.

## 2. Fiyat konumu iddiası

"Son 90 günün en düşük fiyatı" yalnızca şu koşulların hepsi sağlanırsa
gösterilir:

- seçili varyantın serisi **tam**: her uyumlu teklif katılıyor;
- seri gerçekten ~90 günü kapsıyor;
- bugünkü en iyi uyumlu fiyat serinin en düşüğünden büyük değil.

Aksi halde iddia gizlenir. Basit moddaki ürün düzeyi iddia değişmedi.

## 3. Kart fiyatı semantiği

Arama kartları, keşif (ana sayfa + `/kesfet`) ve alternatif şeridi ürün
sayfasıyla **aynı kuralı** kullanır: `buildPriceComparison(...).mode ===
"variants"` ise kart fiyatı "670 TL'den başlayan" olarak yazılır, değilse düz
fiyat. Bayrak (`priceFromVariants`) `search()`, `getDiscoverySlots()` ve
`findAlternatives()` içinde tek toplu sorguyla eklenir. Sayfa kodu kural
bilmez.

## 4. Varyant modunda stok alarmı

İkinci bir seçici yoktur. Seçim `?boyut=` durumudur. Seçili varyant hiçbir
uyumlu teklifte stokta değilse "Stok gelince haber ver" gösterilir. Alarm
mevcut şemayla temsil edilir: `alert.kind = 'size_restock'`, `size_norm` =
çözümlenmiş varyant anahtarı. Hacim için `100ml`, beden için eski beden
alarmlarıyla aynı değer (`42`). Tetikleme önce eski eşitliği
(`offer_variant.size_norm`) dener, sonra aynı varyant kuralını
(`getVariantStock`). Böylece varyant satırı olmayan tek boyutlu listeler de
alarmı tetikler. Seçilen boyut hiçbir mağazada listelenmiyorsa alarm
**kurulmaz**; bu açıkça yazılır.

## 5. Yapılandırılmış veri

- Seçim yokken teklifler farklı boyutlardır. Tek eşdeğer `Offer` kümesi değil,
  `AggregateOffer` (lowPrice/highPrice/offerCount) olarak bildirilir.
- Seçiliyken yalnızca uyumlu `Offer`'lar.
- `ProductGroup` / `hasVariant` eklenmedi: varyant başına ayrı URL ve kimlik
  yok, doğru desteklenemez.

## Reddedilen alternatifler

- **`price_point`'a `variant_id` eklemek.** Bölümlenmiş, append-only ve
  PK'sı `(offer_id, observed_at)` olan tabloyu değiştirmek, her varyant için
  her koşuda satır yazmak demek. Değişim olayı aynı bilgiyi çok daha küçük
  tutar.
- **Çok boyutlu teklifin `price_point` serisini en ucuz boyut saymak.** En
  ucuz boyut stok ve fiyatla gün gün değişebilir; hangisi olduğu kayıtlı değil.
- **Her karta "'den başlayan" yazmak.** Tek varyantlı ürünü olduğundan
  belirsiz gösterir.
