# 0134 — WAL geri basıncı: toplu katalog yayını arşiv kapasitesine göre yavaşlar

## Karar

1. **Ölçü arşiv borcudur, `pg_wal` dizin boyutu değil.** Toplu yazma işleri
   (`catalog_build build | gate | publish`) her partiden önce **arşivlenmemiş WAL**'i ölçer:
   `pg_current_wal_lsn()` − son arşivlenen segmentin sonu (`pg_stat_archiver.last_archived_wal`).
   Yalnız herkese açık fonksiyonlar okunur; `arilla_app` superuser değildir
   (`services/ingest/db/wal_pressure.py`).
2. **Hız denetimi işin içindedir, partiler arasında.** Açık işlem yokken:
   - gecikme ≤ hedef: tam hız;
   - hedef < gecikme < duraklama: parti arası uyku, üretimi arşiv hızının `factor` katına
     çeker (`factor` hedefte 1, duraklama sınırında 0,1; uyku en çok 30 sn);
   - gecikme ≥ duraklama: `resume` altına inene kadar bekler (histerezis), en çok 1 saat;
   - arşiv başarısız (`last_failed_time > last_archived_time`): yazmaz, düzelene kadar bekler,
     en çok 15 dk;
   - arşiv açık ama ölçü yok (istatistik sıfırlanmış): kör yazmaz, duraklama gibi bekler.

   Sınır aşılırsa iş **3 koduyla** çıkar (`job_run.status = partial`); tamamlanan partiler kalır,
   aynı komut kaldığı yerden sürer. Bekleme sırasında SIGTERM en geç 5 sn'de fark edilir.
   Kapatan bayrak yoktur; `archive_mode=off` (yerel) iken etkisizdir.
3. **Tüm WAL eşikleri pgBackRest kuyruk sınırından türetilir** (`archive-push-queue-max`,
   varsayılan 4 GiB). Bu sınır aşılırsa pgBackRest WAL'i "arşivlendi" sayıp **bırakır** ve PITR
   zinciri kopar. İş içi: hedef %25, duraklama %37,5, devam %12,5. Bekçi
   (`infra/vps/bin/catalog-publish`): duraklama %50, devam %12,5. Bekçi eşiği %75'i aşamaz
   (bir parti + SIGTERM gecikmesi kadar pay); aşan yapılandırmayla başlamaz.
4. **Bekçi duraklamadan çıkmak için yalnızca arşiv borcuna bakar.** Tutulan WAL (redo sonrası +
   arşivlenmemiş) yalnız checkpoint'in yetişmediği patolojide bekletir. `pg_wal` toplamı **eşik
   değil, gözlemdir**: recycled ve removable segmentleri PostgreSQL kendisi geri alır. Toplama
   eşik koymak kök nedeni emniyet ağına taşır (laboratuvarda görüldü); diskin asıl koruması
   `DISK_RESERVE_GB` KESİN DUR'udur. Disk rezervi, arşiv hatası,
   değişmez doğrulaması ve STOP aynen kalır. Yeni KESİN DUR koşulu: postgres günlüğünde
   `dropped WAL file` (pgBackRest WAL bıraktı). Bekçi sinyal alırsa işi güvenle durdurur.
5. `pg_wal` dört sınıfa ayrılarak izlenir (`catalog-publish walstat`, `wal-metrics.csv`):
   `recycled` (yeniden kullanılacak), `removable` (arşivlendi, sonraki checkpoint siler),
   `redo sonrası`, `arşivlenmemiş`. Ayrıca üretim/arşiv hızı, FPI oranı ve checkpoint sayaçları.

## Gerekçe (kök neden, laboratuvarda yeniden üretildi)

Önceki bekçi `sum(pg_ls_waldir())` ile `WAL_PAUSE_GB=10 / WAL_RESUME_GB=5` kullanıyordu.
Dizin arşiv borcundan fazlasını tutar:

- **recycled:** checkpoint sonrası PostgreSQL, sonraki checkpoint'e yetecek kadar segmenti
  yeniden kullanmak için saklar. Üst sınır `max_wal_size` (4 GB). Yoğun yazımdan sonra
  checkpoint tahmini yüksek kalır; dizin boşta bile ≈ `max_wal_size` olur. Elle CHECKPOINT
  sonrası görülen "~4 GB" budur.
- **removable:** yavaş arşiv sırasında başlayan checkpoint `.ready` segmentleri silemez. Bu
  segmentler arşivlendikten sonra da **bir sonraki checkpoint bitene kadar** dizinde kalır:
  `checkpoint_timeout` (15 dk) + yayılma (0,9 × 15 dk) ≈ 28 dk.

Dolayısıyla arşiv boşaldığında dizin ≈ `max_wal_size` + removable olur, yani ≥ 5 GB. Eski devam
koşulu (`< 5 GB` ve 120 sn kesintisiz sağlık) ancak bir sonraki zamanlı checkpoint bittiğinde
sağlanıyordu; elle CHECKPOINT bu bekleyişi kısaltıyordu. Ölçek küçültülmüş laboratuvar
(`max_wal_size=256MB`, `checkpoint_timeout=300s`, yavaş `archive_command`):

| an | dizin | recycled | removable | redo sonrası | arşivlenmemiş |
| --- | --- | --- | --- | --- | --- |
| yük sırasında | 384 MB | 0 | 32 | 192 | 336 |
| arşiv boşaldı (+16 sn) | 448 MB | 64 | 256 | 128 | **0** |
| +9,5 dk, zamanlı checkpoint bitti ("12 removed, 11 recycled") | 256 MB | 240 | 0 | 16 | 0 |

Dizin arşiv boşaldıktan sonra 9,5 dk boyunca `max_wal_size`'ın 1,75 katında kaldı ve ancak
zamanlı checkpoint (300 sn + 270 sn yayılma) bitince indi. İndiği değer tam `max_wal_size`.

İkinci bulgu: eski `READY_PAUSE=256` dosya × 16 MB = 4 GiB, pgBackRest kuyruk sınırına
**eşittir**. Bekçi her 20 sn'de bakıp mevcut partinin bitmesini beklediği için kuyruk sınırı
aşılabilir; aşılırsa WAL bırakılır. Ayrıca dur-kalk döngüsü (256 dosyaya kadar tam hız →
duraklama → ~28 dk checkpoint bekleyişi) ortalama hızı arşiv kapasitesinin çok altında tutar.
İş içi oransal denetim simülasyonda verimi arşiv hızının %100'üne oturttu ve gecikmeyi
hedef civarında tuttu (5/20/60 MB/sn arşivde en yüksek gecikme 336/320/288 MB; hedef 256,
duraklama 512; hiç duraklama yok).

## Ayarlar

Ayrıca (yeniden başlatmasız, `pg_reload_conf()`): `max_wal_size` 4GB → 16GB, `min_wal_size`
1GB → 2GB, `wal_compression` `on` (pglz) → `zstd`, pgBackRest `archive-push` `process-max` 1 → 2.
Laboratuvarda aynı 150 bin ürünlük yayın yükü: 256MB/pglz 1108 MB WAL (8 checkpoint),
2GB/pglz 728 MB (0), 256MB/zstd 721 MB, 2GB/zstd 678 MB (−%39). Daha az WAL, darboğaz olan
arşivde daha az iş demektir. Ayrıntı ve geri alma: `docs/ops.md` "Toplu yayın ve WAL geri basıncı".

## Reddedilen

- **Bekçinin otomatik `CHECKPOINT` çalıştırması:** elle yapılanı otomatikleştirir ama ölçü
  yine yanlış kalır. Ayrıca `CHECKPOINT` yayılmaz: 2 GB `shared_buffers` tam hızla diske
  yazılır ve site gecikmesi sıçrar.
- **Eşikleri büyütmek (`WAL_RESUME_GB=8` gibi):** `max_wal_size` değişince yeniden kırılır
  ve kuyruk sınırıyla bağını koparır.
- **`max_wal_size`'ı küçültmek:** checkpoint sıklaşır, her checkpoint sonrası ilk dokunuşta
  tam sayfa yazımı (FPI) WAL'i şişirir ve sorunu büyütür.
- **Bekçinin işi SIGTERM ile durdurup yeniden başlatması (tek denetim):** kaba taneli; her
  duraklamada iş yeniden başlar ve dryrun/preflight yükü doğar. Bekçi yalnız emniyet ağıdır.
- **`pg_ls_waldir` / `pg_ls_archive_statusdir` için uygulama rolüne `pg_monitor`:** gereksiz
  yetki. LSN farkı aynı bilgiyi yetkisiz verir.
- **Replikasyon yuvası / `wal_keep_size` ile arşivi tamponlamak:** WAL'i sınırsız tutabilir,
  disk riskini büyütür.
