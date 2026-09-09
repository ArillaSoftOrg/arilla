# 0018 — Benzerlik kenarları ve fiyat istatistikleri

**Tarih:** 2026-09 · **Durum:** kabul edildi

## Karar

### 1. Kenar türü ↔ embedding türü birebir eşlenir

```
embedding.kind = 'image'  ->  similarity_edge.kind = 'visual'
embedding.kind = 'text'   ->  similarity_edge.kind = 'semantic'
```

`same` ve `substitute` **üretilmez**. `same` B4 sonrası anlamını yitirdi: aynı
ürün artık aynı `product_id`'yi paylaşıyor, o ilişki `offer.product_id`
üzerinden zaten var. `substitute` ise `architecture.md`'nin dediği gibi tıklama
ve dönüşüm verisinden öğrenilir ve ilk aylarda boş kalır.

### 2. Aday üretimi offer düzeyindeki indeks üzerinden

Ürün vektörü, tekliflerinin vektörlerinin ortalamasıdır (yeniden normalize
edilmiş). Ama **veritabanına yazılmaz**: `embedding_ann_idx` HNSW indeksi
yalnızca `WHERE target_type = 'offer'` kısmi koşuluyla tanımlı, ürün
vektörleri indekssiz kalırdı. Aday üretimi offer'lar üzerinde yapılır ve
ürüne toplanır; skor ürün vektörleri üzerinden hesaplanır.

Böylece migration gerekmez ve arama 281 üründe de 100 binde de indekslidir.

### 3. Kalite tabanı + ürün başına ilk N

```
TOP_N = 8
MIN_SCORE = { visual: 0.55, semantic: 0.45 }
```

Tabanı geçmeyen aday **yazılmaz**, 5'ten az kenarı olan ürün raporlanır.
Kötü bir alternatif göstermek, az alternatif göstermekten kötüdür.

Kenarlar **çift yönlü** yazılır: `similarity_lookup_idx (product_a, kind,
score DESC)` sorguyu `product_a` üzerinden yapıyor; tek yön yazılırsa
alternatifler yalnızca bir taraftan görünür.

### 4. Sıraya bağlı istatistikler TEKLİF BAŞINA hesaplanır

Bu, uygulama sırasında bulunan bir hatanın sonucu ve en önemli kural.

`min` / `medyan` / `max` / `yüzdelik` tüm teklifler üzerinden hesaplanır —
"bu ürün en ucuz ne zaman kaçtı" sorusu mağazadan bağımsızdır. Ama **sıraya
bağlı** olan her şey (düşüş sayısı, sahte indirim tespiti) tek bir teklifin
kendi serisi içinde hesaplanır, sonra ürüne toplanır.

Düşüş sayısı tekliflerin **en çok düşenidir**, toplamı değil: üç mağaza aynı
gün indirim yapınca "3 kez düştü" demek yanıltıcı olur.

Sahte indirim, **bir teklifte bile** varsa ürün işaretlenir — kullanıcı o
teklifi görecek.

## Gerekçe

**Neden teklif başına — bulunan hata.** İlk sürüm bir ürünün tüm
tekliflerinin gözlemlerini tek bir zaman serisine karıştırıyordu. Tohum
verisinde bir ürünün iki teklifi vardı: A mağazasının liste fiyatı 57.300,
B'ninki 73.100. Aralarındaki geçiş **%27'lik bir "liste zammı"** gibi
görünüyor, ardından gelen herhangi bir fiyat düşüşü sahte indirim ilan
ediliyordu.

Sonuç: **200 ürünün 75'i** sahte indirim işaretlenmişti. Tohum yalnızca 5
teklifte kasıtlı şişirme üretiyor. Düzeltmeden sonra tespit **tam 5** ürün
buluyor — birebir tutuyor.

Bu, `docs/search.md`'nin doğrudan kullandığı bir sinyal: işaretli ürünler "En
iyi fırsatlar" sekmesinden **düşürülüyor**. Hata düzeltilmeseydi katalogun
%37'si sahte gerekçeyle o sekmeden çıkardı.

**Sahte indirim tanımı.** Yalnızca liste fiyatının yükselmesi yetmez (sezon
zammı olabilir), yalnızca fiyatın düşmesi de yetmez (gerçek indirim). Sahte
indirimi tanımlayan şey ikisinin **ardışıklığıdır**: liste %15'ten fazla
yükseliyor, 21 gün içinde satış fiyatı düşüyor, ve görünen indirim yüzdesi
yükselişten önceki gerçek indirimden en az 10 puan büyüyor.

**Neden tohum artık bu tabloları doldurmuyor.** Aynı hesap iki yerde
yaşasaydı ayrışırdı; üstelik tohumun ürettiği `list_price_inflated` gerçek
algoritmanın sonucu değil, elle seçilmiş birkaç üründü. Şimdi tohum yalnızca
**tespit edilebilir bir fiyat geçmişi** üretiyor, bayrağı B5 koyuyor.

## Reddedilen alternatifler

- **Ürün vektörlerini `embedding` tablosuna yazmak.** Şema izin veriyor ama
  HNSW indeksi kapsamıyor; indekssiz vektör yazmak sonradan migration
  gerektiren yarım bir çözüm olurdu.
- **Kalite tabanını düşürerek her ürüne 5 kenar garantilemek.** Gürültüden
  alternatif üretmek olurdu.
- **Düşüş sayısını tekliflerin toplamı almak.** Üç mağazanın eşzamanlı
  indirimi tek bir olaydır.

## Bilinen sınır: kenarlar henüz ölçülemez

Kenar kalitesi bugün **kanıtlanamıyor**, çünkü embedding'ler sahte istemciyle
üretiliyor (`0016`, açık madde: API anahtarı yok). Ölçülen dağılım:

| | en yüksek | medyan |
| --- | --- | --- |
| görsel | 1.000 | 0.114 |
| metin | 0.500 | **0.000** |

Metin vektörleri hash tabanlı ve birbirine dik; görseldeki 1.000'ler ise 8
fixture görselini paylaşan ürünler — gerçek benzerlik değil, fixture
artefaktı.

Bu yüzden **"her ürün için en az 5 alternatif kenarı" kabul kriteri gerçek
API anahtarıyla yeniden ölçülmelidir.** Eşiği düşürüp sayıyı tutturmak
kriteri karşılamış gibi gösterirdi ama alternatifler gürültü olurdu.

Entegrasyon testleri bu yüzden kenar **sayısını** değil **yapısını** doğrular:
çift yönlülük, kalite tabanının uygulanması, idempotentlik. Bunlar vektör
kalitesinden bağımsız olarak doğru olmalı ve öyle.
