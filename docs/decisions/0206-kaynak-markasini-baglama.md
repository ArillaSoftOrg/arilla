# 0206 — Kaynak markasını (`offer.brand_raw`) mevcut markaya bağlama

**Tarih:** 15 Kasım 2026
**Durum:** Önerildi (PR). Üretimde çalıştırma ayrı, açık bir operasyon kararıdır; bu PR üretimde HİÇBİR veri yazmaz.

## Sorun

Hepsiburada (merchant 28) yayındaki 2.017 üründe `product.brand_id` %0, oysa teklifte `brand_raw` %98,5 dolu
(1.987; 152 ayrı değer). Nedenler (üretim salt-okunur incelemesi + kod):

1. `catalog_build` (karar 0121) taslak ürünü yalnızca başlık + görselle açar; `brand_raw` hiç okunmaz.
2. Marka bağlama yalnızca `classify products` (karar 0133) içinde var; HB için hiç koşmadı
   (`product_classification` HB satırı: 0; `classify_products` işi üretimde yalnızca Ekim'de 7 kez).
3. Üretim `brand` tablosunda yalnızca 4 satır var (Mean Well, Schneider, Omron, Sonoff). Mevcut markayla
   tam eşleşme HB'de bu yüzden %0; bağlama için marka satırı açmak gerekir (0133'ün `_ensure_brands`ı bunu yapar).

## Karar

1. `python -m classify link-brands --merchant <slug>`: yalnız `product.brand_id IS NULL` ürünlerde, yalnız
   `brand_raw`ı **tam normalize eşleşmeyle** (`brand_key`) mevcut `brand` satırına bağlar. Bulanık eşleşme yok;
   aynı anahtara iki marka satırı düşüyorsa bağlanmaz (`ambiguous`).
2. Elenenler: bilinen anlamsız değerler (0133 listesi: "No Brand", "Markasız", "Diğer"...), mağaza adı ve satıcı adı
   görünümlü değerler (`...store`, `...shop`, `...market`, `...bayiciniz`: HB marka alanı bazen satıcıyı taşır).
3. **Yeni marka satırı varsayılan olarak AÇILMAZ.** `--create-missing` ayrı bayraktır ve üretimde ayrı onay ister.
   Gerekçe: marka satırı arama (`b.name_norm`), sözlük ve eşleştirme kimliği (`product_identity_mpn_brand`) için
   kalıcı bir varlıktır; satıcı yazımıyla gelen yanlış bir ad geri alınması zor bir kirlilik olur.
4. Ürüne dokunuş yalnız `brand_id` (+`updated_at`, yayındaysa `search_outbox`); koşullu `brand_id IS NULL`
   olduğundan idempotenttir ve insanın/beslemenin/sınıflandırıcının yazdığı değer ezilmez. `product_classification`
   yazılmaz (kategori kararı bu işin değildir); sonraki `classify products` bu markayı "existing" olarak korur.
5. Yazma yalnız yerel veritabanında çalışır (`--confirm --local-only`, bağlantı ana makinesi yerel olmalı);
   ölçüm (`--confirm`suz) salt-okunurdur ve her yerde güvenlidir.
6. `clean_source_brand`: "LİVİNGSTORE" gibi büyük harf değerlerde Türkçe İ, "i" + U+0307 üretiyordu; birleştirici
   nokta atılır (anahtarı etkilemez, yalnız görünen ad).

## Reddedilen alternatifler

| Alternatif | Neden değil |
| --- | --- |
| Bulanık/önek eşleşme ("Xiaomi Mi" → Xiaomi) | Yanlış marka, markasızdan kötüdür; kural 0133 §3 |
| Varsayılan olarak marka satırı açmak | Satıcı adı/genel sözcük (Garden, Ocean, Store) kalıcı marka olur |
| `catalog_build` içine marka yazmak | Kapı/yayın hattına yeni yazma yolu; önce ayrı komutla ölçülür, sonra bağlanır |
| Başlıktan marka çıkarmak (HB için) | Yapılandırılmış alan zaten %98,5; başlık yalnız 0133'ün seçilmiş listesiyle |
