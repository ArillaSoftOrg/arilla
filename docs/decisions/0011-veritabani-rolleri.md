# 0011 — Ayrı uygulama rolü, motorda append-only, izlenen default partition

**Tarih:** 2026-09 · **Durum:** kabul edildi

## Karar

Üç bağlı karar:

1. **İki veritabanı rolü.** `arilla` şemanın sahibidir (migration, partition
   üretimi, tohum verisi). `arilla_app` uygulama rolüdür; `apps/*` ve
   `services/ingest` yalnızca onunla bağlanır. `arilla_app` superuser değildir.
2. **Append-only kuralı veritabanı motorunda zorlanır.** `arilla_app` rolünün
   `price_point` ve `variant_stock_event` üzerinde UPDATE, DELETE ve TRUNCATE
   yetkisi yoktur; yalnızca SELECT ve INSERT vardır.
3. **`price_point_default` eklenir, ama izlenir.** Aralık dışı satır INSERT'i
   patlatmaz, default partition'a düşer. Default'un dolu olması kritik
   uyarıdır ve satırlar elle doğru partition'a taşınır.

## Gerekçe

**Rol ayrımı zorunluluktan doğdu.** `CLAUDE.md` 4. kural `price_point` için
"UPDATE veya DELETE yazan kod reddedilir" diyor, ama bunu yalnızca kod
incelemesi koruyordu. Kuralı veritabanına taşımak istediğimizde ortaya çıktı
ki `docker-compose.yml` içindeki `arilla` rolü superuser'dır ve superuser
bütün ACL kontrollerini atlar — ona REVOKE uygulamak hiçbir şey yapmaz.
Kuralın işlemesi için superuser olmayan ayrı bir rol şarttı.

**Neden motorda:** kod incelemesi insanı gerektirir ve yorulur. Yetki
kontrolü yorulmaz. Yanlışlıkla yazılan bir `UPDATE price_point`, bir ORM
kolaylığı ya da bir acil müdahale sırasında atılan tek satır artık üretimde
42501 ile durur. Fiyat geçmişi geriye dönük üretilemeyen tek varlıktır
(`docs/ops.md`); korumasının insan dikkatinden güçlü olması gerekir.

**Cascade bozulmaz.** `variant_stock_event`in FK'sı `ON DELETE CASCADE`.
Referans aksiyonları geçerli kullanıcının değil, referans veren tablonun
sahibinin yetkisiyle yürütülür; `offer_variant` silindiğinde cascade çalışmaya
devam eder. Yalnızca doğrudan DELETE engellenir — istenen tam olarak bu.

**Default partition tercihi bir denge.** Default'suz kurulumda eksik partition
INSERT'i patlatır: hata gürültülüdür ama o koşunun fiyat noktaları kaybolur.
Default'lu kurulumda satır kaybolmaz, fakat hata sessizleşme riski taşır.
İkisinin de kötü tarafını almamak için default eklendi **ve** boş olması
`docs/ops.md` izleme tablosuna kritik eşik olarak yazıldı. Default bir çöp
kutusu değil, alarmı olan bir ağdır.

**Partition betiği 3 ay ileri üretir.** Tek bir kaçırılmış cron koşusunun veri
yolunu etkilememesi için. Aylık üretimde 1 ay ileri, tek kaçırmada sınıra
dayanmak demektir.

## Reddedilen alternatifler

- **Yalnızca uygulama kodunda append-only.** Bugünkü durum. Tek koruması kod
  incelemesi; acil müdahalede ve ORM üzerinden atlanabiliyor.
- **Trigger ile engelleme.** `BEFORE UPDATE ... RAISE EXCEPTION` her satırda
  çalışır ve INSERT hacmi yüksek bir tabloda bedeli var. Yetki kontrolü
  planlama anında bir kez yapılır ve daha erken hata verir.
- **Rolü depoda parolayla oluşturmak.** Migration'a parola yazmak
  `docs/ops.md`'nin "depoya asla anahtar yazılmaz" kuralını çiğnerdi. Rol
  parolasız ve NOLOGIN oluşturulur; parolayı `db:bootstrap-role` betiği ortam
  değişkeninden verir.
- **Default partition'sız devam etmek.** `migrations/README.md`'nin ilk hali
  bunu öngörüyordu. Fiyat geçmişinin geri üretilemez olması, kaybı gürültülü
  hataya tercih etmeyi haklı çıkarmadı.
- **pg_partman.** Bir eklenti daha, bir bağımlılık daha. Aylık partition üretimi
  otuz satırlık bir betik; eklenti sınıra gelindiğinde konuşulur.

## Sonucu

- `.env.example` iki bağlantı dizesi taşır: `DATABASE_URL` (uygulama, `arilla_app`)
  ve `DATABASE_URL_OWNER` (migration ve bakım). Uygulama ikincisini asla okumaz.
- `pnpm db:verify` her koşuda kuralı kanıtlar: `arilla_app` superuser değil mi,
  UPDATE/DELETE 42501 veriyor mu, SELECT/INSERT çalışıyor mu.
- Yeni partition'lar `scripts/partitions.ts` tarafından açılır ve aynı REVOKE
  onlara da uygulanır.
