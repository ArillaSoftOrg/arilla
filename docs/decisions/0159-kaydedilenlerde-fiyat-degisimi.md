# 0159 — Kaydedilenlerde fiyat değişimi: aynı teklifin kayıt anı ve bugünkü fiyatı

**Tarih:** 30 Ekim 2026
**Durum:** Önerildi (PR). Migration yok.
**İlişkili:** 0019 (istek yolunda `price_point` istisnası), 0037 (varyant fiyatı), 0156 (teklif tazeliği)

## Karar

`/kaydettiklerim` kartında "Kaydettiğinden beri X TL düştü/arttı" gösterilir. Hesap
`packages/core/src/account/saved-price-change.ts` içindedir.

1. **Referans teklif:** ürünün bugünkü en uygun teklifi: etkin, mağazası etkin, stokta,
   TRY, fiyatlı ve doğrulanmış (`offerVerifiedSql`). Eşitlikte küçük `offer.id`.
2. **Kayıt anındaki fiyat:** aynı teklifin `saved_item.created_at` anında ya da en fazla
   48 saat önce gözlenen son `price_point` satırı. Daha eski ya da kayıttan sonraki gözlem
   kullanılmaz; ara değer, ortalama ya da tahmin yok.
3. **Bugünkü fiyat:** teklifin `current_price`'ı. Fark kuruş tamsayısıdır; yüzde tamsayı
   aritmetiğiyle yarım yukarı yuvarlanır.
4. **Bugünkü fiyatın güvenilirliği (yalnız bu göstergeyi gizler, 0156 politikası değişmez):**
   - *Yakın zamanda görülmüş:* `feed_source_offer.last_seen_at` (0156'nın kaynağı),
     `offer.last_seen_at` ve son `price_point` gözleminin en yenisi son 3 gün içinde. TRY
     beslemelerinde tazelik politikası tanımlı değilken `offerVerifiedSql` her teklifi
     doğrulanmış sayar; bu koşul günlerdir görülmeyen teklifin fiyatını "bugünkü" diye
     göstermez. Tek başına son `price_point` yetmez: besleme senkronu (`feeds/sync.py`)
     gözlemi yalnızca fiyat/stok değişince yazar, toplayıcı (`collect/writer.py`) her koşuda.
   - *Gözlenmiş fiyat:* son `price_point.price = current_price`.
   - *Kartla aynı fiyat:* `current_price = product.min_price`. Kart depolanan özeti gösterir;
     özet stok dışı ya da doğrulanamayan daha ucuz teklifi sayabilir ya da bayat olabilir.
     Fark varsa kartla çelişen bir değişim gösterilmez; başka teklife geçilmez.
5. **Karşılaştırma yok ("Karşılaştırma için yeterli veri yok"):** ürün yayında değilse;
   doğrulanmış TRY teklifi yoksa; referans teklifin kayıt anına ait gözlemi yoksa; 4.
   maddedeki koşullardan biri sağlanmıyorsa; ürün varyant fiyatlıysa (`price_point` teklif
   düzeyinde en ucuz varyanttır, 0037).
6. **Satıcı/para birimi karışmaz:** referans teklifin geçmişi yoksa başka satıcının geçmişine
   geçilmez; ürün düzeyi "o günün en düşüğü ↔ bugünün en düşüğü" karşılaştırması yapılmaz.

## Gerekçe

Ürün düzeyi min-min karşılaştırma farklı satıcıların fiyatlarını tek geçmiş sayar: kayıt
anında ucuz olan satıcı çekilince "fiyat arttı" der, oysa hiçbir satıcının fiyatı artmamış
olabilir. Aynı teklifin kendi fiyatı kullanıcıya doğru ve denetlenebilir bir cümle verir.

**0019 ile ilişki:** istek yolunda `price_point` okuması yine sınırlıdır: yalnızca oturumdaki
kullanıcının kayıtları, ürün başına tek teklif, birincil anahtarla tek satır. `EXPLAIN`
(yerel): teklif seçimi `offer_product_idx`; `price_point` her bölümde `*_pkey` üzerinden
`Index Scan Backward` + `LIMIT 1`, sıralı tarama yok. Varyant kontrolü mevcut toplu
`getStartingFromProductIds` ile tek sorgudur; N+1 yok.

## Reddedilen alternatifler

- **`saved_item`'a kayıt anı fiyatı kolonu (migration):** yalnızca yeni kayıtlarda çalışır,
  mevcut kayıtlar için yine geçmiş gerekir; o anki değer de ürün düzeyi özet (`min_price`)
  olacağından satıcıları karıştırırdı.
- **Ürün düzeyi min-min karşılaştırma:** yukarıdaki gerekçe.
- **Eksik gözlemi en yakın gözlemle doldurmak:** tahmindir; "fiyat uydurulmaz" ilkesine aykırı.
- **`product_price_stats` ile yaklaşık değer:** kayıt anına ait değil, 30/90 günlük özet.

## Sınırlar

- Kayıt anında 48 saat içinde gözlemi olmayan teklif karşılaştırılmaz. Besleme senkronu
  gözlemi yalnız fiyat değişince yazdığı için, fiyatı kayıttan 48 saatten uzun süre önce
  son kez değişmiş besleme teklifleri "yeterli veri yok" görünür (yanlış değil, eksik kapsam).
- 3 günlük "yakın zamanda görülmüş" sınırı yalnız bu göstergeye aittir; teklifin kendisini,
  aramayı ya da ürün sayfasını etkilemez (0156'nın reddettiği genel takvim kuralı değildir).
- `price_point` bölüm sayısı arttıkça teklif başına indeks yoklaması bölüm sayısıyla büyür
  (aylık bölüm; kayıt başına birkaç düzine indeks araması).
