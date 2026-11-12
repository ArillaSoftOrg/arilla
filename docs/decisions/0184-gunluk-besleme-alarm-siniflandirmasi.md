# 0184 — Günlük besleme alarmı `job_run` sonucuna göre sınıflandırılır

> Numara notu: ilk olarak 0182 numarasıyla (#314) birleşti; aynı numara #313'teki embedding kararıyla çakıştığı için 0184'e taşındı. İçerik değişmedi.

Tarih: 2026-11-11. Bağlam: karar 0145 (günlük besleme), 0152 (sürüm reddi), 0174 (PR1c alarm
sınıflandırması).

## Sorun

`arilla-feeds-daily` `partial` bittiğinde çıkış 1 verir; `OnFailure` her koşuda kritik "SORUN"
gönderir ve birim bir sonraki koşuya kadar `failed` kaldığı için 5 dakikalık sağlık kontrolü
6 saatte bir hatırlatır. 8–10 Kasım'da altı koşunun altısı da `partial` bitti: nedenleri kaynak
tarafındaydı (kesik dosya, `too_few_records`, `behind`). Bu yüzden alarm sürekli kritikti ve gerçek
bir bozulmayı (ör. 8 Kasım'da taze teklif 0) geçici redden ayırmıyordu.

## Karar

Birim ve ingest kodu değişmez: `partial` yine çıkış 1 verir. Böylece başarılı koşuya bağlı
`OnSuccess` (katalog hattı) tetiklenmez ve davranış 0145/0162 ile aynı kalır. Sınıflandırmayı
alarm betiği (`infra/vps/bin/arilla_healthcheck.py`) bu koşunun `job_run` kaydından yapar. Bu,
0174 PR1c ile aynı mekanizmadır.

**INFO** için şu koşulların hepsi sağlanmalıdır:

- Çıkış 1 ve kayıt `partial`.
- `error_summary` içindeki sorunların hepsi `feed_<id>:<kod>` biçiminde.
- `fx_stale` yok ve keşif başarısız değil.
- En yeni besleme yazımı (`last_success_at`) 36 saatten yeni.
- `offers_fresh / offers_active` ≥ %25.

Bu durumda tek bir "BILGI" gönderilir. Mesaj sağlık kontrolünde kritik sayılmaz, parmak izine
girmez ve ölü adam `/fail` pingi atmaz. Önceki koşu da aynı sorun listesiyle INFO olduysa BILGI
yeniden gönderilmez; liste değişirse gönderilir.

Geri kalan her durum **CRIT** olur ve fail-closed çalışır. Bu durumlar `failed`, kur bayatlığı,
keşif hatası, `feeds_gone`, eşik altı tazelik, bu koşuya ait kaydın olmaması ve okunamayan
durumdur.

**`feeds:freshness`**: son günlük koşu kaydı 30 saatten eskiyse CRIT. Bilgi düzeyindeki `partial`
artık sessiz olduğu için durmuş bir zamanlayıcıyı bu kural yakalar.

## Eşiklerin gerekçesi

- **%25:** Üç bantlı AliExpress'te tek güncel besleme yaklaşık %40 taze teklif verir (10 Kas).
  Hiç güncel besleme yoksa oran 0'dır (8 Kas). %25, en az bir bandın yazıldığını ayırır.
- **36 saat:** Günde iki koşu yapılır; bu süre üç kaçan koşuya karşılık gelir. Panelin
  "zamanında çalışmadı" sınırıyla aynıdır.
- Eşikler `THRESHOLDS` içindedir. Kaynak güncelleme sıklığı ölçüldükçe ayarlanır.

## Sınırlar

- `error_summary` ilk beş sorunu taşır. Keşif sorunları önce yazıldığı için listeye girer.
  `fx_stale` ayrıca `detail.fx_stale` bayrağından okunur. Kesilmiş ya da tanınmayan bir öğe
  CRIT'e düşer.

## Reddedilen alternatifler

- **`partial` için çıkış 0 vermek ya da `SuccessExitStatus` kullanmak:** `OnSuccess` ile katalog
  hattı her `partial`'da tetiklenirdi ve gerçek sorunlar alarmdan tamamen düşerdi.
- **Art arda ikinci `partial`'ı CRIT saymak (PR1c'deki gibi):** Kaynak tarafı redler günlerce
  sürebiliyor. Asıl önemli olan fiyatların tazeliği; koşu sayısı değil.
