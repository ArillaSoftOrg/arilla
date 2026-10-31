# 0160 — Yeni yayın için tazelik eşiği: kapı ve yayın aynı 2 günü uygular

**Tarih:** 31 Ekim 2026
**Durum:** Önerildi (PR). Migration yok. Üretim verisine dokunulmadı.
**İlişkili:** 0121 (kapı ve yayın), 0134 (bekçi), 0156 (okuma yolunda tazelik; **değişmedi**).

## Bağlam

`catalog_build gate` bayatlık eşiği varsayılan 7 gündü; `publish` bayatlığa hiç bakmıyordu; bekçi
(`infra/vps/bin/catalog-publish`) gate'i `--stale-days` vermeden çağırıyor ve kuru koşu SQL'inde
`7 days` sabitliydi. Besleme günde iki kez çalışırken 7 gün "doğrulanmış güncel" için çok
gevşekti. 31 Ekim pilotunda (99.395 taslak) 25.013'ü (%25,2) eski beslemelerden gelmişti; 7 günle
hepsi kapıdan geçerdi. Üründen gelen karar: eski fiyatlar yalnızca eski oldukları için otomatik
gizlenmez (`config.freshness` kapalı kalır), ama kaynakta bulunmayan teklif **yeni** bir ürün olarak
doğrulanmış gibi yayınlanmaz.

## Karar

1. `catalog_build.gate.PUBLISH_STALE_DAYS = 2`; `gate` varsayılanı ve yeni `publish --stale-days`
   varsayılanı bu sabittir. Tek kaynak.
2. `publish`, kilitlediği `ready` ürünlerin teklifi için kapıyla aynı `seen` mantığını
   (`GREATEST(offer.last_seen_at, max(feed_source_offer.last_seen_at))`) yeniden uygular. Eşikten
   eski ya da `seen` NULL olan teklif bağlanmaz, ürün `held` + `stale_source_offer` olur. Bu kapıdan
   sonra düşen, yurt dışı onaylı ve TRY teklifler için de geçerlidir.
3. `seen IS NULL` bayat sayılır (fail-closed); kapıda da.
4. Bekçi `STALE_DAYS` (varsayılan 2, pozitif tam sayı) ortamını gate'e, publish'e ve kuru koşu
   SQL'ine aktarır. `catalog-publish run` artık 7 güne sessizce düşmez.
5. Yönetim paneli `STALE_OFFER_DAYS = 7` bir **gösterge**dir ve bilerek ayrı kalır.

## Sonuç ve sınırlar

- Yalnız YENİ yayını sınırlar. Yayındaki ürünler gizlenmez, `unpublish` edilmez, `config.freshness`
  değişmez (okuma yolundaki davranış aynı).
- Gate senkronizasyondan en fazla 2 gün sonra çalışmalı; yoksa güncel teklifler de `held` olur.
  Geri alma: senkronizasyondan sonra gate'i yeniden çalıştır (held → ready).
- Okuma yolu: politika tanımlı olmadığı sürece (karar 0156) yayındaki ürünün yalnız bayat teklifi
  hâlâ "doğrulanmış" gösterilebilir; ürün sayfası tarihi son `price_point` gözleminden alır
  (son fiyat DEĞİŞİMİ), son kaynak doğrulaması değil. Ayrı iş.

## Reddedilen alternatifler

- Varsayılanı 7'de bırakıp yalnız bekçiye parametre eklemek: elle `gate`/`publish` yine eskiyi geçirir.
- `STALE_OFFER_DAYS` ile aynı sabite bağlamak: bir yönetim göstergesini yayın kapısına bağlar.
- Yayında hiç kontrol yapmamak: kapı ile yayın arasında kaynaktan düşen teklif yayına girer.
