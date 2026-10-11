# Yetkili erişim geldiğinde test protokolü

Ön koşullar (hepsi sağlanmadan başlanmaz):
1. Satıcıdan **yazılı onay**: ManiCepte'nin onun Trendyol API'sini salt okunur kullanması ve fiyatların
   ManiCepte'de (satıcı adıyla veya anonim buybox olarak) gösterilmesi.
2. Anahtar **satıcı tarafından** gizli depoya girilir (ör. sunucu ortam değişkeni / secret manager).
   Sohbete, depoya, loga, istemciye **asla** yazılmaz; ManiCepte anahtar toplamaz veya paylaşmaz.
3. Trendyol'a yazılı soru gönderilmiş olmalı (entegratör verisinin gösterimi).
4. Önce **stage** (IP yetkilendirmesi satıcı panelinden), sonra prod.

Kurallar: yalnızca **okuma** uç noktaları (Onaylı Ürün v2, Buybox). Fiyat/stok güncelleme, kilit
kaldırma gibi yazma işlemleri **çağrılmaz**. Buybox yalnızca satıcının kendi barkodları. Kota payı
≤ %10. 401/403/429'da durulur.

## T1 — Erişim ve kapsam
- `GET …/products/approved?size=100&status=onSale` → toplam ürün (`totalElements`), örnek 100 kayıt.
- Kaydet: contentId, barkod (GTIN mi `TYB…` mı), variantId, productUrl, `price{salePrice,listPrice,priceSeenByCustomer}`.
- Başarı: 200 ve en az 1 satışta ürün.

## T2 — `priceSeenByCustomer` anlamı (en kritik)
Aynı dakika içinde, satıcının 20 satışta ürünü için:
1. API'den `salePrice`, `listPrice`, `priceSeenByCustomer`.
2. Gerçek tarayıcıda (normal ziyaret) aynı ürün sayfasının fiyat nesnesi: `sellingPrice`,
   `originalPrice`, `discountedPrice`, `couponApplicablePrice`, buybox satıcısı.
3. Eşitlik tablosu: H1 `priceSeenByCustomer == discountedPrice`, H2 `salePrice == sellingPrice`,
   H3 `listPrice == originalPrice`. Kabul: ≥ 18/20 eşleşme ve sapmaların açıklaması (kupon, kampanya, varyant).

## T3 — Buybox
- Satıcının T1'deki barkodlarından 50'si (10'arlı 5 istek).
- Her biri için ürün sayfasında buybox satıcısı ve fiyatı (tarayıcı, aynı dakika).
- H4 `buyboxOrder==1` ⇔ sayfadaki satıcı bu satıcı. H5 `buyboxPrice` == sayfadaki müşteri fiyatı
  (hangi alan?). H6 `secondBuyboxPrice` == sayfadaki diğer satıcılardan en ucuzu. 2./3. alanların
  gerçekten dönüp dönmediği (OpenAPI'de yok).
- Kabul: H4 ve H5 için ≥ %90.

## T4 — Varyant ve barkod
- Çok bedenli/renkli 5 ürün: varyant başına barkod ve fiyat; liste kartındaki fiyatın hangi varyanta ait olduğu.
- Aynı GTIN'in başka contentId'lerde satılıp satılmadığı (gözlem 2.3) → buybox barkod mu, content mi bazında?

## T5 — Güncellik ve gecikme
- Satıcının **kendi olağan** fiyat değişikliklerini izle (ManiCepte fiyat değiştirmez): `sellerModifiedDate`
  ile sayfada fiyatın değiştiği an arasındaki fark; 1 hafta, 10 olay.
- Kabul: medyan gecikme ölçülmüş ve önbellek TTL'i buna göre seçilmiş.

## T6 — Uçtan uca
- `discoverTrendyol` / ürün dizini kartı → `trendyolSellerApiProvider` + `fetchBuyboxQuotes` → `enrichPrice`.
- 4 test sorgusu (iPhone 16 Pro 128 GB, Adidas Samba, Nike Air Force 1, siyah kadın elbise) için:
  fiyat, kaynak, satıcı (veya "anonim buybox"), contentId, barkod, zaman, güven seviyesi.
- Referans set: `03-satici-kaynakli-fiyat.md` §2.2 (2026-10-11T23:12Z).

Sonuçlar `01-kanit-kaydi.md`'ye yeni faz olarak eklenir; anahtar, satıcı gizli verisi ve ham yanıt
dökümleri kayda **konmaz** (yalnızca alan adları ve karşılaştırma sonuçları).

## Ek (06): fiyat katmanları
- T2/T3 karşılaştırmalarında **varyant (beden/barkod) ve satıcı sabitlenir**; ürün sayfası `?merchantId=<id>&v=<beden>` ile açılır.
- Her gözlemde ayrı kaydedilir: `sellingPrice`, `discountedPrice`, `originalPrice`, `couponApplicablePrice`, görünen "Sepette %X" fiyatı, kampanya etiketleri, liste kartı `current/discountedPrice`.
- Kullanıcıya özel fiyat şüphesi: aynı ürün aynı dakikada oturumsuz (gizli pencere) ve oturumlu görüntülenir; fark kaydedilir.
- Kota: Buybox, satıcının yazma kotasından (200–600/dk) en fazla %10 kullanır; 10 sn/50 istek kuralına da uyulur.
