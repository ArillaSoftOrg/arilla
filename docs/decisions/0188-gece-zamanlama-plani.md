# 0188 — Gece zamanlama planı: akşam beslemesi 00:30 TR'ye, yedek penceresi kesmesi, katalog güvenlik ağı

Tarih: 2026-11-12. Bağlam: karar 0145 (günlük besleme), 0162 (süre bütçesi), 0164 (otomatik katalog hattı),
0184 (besleme alarmı), 0110/0183 (yedek penceresi). Saatler UTC'dir; Türkiye = UTC+3 (yaz saati yok).

## Sorun (12 Kasım, üretimde salt okunur ölçüm; 7–14 gün)

### Akşam koşusu yoğun saate düşüyor ve sürekli eksik kalıyor

Akşam koşusu 18:30 UTC'de, yani 21:30 TR'de başlıyor. Tahmini en yoğun kullanıcı saatleri 20:00–23:30 TR.

| Ölçüm | Değer |
| --- | --- |
| Disk G/Ç, 22:00 TR | ort. 1406 tps, en yüksek yazma 107 MB/s, iowait en fazla %21 |
| Disk G/Ç, 00:00 TR | ort. 1296 tps, en yüksek yazma 134 MB/s, iowait en fazla %31 |
| Akşam koşuları (6–12 Kas.) | 7/7 `partial` (çıkış 1 → `OnSuccess` yok, alarm) |
| `feed 7` (~1,5 GB) akşam indirmesi | 10–12 Kasım arası 18:50–21:05 UTC'de 9 deneme, 9'u da `truncated` |
| Aynı sürüm, ertesi sabah | 07:04–07:07 UTC'de `complete` |
| Kaynak yayımı (`source_updated_at`) | 09:30–17:40 UTC |
| Koşu süresi (`job_run`, 14 gün) | ort. 59 dk, en uzun 2 sa 49 dk |
| Besleme başına en uzun süre | `feed 7` 75 dk, `feed 14` 49 dk; keşif ve başlangıç ~20 dk |

CPU (4 çekirdek, saatlik ortalama ≤ %16) ve RAM (11 GB boş) darboğaz değil. Asıl kaynak disk G/Ç ve WAL'dir.

Kullanıcı trafiği ölçülemiyor. Umami 7 Kasım'dan bu yana yalnızca 181 olay saydı (site herkese açık değil).
Caddy trafiği saatler arasında düz (botlar ve izleme). Plan, Türk e-ticaretinin tipik profiline dayanıyor:
en düşük trafik 02:00–07:00 TR, en yüksek 20:00–23:30 TR.

### Gecikmiş koşu yedekle çakışabiliyor

- Bütçe 4 saattir: başlangıçtan 4 saat sonrasına kadar yeni besleme açılabilir.
- Gecikmiş ya da `Persistent` yakalama koşusu yedek penceresine (01:20–02:05 UTC) taşabilir.
- `catalog_build` yedek penceresini biliyor, besleme bilmiyor.

## Karar

1. **Akşam beslemesi 18:30 → 21:30 UTC (00:30 TR).** Sabah koşusu 06:30 UTC (09:30 TR) aynen kalır.
   Gerekçeler:
   - Tahmini yoğun saatten çıkar.
   - Kaynak yayımından en az 4 saat sonradır.
   - Ortalama koşu `refresh-product-aggregates`'ten (23:45 UTC) önce biter. Böylece fiyat özeti o
     geceki fiyatları içerir.
   - Yedek penceresine 3 sa 50 dk kalır.
2. **Yedek penceresi kesmesi (bu PR).** `feeds daily` CLI'den çağrılınca yedek penceresinin
   başlangıcından 90 dk önce (23:50 UTC) yeni besleme başlatmaz.
   - Bütçe yalnızca kısalır. Başlamış birleştirme bitirilir.
   - Ertelenen besleme hata değildir (0162) ve sonraki koşuda önce alınır.
   - Kesme ile pencere sonu arasında başlayan koşu hiçbir besleme açmaz. Bu, gecikmiş ve yakalama
     koşularını kapsar.
   - En kötü durum: 23:50 + 75 dk = 01:05 UTC. Bu, 01:20'den önce biter.
   - **Sert durak:** Kesmeden önce başlamış bir birleştirme (WAL geri basıncı, yavaş disk) yine de uzarsa,
     01:15 UTC'de (pencereden 5 dk önce) parça sınırında durur (`SyncPaused`). Bu hata değildir: snapshot
     `processing` kalır, besleme hata kaydı yazılmaz, besleme ertelenmiş sayılır (`feeds_paused_ids`) ve
     sonraki koşu aynı sürümü kaldığı parçadan sürdürür. Böylece yedek penceresine taşma, koşu süresinden
     bağımsız olarak önlenir.
   - Kapatma: `--ignore-backup-window`. Pay ayarı: `FEED_DAILY_BACKUP_MARGIN_MINUTES`.
3. **Katalog güvenlik ağı 21:15 → 03:00 UTC (06:00 TR).** 12:15 UTC tetiği aynen kalır.
   - Asıl tetik tamamlanmaya bağlıdır: besleme başarıyla bitince `OnSuccess` (0164).
   - 21:15'teki ağ, yeni gece beslemesinin 15 dk önüne düşer, onunla yarışır ve her başlangıçta
     beslemeye yol verip durur.
   - 03:00 şu işlerden sonradır: yedek (bitiş en geç ~02:05), gece hattı (02:30, < 1 dk) ve
     `cleanup-auth`. Sabah beslemesinden (06:30) 3,5 saat öncedir.
4. **Değişmeyenler:**
   - Yedek penceresi 01:20–02:05 UTC (04:20–05:05 TR).
   - Gece hattı 02:30 UTC.
   - `refresh-product-aggregates` 23:45 UTC.
   - WAL arşivi, sağlık kontrolü, 15 dakikalık ve saatlik işler.
   - Doğrulama ve prova zamanlayıcıları.
   - 70 GiB başlangıç eşiği.

### 00:30 TR mi, 01:15 TR mi?

| | 00:30 TR (21:30 UTC) | 01:15 TR (22:15 UTC) |
| --- | --- | --- |
| Kesmeye kadar süre | 2 sa 20 dk | 1 sa 35 dk |
| Tipik koşu (~1,5–2,4 sa: keşif + `feed 14` + `feed 7`) | Kesmeden önce sığar | `feed 7` sıkça ertelenir |
| Yeniden deneme turları (10 + 20 dk bekleme; `truncated` için gerekli) | Kesme içinde kalır | Çoğu kez kesmeye takılır |
| `aggregates` (23:45) sırası | Ortalama koşu (~22:30) önce biter | Ortalama koşu (~23:15) sınırda; geç kalırsa özet eski fiyatı gösterir |
| Kaynak yayımından uzaklık | ≥ 3 sa 50 dk | ≥ 4 sa 35 dk |
| En son gözlenen `truncated` (21:05 UTC) | 25 dk sonra | 70 dk sonra |
| Tahmini trafik | Düşük | Daha düşük |

00:30 TR seçildi. Belirleyici fark, yeniden denemelere ve fiyat özetine yer kalması.

Kesik indirmenin nedeni bilinmiyor. Akşam saatinin etkisi kuvvetli: aynı sürüm sabah iniyor. Ancak gece
saati için ölçüm yok. **7 gece ölçülür.** `feed 7` gece de kesik kalırsa aynı birimde 22:15 UTC'ye
geçilir ve bu karar güncellenir.

## Çakışma ve yakalama kuralları

- **`Persistent=true`:** Uygulama anında, yeni takvimin son tetik anı kayıtlı son koşudan yeniyse
  zamanlayıcı **hemen** çalışır.
  - Besleme değişikliği 06:35–18:25 UTC arasında uygulanır. O aralıkta son tetik 06:30'dur; yeni
    21:30 tetiği dünkü olduğu için daha eskidir ve yakalama oluşmaz.
  - Katalog ağı değişikliği 12:20 UTC'den sonra uygulanır. 03:00 tetiği daha eskidir.
  - Bu davranış CI'da gerçek systemd ile sınanır (`test-night-schedule-units.sh`).
- **Çift koşu:**
  - Oneshot birim çalışırken ikinci kez başlamaz.
  - Ayrıca `feeds daily` (4302) ve `catalog_auto` (4133201) advisory kilitleri var.
  - Zamanlayıcı ile `OnSuccess` aynı anda gelirse tek koşu olur.
- **Gecikme:**
  - Besleme kesmesi (madde 2) yedeğe taşmayı önler.
  - `catalog_auto` yedek penceresinde başlamaz ve çalışırken durur (0164).
  - `catalog-auto-guard` yedek, besleme ve gece hattı çalışırken atlar.
  - Yedek kendi `flock`'unu kullanır ve kimseyi beklemez. Pencere korunur.
- **Uzun kapanma sonrası:** Açılışta besleme, yedek ve katalog işleri yakalanabilir. Yedek penceresinde
  açılan makinede besleme hiçbir besleme açmaz (madde 2). Katalog hattı pencerede başlamaz.

## Bilinen sınırlar

- `Nice=10` ve `IOSchedulingClass=idle`, `docker compose run` birimlerinde yalnızca istemci sürecine
  uygulanır. 12 Kasım akşam koşusu ~2 saat sürdü; birimin cgroup'u 0,85 sn CPU ve 23 MB kullandı.
  Asıl iş `system.slice/docker-*.scope` içindedir: nice 0, `cpu.weight` 100, `io.weight` 100.
  PostgreSQL'de CPU sınırı yoktur. Önceliği gerçekten düşürmek compose düzeyinde bir değişiklik ister
  (`cpu_shares`, `blkio_config`). Bu ayrı bir karardır.
- `refresh-product-aggregates` sabit saatlidir (supercronic, `vercel.json` eşitliği CI'da denetlenir).
  Beslemenin bitişine bağlanması ayrı bir değişikliktir.

## Uygulama sırası

Her adım insan onaylıdır. Çalışan bir iş varken hiçbir adım uygulanmaz.

1. Bu PR (kesme kodu) birleşir ve deploy edilir. Gelecek koşularda `detail.backup_cutoff` ve `budget_s`
   görünür. Sabah koşusunda kesme etkisizdir.
2. Zamanlayıcı PR'ı birleşir. Deploy yalnızca `/opt/arilla/vps/systemd` kopyasını günceller; kurulu
   zamanlayıcı **değişmez**.
3. Uygulama:
   - 06:35–18:25 UTC arasında, `systemctl is-active arilla-feeds-daily` `inactive` iken:
     `feeds-timers install --confirm`.
   - 12:20 UTC'den sonra: `catalog-auto-timers install --confirm`.
   - Doğrulama: `systemctl list-timers 'arilla-*'` çıktısında sonraki besleme 21:30 UTC, katalog ağı
     03:00 ve 12:15 UTC görünmeli; servis hemen başlamamış olmalı.
4. 7 gece izleme:
   - `job_run` (`feed_daily` durumu, `feeds_deferred`, `backup_cutoff`)
   - `source_snapshot` (`feed 7` `truncated` oranı)
   - sar (22:00 ve 00:00 TR G/Ç)
   - `catalog-auto:freshness`

## Geri dönüş

- Zamanlayıcı: `infra/vps/systemd` dosyaları revert edilir ve deploy edilir. Ardından aynı
  `install --confirm` komutu aynı uygulama kurallarıyla çalıştırılır. Eski 18:30 tetiği, 06:35–18:25
  arasında yakalama üretmez.
- Kesme: `FEED_DAILY_BACKUP_MARGIN_MINUTES=0` (kesme 01:20'ye kayar) ya da revert ve deploy.
- Veri etkisi yok. Besleme idempotenttir (`(merchant_id, external_id)`), `price_point` yalnızca
  INSERT'tir.

## Reddedilen alternatifler

| Alternatif | Neden değil |
| --- | --- |
| Akşamı 01:15 TR'ye almak | Kesmeye 1 sa 35 dk kalır, yeniden denemeler ve `aggregates` sırası bozulur (tablo) |
| Yedeğin beslemeyi beklemesi | Yedek penceresi kayar. `catalog_build`'in sabit penceresi ve yedek yaşı eşikleri buna bağlı |
| Akşam koşusunu kaldırmak | Gün içi yayımlanan sürüm ertesi sabaha kalır. 9:30'daki güvenlik ağıyla birlikte iki koşu tutulur |
| 70 GiB eşiğini düşürmek | Yayın disk ve WAL üretir. Eşik besleme indirmesi ve yedek payıyla hesaplı (0164) |
| Ağır işleri tek global kilitte sıralamak | Mevcut kilitler, guard ve bu kesme gözlenen çakışmaları kapatıyor. Ölçülen ihtiyaç yok |
