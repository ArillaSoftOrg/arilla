# 0110 — PostgreSQL yedekleme, WAL arşivi, PITR ve geri yükleme provası (pgBackRest → Cloudflare R2)

**Tarih:** 14 Ekim 2026
**Durum:** Kabul edildi; **kod ve testler hazır, üretimde ETKİN DEĞİL.** Etkinleştirme ayrı onayla,
planlı pencerede yapılır (PostgreSQL yeniden başlar). Karar 0109'un 5. fazını (yedekleme ve izleme) karşılar.

## Bağlam

- Üretim (`manicepte.com`) tek KVM 4 üzerinde çalışıyor. Veritabanının VPS dışında yedeği yok.
- Tek yedek, dağıtım betiğinin migration öncesi aynı diske aldığı `pg_dump`. Disk ya da VPS kaybı
  bütün veriyi götürür.
- `docs/ops.md` "Yedekleme" ilkeleri (sürekli WAL arşivi, zaman noktasına dönüş, aylık geri yükleme
  provası) şimdiye kadar yalnızca kâğıt üzerindeydi.

## Karar

1. **Araç: pgBackRest 2.59** (PGDG paketi).
   - Tam, fark ve artımlı yedek alır; WAL'ı sürekli arşivler; zaman noktasına (PITR) geri yükler.
   - İstemci tarafında AES-256 şifreler, depo bütünlüğünü doğrular (`verify`).
   - S3 uyumlu depoyu doğrudan destekler.
2. **Depo: Cloudflare R2** (S3 API).
   - Yalnız yedeğe ayrılmış bir bucket; token yalnız o bucket'a kapsamlıdır (Object Read & Write).
   - Endpoint `https://<hesap>.r2.cloudflarestorage.com`, bölge `auto`, yol biçimi `path`.
   - R2'nin desteklediği işlemler (ListObjectsV2, Put/Get/Head/Delete, DeleteObjects, multipart)
     Cloudflare belgesinden doğrulandı. pgBackRest R2'yi adıyla anmıyor; uyumluluk gerçek R2'de
     aktivasyondaki `repo-ls`, `check` ve `backup` adımlarıyla kanıtlanır.
   - CI'da ve yerelde R2 yerine TLS'li S3 uyumlu bir sunucu (VersityGW) kullanılır.
3. **Topoloji: postgres internete ÇIKMAZ** (karar 0109 ağ yalıtımı korunur).
   - `archive_command` WAL'ı `backup` yan konteynerine (pgBackRest TLS sunucusu) gönderir:
     karşılıklı TLS, `data` ağı, istemci sertifikası CN'si yalnız `arilla` stanza'sına yetkili.
   - R2'ye yalnız `backup` konteyneri (`data` + `egress`) bağlanır.
   - **R2 anahtarları ve şifreleme parolası postgres konteynerinde YOKTUR.**
   - `backup` veri dizinini salt-okunur bağlar ve unix soketini paylaşır.
4. **İmaj:** `infra/vps/postgres/Dockerfile`.
   - Taban, üretimdeki `pgvector/pgvector:0.8.1-pg16` digest'ine sabitlenir; üstüne pgBackRest eklenir.
   - Root olmadan (uid 999) çalışır.
   - Ayrı iş akışında (`build-postgres.yml`) Trivy ×2 ile taranır ve değişmez `pg16-<sha>` etiketiyle
     yayımlanır.
   - Uygulama sürüm manifestine **girmez**, `deploy`'u tetiklemez. `postgres` ve `backup` aynı imajı
     kullanır (TLS protokolü sürüm eşleşmesi ister).
   - Taban paket güncellemesi PostgreSQL'i **16.12'den 16.15'e (minor)** çıkarır. Veri biçimi aynıdır;
     yeni ikili aktivasyon yeniden başlatmasında devreye girer.
5. **Etkinleştirme dağıtımdan AYRIDIR.**
   - `postgresql.conf` sonunda `include_if_exists = '/etc/arilla-backup/archive.conf'` vardır.
   - Dosyayı yalnız `pg-backup-activate activate --confirm-restart` yazar. Bu dosya dağıtımın
     dokunmadığı `/opt/arilla/backup/pg/` altındadır.
   - Dosya yoksa arşiv kapalıdır. Satır, yeniden başlatmada zararsızdır.
   - Merge sonrası otomatik dağıtım yalnız `postgres` yapılandırma uyarısı verir; postgres'i yeniden
     BAŞLATMAZ (`arilla-deploy` kuralı). Web, worker, cron ve caddy hash'leri değişmez.
6. **Politika:**
   - Haftalık tam yedek (Pazar 01:30 UTC), günlük fark yedeği, sürekli WAL arşivi.
   - `archive_timeout=300`: düşük trafikte RPO üst sınırı yaklaşık 5 dk.
   - 4 tam yedek saklanır (yaklaşık 4 hafta PITR penceresi).
   - Haftalık `pgbackrest verify`, aylık izole geri yükleme provası.
   - Bu politika `ops.md`'deki eski "günlük tam yedek, 30 gün" metninin yerini alır.
7. **Disk koruması:**
   - `archive-async` ve `archive-push-queue-max=4GiB`. Depo uzun süre erişilemezse pgBackRest
     bekleyen WAL'ı bırakır: disk dolmaz, ama o noktadan sonra PITR kopar ve yeni tam yedek gerekir.
   - Sağlık kontrolü, bekleyen WAL ≥ 4 dosyada uyarı, ≥ 16 dosyada ya da 15 dk bekleyen dosyada
     kritik alarm verir. Yani alarm bu sınırdan çok önce gelir.
8. **Geri yükleme provası izoledir.**
   - `restore` konteyneri yalnız `egress` ağındadır; üretim veritabanına ve `data` ağına erişimi yoktur.
   - Boş bir dizine geri yükler, ayrı bir PostgreSQL'i yalnız soketle, arşiv kapalı açar
     (`--archive-mode=off`, `archive_command=/bin/false`).
   - Doğrulamalar:
     - kurtarmanın tamamlanması;
     - `pg_amcheck`;
     - şema özeti, aynı migration durumundaysa üretimle birebir aynı olmalı;
     - migration defteri;
     - tam satır sayımı;
     - RTO ölçümü.
   - Sonra dizin silinir.
9. **Geri alma modeli** (V4.1 §6.2 ile uyumlu):
   - Üretime yerinde PITR **varsayılan değildir**: hedef zamandan sonraki tüm yazmaları siler.
   - Kayıp veri önce yan instance'a geri yüklenir, oradan ileri-düzeltme ile geri yazılır.
   - Üretime yerinde geri dönüş yalnız felakette, kayıp penceresi yazılarak ve açık onayla yapılır.
10. **İzleme ve alarm:** `arilla_healthcheck.py` (5 dk'da bir, systemd).
    - Kontroller: disk %70/%80, konteyner sağlığı, PG bağlantı oranı, WAL arşiv kuyruğu, son/tam yedek
      yaşı, geri yükleme provası yaşı/sonucu, başarısız `arilla-*` birimleri.
    - Bildirim: `HEALTHCHECK_PING_URL` (ölü-adam anahtarı; VPS düşerse dış servis haber verir) ve
      `ALERT_WEBHOOK_URL`.
    - Yedek ve prova birimlerinde `OnFailure=` alarmı vardır.

## Reddedilen alternatifler

| Alternatif | Neden değil |
| --- | --- |
| postgres'i `egress` ağına almak (pgBackRest doğrudan R2'ye) | En basit yol, ama veritabanı konteynerine internet çıkışı ve R2 sırları verir; 0109 yalıtımını bozar |
| `archive_command` ile paylaşılan dizine `cp` + ayrı senkronizasyon | pgBackRest'in asenkron kuyruğunu, sağlama toplamını ve sıralamasını elle yeniden yazmak olur; kırılgan |
| Yerel (posix) depo + R2'ye `rclone sync` | Yedek yine aynı diskte büyür; senkronizasyon gecikmesi RPO'ya eklenir; iki araç |
| WAL-G | Aynı topoloji sorunu (ikili postgres konteynerinde olmalı); pgBackRest'in `verify`, TLS depo sunucusu ve saklama politikası daha olgun |
| Yalnız günlük `pg_dump` | PITR yok, RPO 24 sa, büyük veritabanında yavaş |
| R2 bucket lock'unu hemen açmak | pgBackRest `backup.info`/`archive.info` dosyalarını yerinde yeniden yazar. Kilitli nesneye silme/üzerine yazma davranışı R2 belgesinde açık değil. Prefix'e göre kilit, gerçek R2'de test edildikten sonra ayrı adım olarak değerlendirilir |

## Sonuçlar ve sınırlar

- **Üretimde henüz yedek YOK.** Gerçek R2 kimlik bilgileriyle aktivasyon yapılana kadar risk sürer.
  Adımlar: `docs/ops.md` "Yedekleme ve geri yükleme".
- **R2 token'ı nesne silebilir.** "Silmesiz yazma" izni yok. Sunucu ele geçirilirse yedekler
  silinebilir; bucket lock değerlendirmesi açık iş.
- **Şifreleme parolası kaybolursa yedekler açılamaz.** Parola aktivasyondan önce parola yöneticisine
  kaydedilir.
- **VPS tamamen kaybolursa** yeni sunucuda gereken üç şey: R2 bilgileri (Cloudflare'den yeniden
  alınabilir), şifreleme parolası (çevrimdışı kopya) ve repo. Uygulama sırları (`SESSION_SECRET` vb.)
  yeniden üretilebilir; oturumlar düşer.
- **Geri yükleme provası diskte yer ister** (veritabanı boyutu × 2 + 2 GiB). Yer yoksa prova başarısız
  sayılır ve başka makinede yapılmalıdır.
- Migration öncesi dağıtım `pg_dump`'ı bu kararla **değişmedi.** Restore point'e ve yalnız çekirdek
  tablo dökümüne geçiş V4.1 Faz 2 (migration güvenliği) işidir.
