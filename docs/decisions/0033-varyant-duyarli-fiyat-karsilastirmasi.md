# 0033 — Varyant duyarlı fiyat karşılaştırması

**Tarih:** 2026-09
**Durum:** kabul edildi

## Sorun

Ürün renk düzeyinde kanonik, beden/hacim ise varyanttır (0005). 0036'den beri
aynı ürünün teklifleri farklı ticari varyantları satabiliyor. Ürün 11023'te
Korendy 60 ml (670 TL) ve 100 ml'yi (1.118 TL) tek offer'da satıyor, Vionine
100 ml'yi ayrı bir listede satıyor (1.709 TL).

Ürün sayfası `compareMerchants()`'in teklif başına tek fiyatını
(`offer.current_price` = teklifin **en ucuz** varyantı) kullanıyordu. Şu
yerlerin hepsi boyut bilmeden karşılaştırıyordu:

- "En uygun teklif" ve `PriceDiffBlock`: Korendy 60 ml, Vionine 100 ml'nin
  "daha uygun" alternatifi gibi görünüyordu;
- "En uygun fiyat" rozeti ve mağaza sıralaması;
- birincil çıkış: 100 ml arayan kullanıcı 60 ml listesine gidebiliyordu;
- liste fiyatı / tasarruf: temsilci varyantın liste fiyatı başka boyuta
  uygulanabiliyordu;
- JSON-LD teklifleri, fiyat konumu cümleleri ve fiyat geçmişi grafiği.

## Karar

**Karşılaştırılabilirlik (deterministik, fiyattan çıkarım yok).** İki fiyat
yalnızca aynı ticari varyantı satıyorsa doğrudan karşılaştırılır. Varyant
anahtarı:

1. Hacim/ağırlık + paket adedi (`parseQuantity`). Önce varyant etiketinden,
   varyant satırı yoksa teklifin **kendi** başlığından. Yalnızca birimli sayı
   okunur ("60 ml", "0.59 LT" → 590 ml, "20 gr"). Birimsiz sayılar ("345
   Relief", "No.9") ve birden fazla farklı miktar ("50 ml + 15 ml")
   belirsizdir, anahtar üretilmez. "2 x 100 ml" ve "400 ml 2'li" paket adedini
   taşır, "100 ml" ile aynı sayılmaz.
2. Yoksa beden (`offer_variant.size_norm`): `beden:42`.

Anahtarı çıkarılamayan teklif hiçbir seçili varyantla karşılaştırılmaz.

**Mod.** Varyantlar fiyatı etkiliyorsa (en az iki bilinen varyant var **ve**
teklifler farklı varyant kümeleri satıyor ya da bir teklifin varyant fiyatları
farklı) sayfa varyant moduna girer. Aksi halde **basit mod**: eski akış
birebir aynı kalır. Tek fiyatlı çok bedenli Derimod botu, mobilya ve tek hacimli
Stanley bardağı bu moddadır.

**Seçim.** `?boyut=<anahtar>` sunucu tarafında karşılaştırmayı yeniden kurar.
Canonical URL değişmez, bağlantılar `rel="nofollow"`.

| Durum | Fiyat bloğu | Birincil çıkış | Mağaza listesi |
|---|---|---|---|
| Seçim yok | "Başlangıç fiyatı" + "Karşılaştırmak için bir seçenek seç" | yok | her satır kendi boyutuyla, rozet yok, "farklı boyutlar birbirinin alternatifi değildir" |
| Seçim var | "En uygun teklif, 100 ml" (yalnızca uyumlu satırlar) | stoktaki en uygun uyumlu teklif; stok yoksa en uygun uyumlu teklif + "Şu an stokta yok" | yalnızca uyumlu satırlar, "En uygun fiyat" rozeti |
| Seçilen yok | "Seçtiğin boyut şu an hiçbir mağazada yok" | yok | seçim yokmuş gibi, nötr |

**Tasarruf.** Liste fiyatı offer düzeyinde ve temsilci (en ucuz) varyanttan
gelir. Yalnızca o varyanta uygulanır, başka boyutta tasarruf hesaplanmaz.

**Birim fiyat.** Yalnızca güvenle ayrıştırılmış miktardan: 100 ml / 100 g
başına, paket adedi dahil. Tamamlayıcıdır, mağaza fiyatının yerine geçmez.
Para birimi tüm katalogda doğrulanmış TRY (0029). Adet sayısı ("24 adet")
birim fiyata girmez.

**Varyant modunda gizlenen ürün düzeyi iddialar.** Fiyat konumu ("son 90
günün en düşüğü"), sahte indirim notu ve fiyat geçmişi grafiği boyutları
karıştırır. Varyant bazlı geçmiş yok, bu yüzden gösterilmez.

**Özet alanları.** `product.min_price` tüm varyantların en düşüğüdür:
**başlangıç fiyatı**. Kartlar ve arama bunu gösterir. `offer_count` teklif
sayısıdır, varyant sayısı değil. Anlamlar değişmedi, `docs/schema.sql`'e yazıldı.

**Eşleştirme (metin yolu).** Ürün ailesi ≠ satılabilir varyant. Barkodu
olmayan bir teklifin hacmi adayın bilinen satılabilir hacimleri arasında yoksa
metin eşleşmesi aileye katılabilir ama **otomatik kabul edilmez**, REVIEW'a
gider. Aday hacmi hiç bilinmiyorsa kural çalışmaz.

## Şema

Değişiklik yok. `offer_variant.size_label/size_norm/price_override/in_stock`
ve teklif başlığı yeterli.

## Reddedilen alternatifler

- **Varsayılan varyantı sessizce seçmek.** Karşılaştırmayı gizler; hangi
  boyutun seçildiği kullanıcıya açık olmalı.
- **Birim fiyata göre "en ucuz" demek.** Kullanıcı belirli bir boyut
  alıyor; birim fiyat yalnızca bilgi.
- **Hacmi başlıktaki herhangi bir sayıdan tahmin etmek.** "345 Relief",
  "No.9" gibi model adları yanlış hacim üretirdi.
