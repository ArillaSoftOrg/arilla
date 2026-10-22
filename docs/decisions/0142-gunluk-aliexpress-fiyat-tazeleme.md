# 0142 — Günlük AliExpress fiyat tazeleme

**Tarih:** 22 Ekim 2026
**Durum:** Kabul edildi. Kod ve testler hazır; **üretimde zamanlayıcı kurulu değil**, etkinleştirme
ayrı ve onaylı bir adımdır. Migration yok.
**Bağlam:** 0111–0114 (besleme modeli, senkronizasyon, kur, yurt dışı teklifler), 0124 (yurt dışı
teklifli ürün aramada), 0128 (Admitad), 0134 (WAL geri basıncı).

## Sorun

22 Ekim denetimi: AliExpress fiyatlarını günlük güncelleyen hiçbir zamanlayıcı yoktu. Besleme
motoru (`feeds sync-due`) tam, idempotent ve kaldığı yerden devam eden bir senkronizasyon yazıyor,
ama (1) hiçbir şey onu çalıştırmıyor, (2) `source_updated_at` imleci yalnız `feeds discover` ile
tazelendiği için keşifsiz `sync-due` yeni sürümü hiç görmez, (3) fiyatın ne kadar taze olduğunu
ölçen ve raporlayan bir şey yok, (4) kur 4 günden eskiyse yurt dışı ürünler sessizce aramadan düşer.

## Karar

1. **Yeni veri kaynağı, yeni yazma yolu, yeni tablo yok.** Fiyat yine yalnız Admitad beslemesinden
   gelir (0112) ve `FeedSync` ile yazılır. `price_point` yalnız INSERT, yalnız yeni ya da değişen
   fiyat/stok için (0112 madde 6). Geçmiş silinmez ve güncellenmez.
2. **`python -m feeds daily --merchant <slug>`** (`services/ingest/feeds/daily.py`) tek bir
   orkestratördür: kilit → uygunluk → keşif → senkronizasyon → tazelik ölçümü. Yeni senkronizasyon
   mantığı içermez; `sync-due` döngüsü `feeds/runner.py`'ye çıkarıldı ve ikisi aynı kodu kullanır
   (`sync-due` davranışı değişmedi; testle doğrulandı).
3. **Tek koşu garantisi.** `(4302, merchant_id)` advisory kilidi; ikinci koşu hata vermeden
   `skipped=already_running` ile çıkar. Besleme başına kilit (4301) ve systemd'in oneshot birimi
   ikinci kez başlatmaması ek koruma.
4. **Aşama kapıları atlanmaz.** Günlük iş yalnız en az bir `complete` sürümü olan beslemeyi işler.
   Hiç tam sürümü olmayan besleme `initial_load_required` olarak raporlanır ve indirilmez. İlk yükleme
   (10 bin → 100 bin → tam, her aşamada disk/WAL/yedek ölçümü) 0114'teki gibi elle ve onayla yapılır;
   tamlık kapısının `too_few_records` kontrolü de önceki tam sürüme dayandığı için bu kapı zorunludur.
5. **Kesinti güvenliği.** Parça kontrol noktaları, indirilmiş dosyanın yeniden kullanımı ve kaldığı
   yerden devam `FeedSync`'te zaten vardır (0112, 0114). Günlük iş bunlara dokunmaz. Geçici ağ ya da
   indirme hatasında (`DownloadError.retryable`, `NetworkUnavailable`) koşu içinde sınırlı ek tur
   (varsayılan 2; 10 ve 20 dakika bekleyerek). Kalıcı hata (disk, boyut, tamlık) yeniden denenmez.
   Zamanlayıcı günde iki kez tetiklenir (06:30, 18:30 UTC); kaynak değişmediyse ikinci koşu indirmeden
   biter.
6. **Kaynak tarihi ile yazım tarihi ayrı.** `feed_source.source_updated_at` = kaynağın bildirdiği
   güncelleme; `last_success_at` = bizim tam yazımımız. İkisi `job_run.detail`'de ayrı alanlardır
   (`source_updated_at`, `last_success_at`, `source_age_hours`). Migration gerekmedi: sürüm başına
   kaynak tarihi `source_snapshot`'a yazılmıyor; "elimizdeki veri hangi kaynak sürümü" sorusu
   `last_success_at >= source_updated_at` ile (güncel) ya da değilse (geride) cevaplanır.
7. **Kur: çoğaltma yok, kısmi başarısızlıkta uydurma yok.** USD fiyat orijinal para birimiyle
   saklanır, TRY **yazılmaz** (0112). TL karşılığı okuma yolunda son TCMB kuruyla hesaplanır ve kur
   4 günden eskiyse gösterilmez (`packages/core/src/pricing/fx.ts`, 0124). Kur çekimi zaten
   `arilla-pricing-fx` zamanlayıcısındadır; günlük iş kuru **çekmez**, yalnız yaşını ölçer ve
   `fx_stale` olarak raporlar. Python tarafındaki 4 günlük sınır TS sabitiyle testle eşitlenmiştir.
8. **Tazelik ölçümü** (`feeds/freshness.py`, salt okunur). Her etkin/duraklatılmış besleme
   `current`, `behind` (kaynak bizden yeni), `source_stale` (kaynak 7 günden eski; ayarlanır),
   `never_synced` ya da `source_date_invalid` (gelecek tarih) olarak sınıflanır. Offer fiyatı, güncel
   bir beslemede üyeliği varsa güncel sayılır; offer'ın kendi `last_seen_at`'ine bakılmaz çünkü
   değişmeyen offer satırı yeniden yazılmaz (0114). `offers_stale` = etkin − güncel.
9. **Fiyat sıfırlanmaz, ürün aniden gizlenmez.** Kaynakta olmayan offer 0112'nin 48 saat bekleme ve
   %10 tavan kuralına tabidir. Bozuk fiyat kayıt bazında reddedilir; red oranı %2'yi aşarsa sürüm
   reddedilir ve hiçbir offer pasifleşmez. Güncellenemeyen ürünler `ingest_error`, `feed_source.last_error_*`
   ve `offers_stale` olarak izlenir.
10. **İzleme.** İş `job_run`'a `feed_daily` adıyla yazılır (`KNOWN_JOBS`: zamanlanmış, 36 saatte
    gecikmiş). Mevcut `/yonetim/islemler/isler` ve ops bulguları kullanılır; yeni panel yok. Gecikme
    bulgusu bu iş için `batch-timers` yerine `feeds-timers`'a yönlendirir.
11. **Zamanlama ve etkinleştirme ayrı.** `infra/vps/systemd/arilla-feeds-daily.{service,timer}`
    depoda durur ama `batch-timers` listesinde **değildir** (test bunu zorunlu kılar: besleme indirmesi
    disk/WAL yükü getirir; `batch-timers` başlığındaki mevcut karar: bilerek elle). Kurulum `feeds-timers install --confirm`
    ile, kontrol listesi (docs/ops.md) tamamlandıktan sonra yapılır. `Persistent=true`: sunucu
    kapalıyken kaçan koşu açılışta yakalanır; tekrarlanan koşu veriyi bozmaz (idempotent).

## Reddedilen alternatifler

| Alternatif | Neden değil |
| --- | --- |
| `batch-timers` listesine eklemek | Mevcut karar: büyük besleme indirmesi bilerek elle. Bir `install` komutu sessizce açardı |
| Günlük iş içinde kuru da çekmek | `arilla-pricing-fx` zaten var; iki yazıcı, iki kaynak |
| USD'yi günlük kurla TRY'ye çevirip `offer`/`price_point`'e yazmak | 2,8 milyon satır günlük yeniden yazılır (WAL, şişme), fiyat geçmişi kur gürültüsüyle dolar; 0124 de reddetti |
| Bayat kaynağı otomatik pasifleştirmek / merchant'ı kapatmak | Yanlış alarmda tüm AliExpress aramadan düşer; görünürlük kararı ürün kararıdır. Önce ölçüm |
| `source_snapshot`'a `source_updated_at` kolonu | Migration gerektirir; yeni soruyu `job_run.detail` ve mevcut iki tarih cevaplıyor. Gerekirse ayrı işte |
| Eksik ilk yüklemeyi günlük işin otomatik yapması | 0114 aşama kapılarını (10 bin → 100 bin → tam, onay) atlamak olurdu |
| Canlı AliExpress sayfasından fiyat doğrulama | İzinli kaynak yok (0113); kazıma yok |

## Sınırlar ve açık işler

- **Kaynak kadar taze.** Admitad `admitad_last_update` değerini ne sıklıkla değiştiriyor ölçülmedi.
  Kaynak haftada bir güncelleniyorsa fiyat en fazla o kadar tazedir. İlk haftanın `source_age_hours`
  verisiyle `--max-source-age-hours` ayarlanır. Kaynak tarih bildirmezse (`NULL`) besleme her koşuda
  yeniden indirilir. Admitad AliExpress beslemeleri tarih bildiriyor (0112); başka bir ağda bildirmezse sıklık düşürülmelidir.
- **Fiyat sıçraması koruması yok.** Tamlık kapısı kayıt sayısı ve red oranına bakar; "tüm fiyatlar
  100 kat arttı" gibi geçerli ama anlamsız bir beslemeyi yakalamaz. Fiyat dağılımı kapısı ayrı iş.
- **Okuma yolunda bayat fiyat gizlenmiyor (ayrı iş).** Günlük iş çalışmazsa mevcut fiyatlar
  `offers_stale` olarak ölçülür ve alarm üretir ama arama/kart yine eski USD fiyatı ve onun yaklaşık TL
  karşılığını (kur 4 günden eskiyse TL zaten çıkmaz) gösterir. Önerilen tasarım: yurt dışı `best_offer`
  seçimi, `offer.feed_source_id` ile `feed_source` (≈16 satır) birleştirip `last_success_at` ve
  `source_updated_at` için sert bir üst sınır (ör. 10 gün) arar; kur kuralıyla aynı felsefe ("fiyat
  uydurulmaz"). Bu, `packages/core` arama SQL'i ile `services/ingest/db/product_aggregates.py`'ı birlikte
  değiştirir (iki uygulama, çok klasör); "bir görev tek klasörle sınırlı" kuralı gereği ayrı görev.
- **Yönetim paneli.** Bu işin kapsamı `job_run` + mevcut iş listesi. Besleme başına tazelik tablosu
  (`/yonetim/ingest/beslemeler` içinde) ayrı görevdir; veriyi `feeds freshness` çıktısı ve `detail`
  zaten üretir.
- **Ölçek.** Besleme motorunun ölçümleri 0114'te: 491 bin kayıt ≈ 4,6 GB WAL ilk yüklemede; sonraki
  günlük koşularda yalnız değişen satırlar yazılır (değişmeyen kayıt upsert'e girmez). Milyonluk
  kataloğun günlük koşusu henüz üretimde ölçülmedi; ilk iki koşu izlenir.
