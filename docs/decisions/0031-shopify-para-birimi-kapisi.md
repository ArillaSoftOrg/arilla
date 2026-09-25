# 0031 — Shopify para birimi doğrulaması ve toplama kapısı

**Tarih:** 2026-09
**Durum:** kabul edildi (kod ve çevrimdışı testler hazır; 19 mağazanın canlı
doğrulaması ayrı, onaylı bir adım olarak yapılmadı)

## Karar

`0024`'ün açık bıraktığı para birimi doğrulaması üç parçayla kapatılıyor.

**1. Salt okunur doğrulama komutu.** `python -m collect.verify_currency
[--merchant <slug>] [--report <yol>]`. Her Shopify merchant'ı için
`https://<merchant.domain>/meta.json` adresine **tek istek** atar ve
mağazanın taban para birimini (`currency`) okur. Yalnızca tam olarak `"TRY"`
geçer. Zaman aşımı, ağ hatası, 2xx dışı yanıt (yönlendirme dahil —
izlemek ikinci istek olurdu), bozuk JSON, eksik ya da TRY dışı para birimi
ve geçersiz `merchant.domain` o merchant için `FAIL` üretir, rapor devam
eder. Yeniden deneme yok; istekler sırayla, saniyede en fazla 1; zaman
aşımı 10 sn.

Komut **hiçbir şey yazmaz**: veritabanı bağlantısı `read_only` açılır ve ağ
istekleri başlamadan kapanır. `currency_verified`, `is_active` ve
`feed_config` değişmez. Onaylanmış bir canlı rapordan sonra değerleri
veritabanına taşımak ayrı bir migration işidir.

**2. Toplama kapısı (`collect/gate.py`).** `run_ingest` connector'ı kurmadan
önce sorar:

- Her kaynak: `merchant.is_active = true` olmalı.
- Shopify: `feed_config.currency_verified` tam olarak JSON `true` **ve**
  `feed_config.currency` tam olarak `"TRY"` olmalı. Eksik, `false`,
  `"true"` gibi metin ya da başka para birimi reddedilir.

Red, mevcut `ingest_run` sözleşmesiyle kaydedilir: satır `failed` kapanır,
`error_text` makine okunur bir kodla başlar (`refused:merchant_inactive`,
`refused:currency_unverified`, `refused:currency_not_try`,
`refused:feed_config_invalid`). Mağazaya istek gitmez; offer ve
`price_point` yazılmaz. CLI `refused <kod>` basar ve 1 ile çıkar. Kapı
`run_ingest` içinde olduğu için `collect.bootstrap` da aynı kapıdan geçer.

**3. Örtük TRY yok.** `NormalizedOffer.currency` artık varsayılansız bir
alan; sessiz `"TRY"` varsayılanı kaldırıldı. Shopify teklifinin para birimi
kapının şart koştuğu, doğrulanmış `feed_config.currency`'den gelir
(`0029`); kayıt düzeyinde ikinci bir kilit TRY dışı Shopify teklifini
reddeder. Döviz çevrimi yok, TRY dışı Shopify mağazası desteklenmez.

**Ürün tavanı.** `feed_config.transport.shopify.max_products` artık her
zaman geçerli: yoksa **30** (`0023`'ün 20–30 sınırı), bootstrap açıkça
yükseltir (`0027`). Yalnızca 1–3.500 arası JSON tamsayısı kabul edilir;
`"30"`, `0`, `true` gibi değerler connector kurulurken, istekten önce hata
verir — tavan sessizce kalkmaz. Sayfa boyu tavana kısılır ve koşu boyunca
sabit kalır; tavan dolunca sonraki sayfa istenmez.

## Gerekçe

Önceki davranışta doğrulanmamış bir Shopify merchant'ı için `run_ingest`
önce `/products.json`'u çekiyor, sonra her kaydı `normalize`'da "para birimi
bilinmiyor" diye reddedip koşuyu `partial` bitiriyordu. Veri yazılmıyordu ama
mağazaya gereksiz istek gidiyor, `is_active` hiç okunmuyordu ve red kayıt
düzeyinde gizleniyordu. Kararı koşu düzeyine almak hem mağazaya saygılı
(`0023`'ün sınırları) hem de izlenebilir: tek bir `ingest_run` satırı nedenini
söyler.

`meta.json` `0029`'un kanıt setinde zaten taban para birimi kaynağıydı; tek
istekle, sepet ya da oturum açmadan okunabilir.

## Sonucu

- `services/ingest/collect/verify_currency.py`, `collect/gate.py` (yeni).
- `collect/pipeline.py`: kapı, `IngestResult.refusal`, Shopify TRY kilidi.
- `collect/records.py`: `currency` varsayılansız.
- `collect/sources/shopify.py`: `max_products` varsayılanı ve doğrulaması.
- `collect/__main__.py`, `collect/bootstrap.py`: red nedenini raporlar.
- Şema değişmedi; 0018'in 19 merchant'ı `is_active = false`,
  `currency_verified = false` olarak kaldı.

## Açık konu

Canlı doğrulama henüz koşulmadı. `myshopify.com` alan adları özel alan
adına yönlendirebilir; yönlendirme izlenmediği için böyle bir mağaza `FAIL
http_301` olur. Bu durumda karar (alan adını güncellemek mi, mağazayı
bırakmak mı) canlı rapora bakılarak ayrıca verilir.

## Reddedilen alternatifler

- **Yönlendirmeyi izlemek.** İkinci istek demek; `0023`'ün tek deneme kuralını
  deler.
- **Doğrulama komutunun `currency_verified`'ı kendisinin yazması.** Canlı
  sonucun insan onayından geçmeden veritabanına ve oradan kataloğa akması
  demek; aktivasyon onaylı rapora dayanan ayrı bir migration olarak kalır.
- **Kaydı yine `normalize`'da reddetmekle yetinmek.** Mağazaya gereksiz istek
  atar ve reddi binlerce kayıt satırına dağıtır.
