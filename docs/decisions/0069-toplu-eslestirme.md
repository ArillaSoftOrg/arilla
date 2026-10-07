# 0069 — Chunk'li, toplu SQL'li eşleştirme (resolve)

> **Eski numara: 0066.** Bu ADR dalda ilk 0066 olarak yazildi; `main`'deki baska kararlarla cakistigi icin 0069'e tasindi. kod yorumlarindaki ilk 'karar 0066' atiflari bu ADR'yi (eski numarasiyla) kasteder; uygulanmis migration dosyalarina bu yuzden dokunulmadi.

**Tarih:** 2026-10-07
**Durum:** kabul edildi (kod ve testler hazır; production'da geri alınan benchmark yapıldı)

## Bağlam

`north-sails-turkiye` pilotunda toplama 48 sn sürerken `resolve` 1.723 offer için
**42,6 dk** sürdü (≈0,67 offer/sn). Ölçüm (`resolve.pipeline`, eski sürüm):

- **Offer başına ~8–14 sorgu / round-trip**: reddedilen çiftler, varyant
  barkodları, offer vektörü, kesin kimlik, varyant barkodu eşleşmesi, başlık
  trigram, görsel ANN, "aynı merchant zaten bağlı", barkod kümesi, hacim
  metinleri; ardından bağlama ya da yaratma (marka, kategori, slug döngüsü,
  `INSERT`, bağlama). Uzak RTT ≈158 ms ⇒ ≈1,5 sn/offer. Yerel ölçüm
  (2.029 offer): **17.835 ifade**.
- **Tek büyük işlem, koşu sonunda tek commit** ve `--limit 500` varsayılanı:
  tavan, tek işlemin riskini sınırlamak içindi; 500'den fazla offer her seferinde
  ek koşu gerektiriyordu.
- **Jina/embedding sıcak yolda DEĞİL.** `resolve` hiçbir model çağırmaz;
  `enrich` ile önceden üretilmiş vektörleri yalnızca okur. Kimlikle (barkod,
  başlık/renk) çözülen kayıt zaten embedding beklemiyor.
- En çok süre alan: offer başına round-trip toplamı; sunucu tarafında trigram
  sorgusu (~10–15 ms/offer) ikinci sırada.

## Karar

`resolve_offers` artık `resolve/batch.py`'deki **toplu motor**dur; eski sürüm
`resolve_offers_sequential` olarak **referans** kalır (karşılaştırma testi ve
`--sequential`).

- **Chunk = aynı merchant'ın en fazla 200 eşleşmemiş offer'ı**
  (`merchant_id, id` sırası, keyset sayfalama). Tek merchant chunk'ı ayrım
  için şart: ayni merchant'in baska offer'inin urettigi urun, ayni chunk'taki
  bir offer'a aday olamaz (ayni-merchant kurali), farkli merchant'lar
  committed durumu gorur.
- **Toplu okuma** (`unnest` + LATERAL, chunk başına ~12 ifade): insan kararları
  (`match_candidate`), varyantlar, vektörler, kesin kimlik / varyant barkodu /
  başlık trigram / görsel adayları, "aynı merchant bağlı" ürünler, barkod
  kümeleri, hacim metinleri.
- **Karar Python'da, aynı fonksiyonlarla** (`combine`, `auto_eligible`, vetolar,
  `exact_variant_match_from_rows`, `volume_conflict`, `disjoint_from_sets`;
  `identifiers.py`'deki tekil yollar bu ortak yardımcılara devredildi).
  Chunk içindeki bağımlılık bellekte izlenir: bir offer'ın bağlanması ya da
  yeni ürün açması sonraki offer için "aynı merchant bağlı", kesin barkod,
  barkod kümesi ve hacim kümesini günceller — ardışık koşunun göreceği durumla
  aynı.
- **Toplu yazım**: marka (`unnest ... ON CONFLICT (slug)`), kategori, slug
  (tek sorguda çakışma sondajı, chunk içi çakışmalar dahil; `-2`, `-3` kuralı
  aynı), ürünler, `match_candidate` upsert (insan kararı ezilmez) ve
  `offer.product_id` bağlama (`WHERE product_id IS NULL`). Chunk başına ~8
  yazım ifadesi.
- **Hata/koşu yalıtımı**: chunk kendi SAVEPOINT'inde; `psycopg.Error` yalnızca o
  chunk'ı geri alır, hata kaydedilir, sonraki chunk'a geçilir. Bağlantı
  kopması koşuyu durdurur; commit edilmiş chunk'lar kalır. CLI chunk başına
  commit eder (`commit_each_chunk`).
- **Devam / idempotency**: durum `offer.product_id`'dedir; ek checkpoint
  gerekmez. Yarım kalan koşuyu yeniden çalıştırmak kalan offer'lardan devam
  eder; zaten bağlı offer seçilmez; `match_candidate (offer_id, product_id)`
  tekrarı engeller. `--limit` varsayılanı artık "hepsi" (eski 500).
- **Determinizm**: eşit benzerlikli adaylar `id` ile sıralanır (iki motorda da);
  eski sorguda ikincil sıralama yoktu, eşit skorda sonuç keyfiydi.
- **Marka çıkarımı** koşu başındaki marka indeksine bakar (eski sürümle aynı):
  bu koşuda açılan yeni markalar çıkarıma girmez.

## Doğruluk güvencesi

Karşılaştırma testi (`tests/test_resolve_batch.py`): iki merchant, 2.029 offer
(barkodlu/barkodsuz, çok varyantlı, aynı barkodu iki kez listeleyen offer,
insan tarafından reddedilmiş çift, ürünler arası eşleşme), eski ve yeni motor
aynı başlangıç durumunda; offer → ürün başlığı, slug, renk, barkod, aday
durumu/skoru/yöntemi **birebir eşit**; sayaçlar eşit. Ek testler: tekrar
çalıştırma idempotent, duplicate ürün yok, ortada hata → chunk yalıtımı ve
retry, kısmi koşudan devam, çok-merchant sıralama.

## Ölçüm

| | Eski | Yeni |
| --- | --- | --- |
| Yerel, 2.029 offer, ifade sayısı | 17.835 | 164 |
| Production (north-sails 1.723 offer, geri alınan koşu) | 2.557 sn (4 geçiş) | **32,1 sn, 76 ifade** |
| Hız | ≈0,67 offer/sn | ≈54 offer/sn |

Production ölçümü işlem içinde bağları kaldırıp motoru çalıştırıp ROLLBACK
yaparak alındı: 1.723/1.723 offer aynı başlık+renk ürüne geri bağlandı, 0 yeni
ürün, koşu sonrası checksum birebir aynı.

## Sınırlar / bilinen

- Bir chunk'ta barkodlu offer'ların kendi aralarındaki bağımlılığı bellekte
  taklit edilir; yeni bir bağımlılık türü (örn. yeni bir kimlik kanalı)
  eklenirse bu taklit ve eşdeğerlik testi birlikte güncellenmeli.
- Trigram sorgusu sunucu tarafında offer başına ~10–15 ms: katalog 100 bin
  offer'a yaklaşırsa ayrı bir iş.
- Eşleştirme eşikleri/vetoları değişmedi; `docs/decisions/0017` regresyon seti
  aynen geçiyor.

## Reddedilen alternatifler

- **Yalnızca `--limit`'i kaldırıp tek işlemi büyütmek:** aynı kırılganlık.
- **psycopg pipeline ile offer başına sorguları art arda göndermek:** ardışık
  bağımlı karar zincirinde kazanç sınırlı (offer başına ~3 RTT).
- **Skoru SQL'e taşımak:** eşleştirme mantığı tek yerde (Python) kalmalı;
  regresyon seti ve vetolar orada.
- **Embedding'i sıcak yoldan çıkarmak için ek iş:** zaten yok.
