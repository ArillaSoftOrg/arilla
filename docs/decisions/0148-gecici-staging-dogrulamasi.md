# 0148 — Geçici staging doğrulaması: üretim yedeğinden ağsız yan instance

**Tarih:** 23 Ekim 2026
**Durum:** Önerildi (PR). VPS'te hiçbir şey çalıştırılmadı; yalnız sentetik prova yapıldı.
**İlişkili:** 0109 (VPS, faz 4 "VPS'te staging" uygulanmadı), 0110 (yedekleme/geri yükleme),
0137 (PR risk kapısı), 0147 (ilk ihtiyaç: migration 0100)

## Sorun

Kural "Migration'lar staging'de çalışmadan production'a gitmez" (`docs/ops.md`,
`docs/architecture.md`, `packages/db/migrations/README.md`) ama kalıcı staging ortamı yok.
`main`e birleşme `deploy.yml` ile doğrudan `vps-production`a gidiyor ve bekleyen migration'ı
orada çalıştırıyor. CI'daki migration işleri temiz/sentetik veritabanında koşar; gerçek verinin
kısıtlarını, boyutunu ve geçmişini görmez. `pg-restore-test` gerçek yedeği açar ama migration
çalıştırmaz ve kopyayı siler.

## Karar

1. Kalıcı staging kurulana kadar, migration içeren her PR birleşmeden önce
   `infra/vps/bin/pg-staging-verify` ile doğrulanır: üretimin **en son yedeği** boş geçici dizine
   geri yüklenir, kopyada test edilen PR'ın migrate imajıyla `migrate.ts` + `verify-schema.ts`
   çalıştırılır, özet rapor yazılır, kopya silinir. Bu, kuraldaki "staging"in geçici karşılığıdır.
2. Geri yükleme yeni kod yazmaz: mevcut `restore` servisi + `restore-inner.sh` (CI'da sınanan
   `pg-restore-test` yolu; arşiv kapalı, `pg_amcheck`).
3. **Yalıtım teknik olarak zorunlu**, belgeye bırakılmaz:
   - Yan PostgreSQL ve migrate konteyneri `--network none`. Konteynerde yalnız kendi
     loopback arayüzü vardır; üretim veritabanına (ya da başka herhangi bir yere) TCP ile
     ulaşmak mümkün değildir.
   - Bağlantı yalnız geçici dizindeki unix soketi; adres betikte sabit (`localhost` + `host=/sock`).
     Migrate konteynerine üretim env dosyası/sırrı verilmez.
   - `pg_hba` yalnız `local all all trust`, `listen_addresses=''`, `archive_mode=off`
     (kopya yedek deposuna WAL göndermez). Bu ayarlar migration'dan önce SORGUYLA doğrulanır;
     tutmazsa betik durur.
   - Disk ön kontrolü yedek bilgisinden (`pgbackrest info`); üretim veritabanına hiç bağlanılmaz.
   - İmaj çekilmez (`--pull=never`); imaj üretimden eskiyse ya da bekleyen migration yoksa durur.
4. **Veri sunucudan çıkmaz:** rapor yalnız özet (dosya adları, sayılar, özetler, yalıtım kanıtı).
   Ham çıktılar ve PostgreSQL kaydı geçici dizinde kalır, silinir; konteynerler `--log-driver none`.
5. Prova: `test-staging-verify.sh` sentetik veriyle aynı betiği uçtan uca sınar; CI işi
   "staging verify rehearsal" her PR'da koşar.

## Reddedilen alternatifler

- **Kalıcı staging VPS'i**: doğru hedef (0109 faz 4) ama yeni sunucu, sırlar, feed alt kümesi ve
  bakım gerektirir; bu karar onu engellemez, yerini tutar.
- **CI migration işini staging saymak**: gerçek veriyle çalışmaz; kural bunu kastetmiyor.
- **Yedeği geliştirici makinesinde açmak**: üretim kişisel verisi sunucudan çıkar (KVKK).
- **Üretim veritabanında `BEGIN; … ROLLBACK;` denemesi**: üretimde kilit alır ve yanlış bir
  adımın bedeli üretimdir.
