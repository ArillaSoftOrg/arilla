# 0064 — Shopify merchant'larında kanonik alan adı kanıtı ve taşıma

**Tarih:** 2026-10-06
**Durum:** kabul edildi (2 merchant taşındı; geri kalanı kanıt eksikliğiyle bekliyor)

## Bağlam

`0042` robots.txt'i yönlendirme izlemeden, `feed_url` host'una sorar. Shopify,
özel alan adı olan mağazalarda `<mağaza>.myshopify.com/robots.txt`'i 301 ile
birincil alan adına yönlendirir; toplama `refused:robots_unavailable` ile
durur. Kapı doğru çalışıyor; sorun kayıtlı host'un kanonik olmaması.

## Karar

Kapı gevşetilmez, yönlendirme toplama sırasında izlenmez. Bunun yerine salt
okunur `collect.canonical_domain` aracı kanonik host'u **kanıtlar**; yalnızca
tüm kontrolleri geçen merchant'ın `domain` ve `feed_url`'u migration ile
taşınır (`0049`, `admin_audit_event` izi).

Kanıt (her merchant, tek tek):

1. robots yönlendirme zinciri elle, adım adım: https, standart port, kimlik
   bilgisi yok, aynı yol (`/robots.txt`), `safe_http.check_url`, en fazla 3 hop,
   döngü yok.
2. Çözülen IP'lerin hepsi genel; bağlantı `GuardedBackend` üzerinden.
3. Shopify kimliği: aday host'un `/meta.json` `myshopify_domain`'i eski
   domain ile **eşit** olmalı (başka sitenin yönlendirmesi kabul edilmez).
4. `verify_currency.check_merchant`: tam `"TRY"`.
5. `verify_readiness.check_target`: `READY`.

Kanıt dosyası: `services/ingest/bootstrap/canonical_domains_20261006.json`.

## Sonuç (12 mağaza incelendi)

| Mağaza | Sonuç |
| --- | --- |
| halicizade-hali-kilim → www.halicizade.com | READY, taşındı |
| north-sails-turkiye → collection.northsails.com.tr | READY, taşındı |
| happy-place-home-decor | yönlendirme yok, READY (taşıma gerekmez; yavaş büyük katalog) |
| assema, yutas-yapi-urunleri | yönlendirme hedefi BAŞKA bir Shopify mağazası (`myshopify_domain` uyuşmuyor): reddedildi |
| spor-plus | hedef (sporplus.net) bağlantı kurulamadı |
| riva-istanbul, casadora-baby, eveline-cosmetics-turkiye, jura-store | domain kanıtlandı ama hazırlık REVIEW (örnekte renk/beden seçeneği yok / tanınmayan seçenek adı) |
| wraith-esports | domain kanıtlandı ama hazırlık NOT_READY (mevcut eşleme yanlış) |
| for-fun | yönlendirme yok; hazırlık NOT_READY (eşleme) |

Eşleme sorunları domain sorunu değildir; ayrı iş.

## Reddedilen alternatifler

Toplamada yönlendirme izlemek; hedefi yalnızca `Location`'a bakarak yazmak
(`assema`/`yutas` yanlış mağazayı gösterecekti); `REVIEW` sonuçlu mağazaları
zorla taşımak.
