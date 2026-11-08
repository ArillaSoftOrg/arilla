# 0175 — Besleme küçülmesinde seviye onayı (içeriği her dışa aktarımda değişen kaynak)

**Tarih:** 8 Kasım 2026 · **Durum:** kabul edildi · **Değiştirdiği:** 0152 §2b (onay kapsamı; kapı aynı)

## Bağlam

Besleme 14 (Admitad AliExpress, "до 10$" bandı) 5 Kasım'dan beri `too_few_records` karantinasında:
son tam sürüm 3.448.593 kayıt; sonraki dosyalar 1.965.271 (üç kez), sonra 1.576.311. Dosyalar
yapısal olarak tam (gzip tam, bütünlük taraması `ok`, kapanış etiketi var): kesik indirme değil,
kaynak küçülmüş. `arilla-feeds-daily` her koşuda `failed` bitiyor.

0152'nin onayı tek içeriğe (çözülmüş içeriğin sha256'sı) bağlıdır ve sonraki indirme aynı içeriği
getirince kabul eder. Bu kaynakta aynı içerik bir daha gelmiyor: sürüm 44, 46 ve 47'de çözülmüş
bayt (3.600.406.696) ve kayıt sayısı birebir aynı, sha256 farklı (dışa aktarım tarihi vb.). Reddedilen
dosya da diskte tutulmaz (`_cleanup`). Sonuç: insan onay vermek istese bile mekanizma bu beslemeyi
hiç açamıyor.

## Karar

1. `feeds approve-drop … --level`: insan, karantinadaki sürümün içeriği yerine boyut SEVİYESİNİ
   onaylar (`job_run.detail.scope = "level"`; varsayılan `"content"` ve davranışı değişmez).
2. Süre boyunca (`--ttl-days`, 1–30; öneri 3) bu beslemenin kayıt sayısı onaylanan sürümün
   `min_ratio_vs_median` (%85) katından az OLMAYAN dosyaları kayıt sayısı kapısını geçer. Her kabul
   ayrı `feed_drop_accepted` satırıdır. Seviye onayı süre içinde birden çok sürümü kabul ettirebilir:
   medyan ancak yeni seviyede birkaç tam sürümle güncellenir.
3. Değişmeyenler: kapı ve %85 eşiği, otomatik kabul yokluğu (onay her zaman insan + gerekçe +
   `--confirm`), yalnız `too_few_records` onaylanabilir, bütünlük taraması / hata oranı /
   `no_deactivate` / deaktivasyon tavanı atlanmaz. Seviyenin de altına düşen dosya yeniden
   karantinaya girer ve yeni insan kararı ister. Aynı besleme için ikinci geçerli seviye onayı
   verilmez.

## Reddedilen alternatifler

- **Reddedilen dosyayı saklayıp onayla işlemek:** her besleme için 0,5–1 GB ek disk ve saklama
  ömrü yönetimi; yine de ertesi gün içerik değişir.
- **Özeti oynak alanları (tarih) atarak hesaplamak:** hangi alanların değiştiği kaynağa göre
  değişir ve fiyatlar da her gün değişir; kırılgan.
- **Eşiği düşürmek / beslemeye kapatma ayarı:** 0152 bilinçli olarak kapatma ayarı vermez.
- **Beslemeyi durdurmak:** bandın fiyatları tazelenmez; kalıcı çözüm değil.
