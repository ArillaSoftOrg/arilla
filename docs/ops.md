# İşletim

## Ortamlar

| Ortam | Ne çalışır | Veri |
| --- | --- | --- |
| `local` | Docker Compose: Postgres, Redis, MinIO | Örnek feed, birkaç bin ürün |
| `staging` | Üretimin küçük kopyası | Gerçek feed'lerin alt kümesi |
| `production` | Web Vercel'de, worker ayrı barındırmada | Tam katalog |
| `vps` (geçiş, karar 0109) | Hostinger KVM 4: Caddy, web, Postgres, Redis, worker, cron (Docker Compose) | Sıfırdan kurulur; katalog yeniden toplanır |

Migration'lar staging'de çalışmadan production'a gitmez.

Karar 0109: uygulama Vercel/Supabase/Upstash olmadan kendi sunucumuzda da
çalışacak şekilde hazırlanır. Geçiş bitene kadar Vercel production aynen sürer;
iki ortam birbirinin veritabanına ve Redis'ine yazmaz. Ayrıntı: aşağıda
"VPS (Hostinger KVM 4)".

**Worker Vercel'de çalışamaz.** Vercel uzun süren arka plan işlerini
desteklemiyor; feed toplama saatler sürebilir. Python worker için ayrı bir
barındırma gerekir (küçük bir VPS yeterli). "Başta Vercel" ilk günden iki ortam
demektir.

### Link kuyruğu Redis'i (`LINK_REDIS_URL`, karar 0123)

Web `queue:link_resolution` listesine `LINK_REDIS_URL`'deki Redis'e yazar (boşsa
`REDIS_URL`); Python worker `worker.env`'deki `REDIS_URL`'i dinler. **İkisi aynı
sunucuyu göstermelidir**, aksi halde istekler `queued` kalır ve 60 sn sonra zaman
aşımı görünür (worker "healthy" olsa bile). VPS'te yerel Redis kullanılır;
`REDIS_URL` (oran sınırı, bütçe, önbellek) değişmez.

Üretimde etkinleştirme (kod dağıtıldıktan sonra, bakım penceresinde, parola ekrana
basılmadan; geri alınabilir):

```
sudo cp -p /opt/arilla/env/web.env /opt/arilla/env/web.env.bak
sudo sh -c "grep '^REDIS_URL=' /opt/arilla/env/worker.env | sed 's/^REDIS_URL=/LINK_REDIS_URL=/' >> /opt/arilla/env/web.env"
sudo docker compose --env-file /opt/arilla/compose.env -f /opt/arilla/compose.prod.yml up -d web
```

Doğrulama (yalnız host/port/db yazar): web ve worker'da
`new URL(process.env.<DEĞİŞKEN>)` ile `hostname port pathname`; `redis-cli info
commandstats` içinde `cmdstat_lpush` ve `cmdstat_brpop` artışı; `llen
queue:link_resolution` işlendikten sonra 0. Geri alma: `web.env.bak`'ı geri kopyala ve
`up -d web`. Yönetim paneli kuyruk göstergesi de bu Redis'i okur.

### Link worker

`queue:link_resolution` tüketicisi (`python -m collect.link --worker`), Docker
ile paketlenir: `services/ingest/Dockerfile` (Python 3.12, bağımlılıklar
`pyproject.toml`'dan) ve `infra/docker-compose.worker.yml`. Compose dosyası
yerel geliştirme için DEĞİLDİR (yerelde worker doğrudan çalıştırılır).

```bash
docker compose -f infra/docker-compose.worker.yml up -d --build
```

- Gizli değerler `infra/.env.worker`'dan okunur; dosya depoya girmez
  (`.gitignore`: `.env.*`). Adlar: `DATABASE_URL`, `REDIS_URL`,
  `JINA_API_KEY`, `EMBEDDING_COST_MICROS_PER_1K_TOKENS` (isteğe bağlı:
  `JINA_TOKENS_PER_MINUTE`).
- **Kopan Postgres bağlantısı:** worker tek bağlantıyla çalışır; bağlantı
  koparsa süreç `1` ile çıkar, `restart: unless-stopped` yeniden başlatır ve
  yeni bağlantı kurulur. Yarım kalan istek web tarafında ölü sayılır
  (`packages/core/src/discovery/link-resolution.ts`).
- **SIGTERM** (`docker stop`, compose `stop`): süreç `0` ile temiz çıkar; açık
  işlem geri alınır, bağlantı kapanır. `stop_grace_period: 30s`.
- Geçici Redis hataları süreci düşürmez; worker bekleyip yeniden dener.
- **Boş kuyruk:** tek `BRPOP` en fazla 60 sn bekler (`POLL_TIMEOUT_SECONDS`).
  Gecikmeyi etkilemez (bekleme sırasında gelen iş anında döner); yalnızca boş
  kuyrukta Upstash'e giden komut sayısını belirler (~43 bin/ay; 5 sn'de ~520
  bin/ay idi).
- **Ortam dosyası:** `cp infra/.env.worker.example infra/.env.worker`, değerleri
  doldur. `REDIS_URL` üretimde `rediss://` olmalı ve web ile aynı Redis olmalı;
  yoksa/TLS değilse worker `2` koduyla, bağlanmadan çıkar. `JINA_API_KEY` boşsa
  worker metinle çalışır (`image_status=unavailable`); anahtar varken
  `EMBEDDING_COST_MICROS_PER_1K_TOKENS` de doldurulmalıdır (maliyet ölçümü).
- **Otomatik dağıtım YOK:** `main`'e push Vercel'i dağıtır, worker'ı dağıtmaz.
  Worker kodu değişince worker hostunda elle: `git pull`, sonra
  `docker compose -f infra/docker-compose.worker.yml up -d --build`. Önce
  migration (şema değişikliği varsa) uygulanır, sonra worker yeniden kurulur.
- **Sağlık:** worker HTTP endpoint'i SUNMAZ. Kuyruk döngüsü her `BRPOP`
  dönüşünde `WORKER_HEARTBEAT_FILE` (varsayılan `/tmp/link-worker.heartbeat`)
  dosyasına dokunur; imajdaki `HEALTHCHECK` (`python -m collect.link
  --healthcheck`, DB/Redis'e bağlanmaz) dosya 180 sn'den eskiyse `unhealthy`
  yapar. Redis'e ulaşılamazsa dosya yenilenmez, yani takılan worker görünür olur.
  `docker ps` / `docker inspect --format '{{.State.Health.Status}}'` ile bakılır;
  compose `unhealthy` kapsayıcıyı kendiliğinden yeniden başlatmaz: izleme
  `unhealthy`yi uyarıya çevirmeli ya da elle `docker compose restart`.
- **Fiyatsız referans görseli:** fiyatsız sayfanın görseli (varsa) aynı güvenli
  indirme ve `img512-v1` önişlemeyle embed edilir; `image_upload` (ham dosya
  saklanmaz) + `embedding(target_type='query')` yazılır, offer/fiyat/ürün
  yazılmaz. Aynı hash+model için vektör varsa Jina çağrılmaz (`cache_hit`).
  Hata/eksik görselde istek düşmez, arama metinle sürer.
  Saklama: `purge_after` (30 gün) geçince `cleanup-auth` cron'u bu çifti siler
  (`purgeExpiredLinkSourceEmbeddings`, karar 0090): önce
  `link_resolution_request.image_embedding_id` NULL'a çekilir, sonra
  `image_upload` + `embedding` silinir. Aktif sohbet (son mesajı 90 günden genç)
  `payload.link.requestId` ile anıyorsa ya da başka bir `image_upload.embedding_id`
  (hash önbelleğini paylaşan kullanıcı yüklemesi) kullanıyorsa dokunulmaz.
  Silinen kaynağın takip/iyileştirmede görsel sinyali yoktur, arama metne düşer
  (kabul edilen davranış). Cron yanıtı/`job_run` detayında `linkSources`
  (`embeddings`, `uploads`, `detached`, `truncated`, `failed`) yalnızca sayıdır;
  parti tavanı (500 x 20) dolarsa koşu `partial` olur, sonraki gün sürer.
- **Zaman aşımı/hata:** sayfa ve görsel isteklerinin zaman aşımı sabittir
  (`safe_http`: 10 sn, bağlantı 5 sn); bir istek hata verirse yalnızca o satır `failed` olur, worker
  sonraki mesaja geçer. Yalnızca kopan Postgres bağlantısı süreci `1` ile
  düşürür.

### Link çözümleme: Vercel Queues (karar 0107) — varsayılan kapalı

VPS'siz alternatif. `LINK_QUEUE_BACKEND=vercel` iken web, Redis yerine Vercel
Queues `link-resolution` topic'ine yalnızca `{"request_id"}` bırakır; aynı Vercel
projesindeki özel Python abonesi (`services/ingest/collect/link/subscriber.py`,
`pyproject.toml` `[[tool.vercel.subscribers]]`) tetiklenir ve **aynı**
`resolve_claimed` mantığını çalıştırır. Bayrak yokken/`redis` iken hiçbir şey
değişmez; yukarıdaki Redis worker'ı geri alma yoludur.

Davranış: abone `max_concurrency=2`, `max_attempts=3`, ilk yeniden deneme 15 sn
(15/30/60). Sitenin durumu (404, robots, SSRF engeli, 429) kalıcı sonuçtur,
yeniden denenmez. Altyapı hatasında yeniden denenir; son teslimatta satır
`failed`/`unexpected` olur (Vercel Queues'ta ölü mektup kuyruğu yoktur). Jina
token bütçesi örnek başına `JINA_TOKENS_PER_MINUTE / 2`'dir. Yönetim panelindeki
"Link çözümleme kuyruğu" bu arka uçta son 2 dakikadaki `queued` satırları sayar.

Etkinleştirme sırası (Vercel panelinde; **önizleme dağıtımında doğrula**, sonra production):

1. Proje **Root Directory**'sini `apps/web`'den repo köküne al (Settings → Build and
   Deployment). Bu, Vercel Services (Beta) için gereklidir ve web derlemesini etkiler.
2. Repo köküne `vercel.json` ekle (repo kökündeki `vercel.json`:
   `services.web` = `apps/web`, `services.link` = `services/ingest`; kök dizin
   değişince `apps/web/vercel.json`'daki `crons` için karşılık bulunmalı).
3. Production, Preview ve Development'ta `DATABASE_URL`'i Supabase **Transaction
   pooler**'a (6543) ayarla; Python bu bağlantıyı hazır sorgusuz (`prepare_threshold=None`) kurar.
   Abonenin ihtiyaç duyduğu değişkenler: `DATABASE_URL`, `JINA_API_KEY`,
   `EMBEDDING_COST_MICROS_PER_1K_TOKENS`, isteğe bağlı `JINA_TOKENS_PER_MINUTE`.
   `REDIS_URL` abone için gerekmez.
4. Yalnızca **Preview** ortamında `LINK_QUEUE_BACKEND=vercel` ver. `LINK_SEARCH_PUBLIC`
   kapalı olduğundan `/ara/link` "Yakında" gösterir; kuyruğu önizlemede yalnızca sohbetteki
   link yolu (`CHAT_DISCOVERY_ENABLED` + `CHAT_LINK_ENABLED`, **yalnızca Preview'da**) tetikler.
   ADR 0107 "Doğrulanmamış noktalar" listesini tek tek işaretle: derleme, abone kaydı,
   `maxDuration`, `crons`, günlüklerde `cozumlendi`/`cozumlenemedi` satırları.
5. Production'a ancak önizleme temizse; sorun olursa `LINK_QUEUE_BACKEND=redis` + worker.

## VPS (Hostinger KVM 4) — karar 0109

Bu bölüm VPS yolunun işletim bilgisidir: faz 1 (imaj, sağlık, ortam) ve faz 2
(Compose yığını, Caddy, PostgreSQL/Redis ayarları, zamanlayıcı, gizli değer yapısı).
GHCR hattı, yedekleme ve otomatik dağıtım sonraki fazlardır (0109 "Fazlar").

### İmajlar

Bağlam her zaman repo kökü (pnpm workspace):

```bash
# Web (varsayılan hedef = runner). APP_URL ve GA4_MEASUREMENT_ID sır DEĞİLDİR,
# derlemeye gömülür (robots.txt/canonical ve CSP derlemede üretilir).
docker build -f apps/web/Dockerfile --build-arg APP_URL=https://<alan-adi> \
  [--build-arg GA4_MEASUREMENT_ID=G-XXXXXXXXXX] -t arilla-web .

# Migration/rol/bölüm betikleri (yalnızca packages/db; dağıtımda bir kez çalışır)
docker build -f apps/web/Dockerfile --target migrate -t arilla-migrate .
```

- `APP_URL` olmadan derleme durur. `DEPLOY_ENV=production` derlemede de üretim
  kapılarını açar: `APP_URL` https ve localhost dışı olmak zorundadır.
- Gizli değer imaja girmez: kök `.dockerignore` `.env*`, `.vercel`, anahtar
  dosyalarını (`*.pem`, `*.p8`), `.git` ve `node_modules`'u dışarıda tutar;
  `next.config.ts` kök `.env`'i derleme sırasında kendisi okuduğu için bu kural
  kritiktir. Çalışma zamanı değerleri konteynere `env_file` ile verilir.
- Çalışma imajı non-root (`node`, uid 1000) çalışır. Next önbelleği
  `/app/apps/web/.next/cache` yazılabilir olmalıdır (kök dosya sistemi
  salt-okunur çalıştırılırsa bu yol volume/tmpfs olur).
- Yeni bir workspace paketi eklenirse `apps/web/Dockerfile` içindeki manifest
  `COPY` satırları güncellenir (bağımlılık katmanı yalnızca manifestlere bağlıdır).
- Python imajı değişmez: `services/ingest/Dockerfile`.

### Migration job (temiz veritabanı)

`migrate` imajı sahip kimliğini yalnızca çalışma anında alır; web konteynerinde
`DATABASE_URL_OWNER` **yoktur**. Betikler yerel olmayan hedefe yazmayı reddeder
(`lib.ts`); Compose ağındaki host adı (`postgres`) komutla **aynı satırda**
onaylanır (`.env`'den okunmaz):

```bash
docker run --rm --network <data-agi> \
  -e DATABASE_URL_OWNER=... -e APP_DB_PASSWORD=... -e ARILLA_CONFIRM_REMOTE_DB=postgres \
  arilla-migrate node scripts/migrate.ts            # 0001'den itibaren, sıralı
# ardından aynı bayraklarla:
#   node scripts/bootstrap-app-role.ts   (arilla_app LOGIN + parola)
#   node scripts/partitions.ts           (price_point: bu ay + 3 ay)
#   node scripts/verify-schema.ts        (append-only ve yetki sınaması)
```

- Sıra: `migrate` → `bootstrap-app-role` → `partitions` → `verify-schema`. `seed`
  ÇALIŞTIRILMAZ (katalogu siler). Katalog `services/ingest` ile toplanır.
- PostgreSQL sahip rolü (`POSTGRES_USER`) superuser olmalıdır (0010: append-only
  kuralı `arilla_app`'in superuser olmamasına dayanır).
- Temiz zincir doğrulandı (58 dosya, `pgvector/pgvector:pg16`; CI integration
  işi aynı sırayı koşar).
- `price_point_default` doluluğu izlenir: `partitions.ts --check` günlük çalışmalıdır
  (VPS'te zamanlayıcı konteynerine eklenecek; şu an hiçbir zamanlayıcı bunu çağırmıyor).

### Ortam değişkenleri (VPS)

| Değişken | Anlamı |
| --- | --- |
| `DEPLOY_ENV` | `production`: üretim kapıları (https zorunlu, TLS Redis, HSTS, pazarlama toplu gönderimi, internet arama hukuki onayı). `staging`/boş: açılmaz. Vercel'de gerekmez (`VERCEL_ENV` aynı işi görür). Çalışma imajının varsayılanı `production`'dır. |
| `REDIS_PLAINTEXT_HOSTS` | Virgülle ayrılmış, tam host adı. Üretimde yalnızca bu host'lara düz `redis://` serbesttir (Docker iç ağı, ör. `redis`). Boş = istisna yok. Web (`redis/client.ts`) ve Python worker (`worker_config.py`) aynı değişkeni okur. |
| `DATABASE_POOL_MAX` | VPS'te uzun ömürlü süreç: 10–15 (varsayılan 3 serverless içindir). |
| `APP_URL` | Üretimde zorunlu, https; derleme ve çalışma zamanında. |

`VERCEL`, `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_PROJECT_PRODUCTION_URL` VPS'te
tanımsızdır ve tanımlanmaz (taklit edilmez). `DATABASE_URL` doğrudan PostgreSQL
adresidir (`sslmode` gerekmez, iç ağ); pooler (PgBouncer) şimdilik yok.

### Sağlık uçları

| Uç | Ne sorar | Kim çağırır |
| --- | --- | --- |
| `GET /api/health` | Süreç istek alıyor mu (bağımlılığa dokunmaz) | Docker `HEALTHCHECK`, dış izleme |
| `GET /api/health/ready` | Veritabanı `SELECT 1` + Redis `PING`; 200 / 503 | Dağıtım betiği (iç ağdan) |

- Yanıt yalnızca `{"status":..,"checks":{"database":"ok|fail","redis":"ok|fail"}}`;
  hata metni, adres, sürüm yok. Sonuç 2 sn önbelleklenir, eşzamanlı çağrılar tek
  denetimi paylaşır.
- **Caddy `/api/health/ready`'yi dışarıya açmaz** (veritabanı yükü ve bileşen
  durumu bilgisi). Dış izleme yalnızca `/api/health` kullanır.
- Redis düşerse `ready` 503 olur ama `/api/health` 200 kalır ve konteyner yeniden
  başlatılmaz (doğrulandı).

### Üretim yığını (faz 2): `infra/compose.prod.yml`

`infra/` içeriği VPS'te **`/opt/arilla/`** altına kopyalanır (`compose.prod.yml` ve
`vps/`); dağıtım betiği (faz 6) bunu her sürümde günceller. Hiçbir komut yerelden
VPS'e bağlanmaz; aşağıdakiler VPS'te `deploy` kullanıcısıyla çalıştırılır.

| Servis | İmaj | Ağlar | Not |
| --- | --- | --- | --- |
| `caddy` | `caddy:2.10-alpine` | public, edge | Tek açık kapı (80/443/udp 443). Let's Encrypt otomatik. |
| `web` | `arilla-web:<tag>` | edge, data, egress | salt-okunur kök FS, `cap_drop ALL`, 3 GB, 2 CPU |
| `worker` | `arilla-ingest:<tag>` | data, egress | `LINK_QUEUE_BACKEND=redis` kuyruğunu tüketir, 1 GB, 1.5 CPU |
| `cron` | `arilla-cron:<tag>` | data | supercronic; yalnız HTTP + `CRON_SECRET`, DB kimliği yok |
| `postgres` | `pgvector/pgvector:0.8.1-pg16` | data | 6 GB, `infra/vps/postgres/postgresql.conf` |
| `redis` | `redis:7.4-alpine` | data | AOF + parola + `noeviction`, 768 MB |
| `migrate` | `arilla-migrate:<tag>` | data | `profiles: ["ops"]`; `up -d` BAŞLATMAZ; sahip kimliği yalnız burada |

**Ağlar.** `data` ve `edge` `internal: true` (internete çıkış yok). Yalnız `caddy`
`public` ağındadır ve port yayınlar; `web` ve `worker` dışarı çıkış için `egress`
ağındadır (Gemini, Jina, R2, SMTP, hedef siteler) ama port yayınlamaz. `postgres`
ve `redis` yalnız `data` ağındadır, **`ports:` yoktur** ve olmayacak; yerel erişim
gerekirse `docker compose exec postgres psql -U arilla arilla`. Duman testi bunu
(`docker inspect` ile HostPort, internete çıkış, host portları) her çalıştırmada
doğrular.

**Kalıcı volume'lar:** `postgres_data`, `redis_data`, `caddy_data` (TLS sertifikaları —
silinirse Let's Encrypt sınırına dikkat), `caddy_config`, `web_next_cache`, `pg_run` (postgres
unix soketi, `backup` ile paylaşılır), `backup_spool`. PostgreSQL yedeği: "Yedekleme ve geri
yükleme (karar 0110)". `redis_data` (kuyruk/kota sayaçları) VPS dışına yedeklenmez; kaybı
tolere edilir.

**Healthcheck / yeniden başlatma / günlük / kaynak.** Her servisin healthcheck'i, `restart:
unless-stopped` politikası, `json-file` günlük dönüşümü (10 MB × 3), bellek (`mem_limit` =
`memswap_limit`, swap yok), `pids_limit` ve gerektiğinde `cpus` sınırı vardır. Toplam
bellek sınırı ≈ 11 GB; ~5 GB işletim sistemi, disk önbelleği ve yedek için kalır. Değerler
başlangıçtır; gerçek yük altında `docker stats` ile ayarlanır.

**PostgreSQL** (`vps/postgres/postgresql.conf`): `shared_buffers=2GB`,
`effective_cache_size=7GB`, `work_mem=16MB`, `maintenance_work_mem=512MB`,
`max_connections=60`, `wal_compression`, `max_wal_size=4GB`, `random_page_cost=1.1`,
`wal_level=replica` (faz 5 WAL arşivi için hazır), saat dilimi UTC, `scram-sha-256`,
`idle_in_transaction_session_timeout=60s`. İlk kurulumda veri sağlama toplamları açılır
(`--data-checksums`, sonradan eklenemez). Hata günlüklerine sorgu metni yazılmaz
(`log_min_error_statement=panic`; yavaş sorgu günlüğü 500 ms).

**PostgreSQL istemci kimlik doğrulaması (`vps/postgres/pg_hba.conf`).** Kurallar repoda
sürümlenir ve `hba_file` ile `/etc/postgresql/pg_hba.conf` (salt-okunur bağ) olarak yüklenir;
`initdb`'nin veri dizinine yazdığı `pg_hba.conf` **kullanılmaz**. (Bu, ilk kurulumda
yalnızca-localhost kalan VPS hatasının kalıcı çözümüdür: sonuç artık entrypoint'in dosyaya ne
eklediğine bağlı değildir ve mevcut volume'larda da aynı davranır.) Kurallar: konteyner içi
unix soketi `trust` (yalnız `docker exec`), loopback `scram-sha-256`, ve `arilla` veritabanına
yalnızca `arilla`/`arilla_app` rolleri için **özel (RFC 1918) adres blokları** (`10.0.0.0/8`,
`172.16.0.0/12`, `192.168.0.0/16`) üzerinden `scram-sha-256`. Eşleşmeyen her bağlantı reddedilir.
Docker alt ağı **sabitlenmez**: Docker `data` ağına varsayılan havuzdan alt ağ verir ve daemon
ayarı ya da ağın yeniden oluşturulması bunu değiştirebilir; bloklar bu yüzden alt ağın kendisini
değil özel adres uzayını kapsar. Güvence üç yerdedir: (1) `infra/vps/bin/check-pg-hba.py` gerçek
`data` alt ağının kuralca kapsandığını doğrular (`db-bootstrap.sh` ön kontrolü ve duman testi);
(2) postgres healthcheck'i konteynerin kendi ağ adresine TCP + SCRAM ile bağlanır, yani alt ağ
kapsanmazsa `healthy` olmaz; (3) `/api/health/ready` veritabanı bağlantısı koparsa 503 verir.
Daemon `default-address-pools` özel blokların DIŞINA ayarlanırsa `pg_hba.conf`'a ilgili blok
eklenir ve `docker compose restart postgres` yapılır. Port yayını hâlâ yoktur; `pg_hba`
ikinci katmandır, birincisi ağ yalıtımıdır.

**Redis** (`vps/redis/redis.conf`): `appendonly yes` (`everysec`), `maxmemory 512mb`,
`noeviction`, `FLUSHALL/FLUSHDB/DEBUG/KEYS` kapalı. Konteyner **root olmadan** doğrudan
`redis` kullanıcısıyla (`user: "999:1000"`, resmî imajla aynı uid/gid) başlar; ek yetki (`cap_add`)
yoktur. Resmî entrypoint root olarak başlayıp `chown`/`gosu` yaptığı için `cap_drop: ALL`
altında (root'un `DAC_OVERRIDE`'ı yok) ilk başlatmadan sonra 0700 `appendonlydir`'i gezemiyor ve
`find: ./appendonlydir: Permission denied` ile yeniden başlatma döngüsüne giriyordu; doğrudan
`redis-server` bunu ortadan kaldırır. Parola `redis.conf`'ta ve komut satırında YOKTUR:
başlarken `REDIS_PASSWORD`'dan tmpfs'teki 0600 dosyaya yazılır, `redis.conf` bunu `include`
eder, sonra `exec` ile `redis-server` PID 1 olur (`ps`/`docker top` çıktısında görünmez).

**Mevcut bir VPS kurulumunu güncelleme** (Redis restart döngüsü / yalnızca-localhost
`pg_hba.conf` düzeltmesi; veri ve volume'lar silinmez):

1. Güncel `infra/` içeriğini `/opt/arilla/` altına kopyala (`compose.prod.yml`, `vps/`).
2. Geçici Redis override'ını (`user: "999:1000"`) kaldır; artık temel dosyadadır.
3. `docker compose --env-file /opt/arilla/compose.env -f /opt/arilla/compose.prod.yml up -d postgres redis`
   (konfigürasyon değiştiği için ikisi yeniden oluşturulur; `redis_data` ve `postgres_data`
   volume'ları aynen kalır, AOF/RDB ve veritabanı korunur).
4. Elle eklenmiş `PGDATA/pg_hba.conf` satırları artık kullanılmaz; silmek isteğe bağlıdır.
5. Doğrula: `docker compose ... ps` (ikisi `healthy`), ve
   `python3 infra/vps/bin/check-pg-hba.py /opt/arilla/vps/postgres/pg_hba.conf
   $(docker network inspect arilla_data --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}')`.

**Caddy** (`vps/Caddyfile`): `request_body max_size 6MB` + `Content-Length` > 6 MB ise
yukarı akışa gitmeden 413 (parçalı gönderimde gövde okunurken kesilir, istemci 400 görür).
`/api/health/ready` ve `/api/cron/*` **dışarıya 404** (büyük/küçük harf, çift slash,
yüzde kodu, sondaki slash, sorgu dizesi denendi). Erişim günlüğünde sorgu dizesi, çerez,
başlıklar ve istemci adresi **yoktur** (yalnız yöntem, host, yol, durum, boyut, süre).
**www → apex:** `www.<alan-adı>` kalıcı (301) `https://<alan-adı>`'a yönlenir, yol ve sorgu korunur
(`ARILLA_WWW_ADDRESS` / `ARILLA_CANONICAL_ORIGIN`, varsayılan `ARILLA_SITE_ADDRESS`'ten türetilir; mevcut
`compose.env`'e ekleme gerekmez). Yönlendirme dışında içerik sunmaz (`/api/health/ready` ve `/api/cron/*`
www üzerinden de önce apex'e gider, orada 404). `www` için ACME sertifikası ayrıca otomatik alınır;
DNS'te `www` kaydı VPS'e çözümlenmelidir. Erişim günlüğü filtresi iki sitede de ortaktır (`privacy_log`).
VPS'te Caddyfile'a elle eklenmiş aynı blok bu sürümle değiştirilir (davranış aynı).
Guvenilmeyen `X-Forwarded-For` ezilir (tek eleman = bağlanan adres; `client-ip.ts`
doğru çalışır); `X-Real-IP` yukarı akışa iletilmez. Güvenlik başlıkları uygulamadan gelir.

**Zamanlayıcı (`cron` + systemd).** HTTP işleri `cron` konteynerindedir
(`vps/cron/crontab`, UTC; `apps/web/vercel.json` ile birebir, duman testi karşılaştırır):

| Zaman | İş |
| --- | --- |
| `0 0 * * *` | `generate-discovery-slots` |
| `30 0 * * *` | `interpret-queries` |
| `45 23 * * *` | `refresh-product-aggregates` |
| `30 3 * * *` | `cleanup-auth` |
| `*/15 * * * *` | `trigger-alerts`, `marketing-campaigns` (GitHub Actions'taki 15 dk işlerin yerine) |

`price_point` bölüm üretimi ve `price_point_default` kontrolü **systemd zamanlayıcıları**ndadır
(`vps/systemd/arilla-partitions{,-check}.{service,timer}`): sahip kimliği gerektiren tek iş
bu olduğu için uzun ömürlü `cron` konteynerine DB sahibi parolası VERİLMEZ; işler gecici
`migrate` konteynerini çalıştırır. Kurulum: unit'leri `/etc/systemd/system/` altına kopyala,
`systemctl enable --now arilla-partitions.timer arilla-partitions-check.timer`. Kontrol dolu
çıkarsa unit `failed` olur (`systemctl --failed`); bildirim bağı faz 5'te (izleme).

**Toplu Python işleri** de systemd zamanlayıcılarındadır (`vps/systemd/arilla-catalog-pipeline`,
`arilla-pricing-{fx,enqueue,verify}`). Her biri `feeds` servisini geçici çalıştırır
(`--profile feeds run --rm -e JOB_RUN_TRIGGER=cron feeds python -m ...`; `worker.env`, ingest
rolü, sahip kimliği yok). Yalnızca ücretsiz işler; `enrich` (Jina) ve `feeds sync-due` (büyük
indirme, disk/WAL yükü) bilerek elle kalır.

| Zaman (UTC) | Unit | İş |
| --- | --- | --- |
| Her gün 02:30 | `arilla-catalog-pipeline` | `resolve --limit 5000`, ardından `similarity --edges` |
| Her gün 04:00 | `arilla-pricing-enqueue` | `pricing enqueue --older-than-hours 24` |
| Saatlik | `arilla-pricing-verify` | `pricing verify --limit 50` |
| Her gün 13:30 | `arilla-pricing-fx` | `pricing fx` (TCMB, 16:30 TR) |

Kurulum (root, tek satır): `sudo /opt/arilla/vps/bin/batch-timers install`. Durum:
`batch-timers status`; durdurma: `batch-timers disable`. Başarısız koşu `arilla-alert@` ile
bildirilir ve `/yonetim/islemler` "zamanında çalışmadı" uyarısı üretir. Elle tek koşu:
`sudo systemctl start arilla-catalog-pipeline.service`.

**Gizli değerler** yalnızca VPS'te, `/opt/arilla/env/*.env` (`0640`, `root:deploy`). Her servis
yalnızca kendi dosyasını alır: `web.env` (uygulama), `worker.env`, `cron.env` (yalnız
`CRON_SECRET`), `migrate.env` (**sahip kimliği yalnız burada**), `postgres.env`, `redis.env`;
`compose.env` sır içermez. İlk kurulum:

```bash
sudo infra/vps/bin/init-secrets.sh --domain alan-adi.com   # rastgele sırlar; ekrana yazmaz
sudoedit /opt/arilla/env/web.env                           # elle: OAuth, SMTP, Jina, Gemini, R2...
infra/vps/bin/db-bootstrap.sh                              # migrate, rol, bölümler, verify-schema
docker compose --env-file /opt/arilla/compose.env -f /opt/arilla/compose.prod.yml up -d
```

`init-secrets.sh` var olan dosyanın üstüne yazmaz ve altı dosyanın kısmen var olmasına izin
vermez (tutarsız parola). Parola döndürmek veri kaybettirmesin diye elle ve planlı yapılır.

**Yerel doğrulama.** `infra/vps/bin/smoke-local.sh` yığını atılabilir sırlarla (`arilla-smoke`
projesi, yalnız `127.0.0.1`) ayağa kaldırır: temiz DB'de migration zinciri, servisler arası
bağlantı, ağ yalıtımı, Caddy kapıları, gövde limiti, cron işleri, Postgres/Redis ayarları ve
sızıntı kontrolleri. CI'da `compose-stack` işi aynısını koşar.

### Imaj yayını (faz 3): `.github/workflows/build-push.yml`

| İmaj | Kaynak | Hedef |
| --- | --- | --- |
| `ghcr.io/arillasoftorg/arilla-web` | `apps/web/Dockerfile` | `runner` |
| `ghcr.io/arillasoftorg/arilla-migrate` | `apps/web/Dockerfile` | `migrate` |
| `ghcr.io/arillasoftorg/arilla-ingest` | `services/ingest/Dockerfile` | — |
| `ghcr.io/arillasoftorg/arilla-cron` | `infra/vps/cron/Dockerfile` | — |

- **Tetikleyiciler:** `pull_request` (yalnız derle + tara + doğrula, **yayınlamaz**, `packages`
  izni yok); `workflow_run` (`ci` main'de **başarılı** bitince yayınlar); `workflow_dispatch`
  (yalnız main, aynı commit'i yeniden yayınlar).
- **Kapı (`gate`):** yayın yalnız main'e push'un başarılı `ci` koşusu için yapılır ve commit
  üzerinde `private-keys`, `compose stack`, `docker images`, `web build` kontrolleri başarılı
  olmalıdır (biri başarısızsa yayın yok).
- **Etiket:** `sha-<40 haneli commit>`. **Değişmezdir:** etiket GHCR'da zaten varsa üstüne
  yazılmaz, mevcut digest kullanılır. `latest`/`main` gibi hareketli etiket yoktur.
- **Tarama (iki kez):** (1) yayından ÖNCE yerelde yüklenen imaj; (2) yayından SONRA GHCR'daki
  digest. İkisi de `verify-image.sh` (kimlik/anahtar dosyası, PEM özel anahtar içeriği, dolu
  sır ENV'i, root değil) ve **Trivy** (`vuln,secret`, HIGH/CRITICAL, düzeltmesi olanlar,
  `exit-code 1`) çalıştırır. Başarısız kontrol yayını durdurur; atlanmaz. İstisna yalnızca
  `.trivyignore` içinde gerekçe + sahip + bitiş tarihiyle yazılır (şu an boş).
- **İzinler:** workflow düzeyinde `permissions: {}`; `gate` `contents:read` + `checks:read`;
  `scan`/`manifest` `contents:read`; yalnız `publish` `packages:write`. Üçüncü taraf action'lar
  tam commit sha'sıyla sabitli. Üretim sırrı kullanılmaz; VPS'e bağlanılmaz.
- **Önbellek:** `type=gha` katman önbelleği (imaj başına kapsam); PR'lar main'in önbelleğini
  okur, yalnız main yazar. BuildKit `--mount=type=cache` (pnpm deposu) koşular arası taşınmaz.
- **`ARILLA_APP_URL` (depo DEĞİŞKENİ, sır değil):** `web` imajı bu adresi derlemeye gömer
  (robots/canonical). **Tanımlı değilse `web` imajı yayınlanmaz** (yer tutucu adresle yalnızca
  doğrulanır, uyarı verir), manifest `complete: false` olur ve dağıtım onu reddeder.
  Tanımlamak: GitHub → Settings → Secrets and variables → Actions → Variables
  → `ARILLA_APP_URL=https://<alan-adı>` (isteğe bağlı `GA4_MEASUREMENT_ID`).
- **Çıktı:** her yayında `release-manifest.json` (artifact, 90 gün + iş özeti):
  `{sha, tag, images: {web|migrate|ingest|cron: {image, tag, digest}}, complete}`.

**Sürüm sabitleme ve geri alma (`infra/vps/bin/release.py`, VPS'te):**

```bash
infra/vps/bin/release.py apply release-manifest.json --dir /opt/arilla   # ARILLA_TAG + digest'ler compose.env'e
infra/vps/bin/release.py rollback --dir /opt/arilla                       # bir önceki sürüme dön
infra/vps/bin/release.py current|list --dir /opt/arilla
```

`apply` önce manifesti doğrular (`complete`, 40 haneli sha, `tag == sha-<sha>`, dört imaj,
`sha256:` digest'leri, `ghcr.io/<sahip>/arilla-<ad>`); geçersizse HİÇBİR dosya değişmez. Uygulanan
her manifest `releases/<sha>.json` olarak saklanır ve **değişmezdir**. Compose imajı
`ad:sha-…@sha256:…` olarak çözer; digest etiketten önceliklidir, yani etiket sonradan başka bir
imajı gösterse bile çalışan şey sabittir. Geri alma, önceki manifestin digest'lerini yeniden
yazar (docker çağırmaz; çekme/yeniden başlatma dağıtım betiğinin işidir, faz 6).

**Boyut/süre notları.** Çalışma ve migrate imajları `debian:bookworm-slim` + yalnız `node`
ikilisi üzerindedir (resmî `node` imajındaki npm/yarn/corepack ve bunların bağımlılık zafiyetleri
yok; ~40 MB küçük). Yerel ölçüm (açılmış): web ≈ 460 MB, migrate ≈ 318 MB, ingest ≈ 257 MB,
cron ≈ 45 MB; web'in `next` + sharp/libvips'i ≈ 35 MB, Node ≈ 120 MB, taban ≈ 75 MB'tır.
Taban imajlara `apt-get/apk upgrade` uygulanır (yayınlanmış güvenlik yamaları). `supercronic`
hazır ikili yerine güncel Go ile kaynaktan derlenir (hazır ikili eski Go standart
kütüphanesiyle HIGH Trivy bulgusu veriyordu).

### Otomatik dağıtım (faz 6): `.github/workflows/deploy.yml` + `infra/vps/bin/arilla-deploy`

```
push main → ci ✔ → build-push ✔ (imajlar + release-manifest) → deploy.yml
   plan  (salt okunur): manifest + sha main'in ucu mu + zorunlu kontroller + imajlar GHCR'da digest ile var mı
   deploy (environment vps-production): ssh deploy@VPS "deploy <sha>" < release-manifest.json
        └─ VPS: deploy-gate (izin listesi) → sudo → arilla-deploy (root)
```

**Güvenlik modeli.**
- GitHub Actions yalnızca **kısıtlı bir SSH anahtarı** taşır: `authorized_keys` satırı
  `restrict,command="/opt/arilla/bin/deploy-gate"`. Anahtar kabuk, port yönlendirme, pty ya da başka komut
  açamaz; `deploy-gate` yalnızca `deploy <40 haneli sha>` (manifest stdin), `rollback`, `status` kabul eder.
- `deploy` kullanıcısı **docker grubunda değildir** ve genel sudo'su yoktur. `/etc/sudoers.d/arilla-deploy`
  yalnızca `/opt/arilla/bin/arilla-deploy {deploy <sha>|rollback|status}` komutuna parolasız izin verir.
  `arilla-deploy` ve `deploy-gate` **root'a aittir**, deploy kullanıcısı yazamaz.
- Altyapı dosyaları (`compose.prod.yml`, `Caddyfile`, ...) istemciden **gelmez**: motor GitHub'dan `<sha>`
  için alır ve commit'in **main'de olmasını** şart koşar. İmajlar manifestteki digest ile çekilir;
  `org.opencontainers.image.revision` etiketi sha ile eşleşmezse reddedilir. Yani anahtarı ele geçiren biri
  en fazla main'deki bir commit'i yeniden dağıtabilir, rastgele konteyner/yapılandırma çalıştıramaz.
- Production sırları GitHub'a girmez (`/opt/arilla/env/*.env` yalnızca VPS'te). Dağıtım çıktısı ve günlükler
  (`/opt/arilla/logs/deploy-*.log`, `0600`, root) sır içermez.

**Ne yapar (sırayla).** Kilit (aynı anda tek dağıtım) → manifest doğrulama (`release.py validate`: `complete`,
sha, `ghcr.io/arillasoftorg/` öneki) → kaynak getir (sha main'de mi) → **ön kontroller** (yeni compose
geçerli mi, yeni Caddyfile `caddy validate` ile, `pg_hba.conf` Docker ağını kapsıyor mu) → imajları digest ile
çek + sha etiketini doğrula → **yedek** (`backups/deploy-*`) → dosyaları kur + `release.py apply` →
**bekleyen migration varsa** önce `pg_dump` (`backups/pre-migrate-*.dump`, ≥3 GB boş disk şartı), sonra
`migrate` + `verify-schema` → değişen servisleri sırayla yeniden oluştur (`web` → `worker` → `cron` →
`caddy`; her biri `healthy`, web ayrıca `/api/health/ready` 200) → tüm servisler healthy + internetten
`/api/health` 200 ve `/api/health/ready` 404.

**Geri alma.** Yedek noktasından sonra herhangi bir adım başarısızsa motor **otomatik** geri alır: `compose.prod.yml`,
`vps/`, `compose.env`, `releases/` işaretçileri geri yüklenir, yeniden oluşturulan servisler eski yapılandırmayla
tekrar başlatılır ve doğrulanır (çıkış kodu 1, `DEPLOY_RESULT=failed rollback=ok`). Geri alma da başarısız olursa
çıkış kodu 3 ve `rollback=FAILED`: elle müdahale gerekir (yedek yolu çıktıda). **Veritabanı migration'ları geri
alınmaz** (CLAUDE.md #14 gereği geriye uyumludur; eski kod yeni şemayla çalışır); gerekirse `pre-migrate-*.dump`
ile elle dönülür. Elle geri alma: `ssh ... rollback` (bir önceki sürüm; manifest + altyapı paketi `releases/`
altında saklanır) ya da `workflow_dispatch` (`build_run_id` + `allow_older`).

**Dokunulmayanlar.** `postgres` ve `redis` otomatik yeniden başlatılmaz ve volume'ları asla silinmez; yapılandırmaları
değişirse uyarı verilir ("uygun bir anda elle `up -d --no-deps postgres`"). Env dosyaları (`/opt/arilla/env`) ve
`compose.env`'in `release.py`'nin yönettiği satırlar dışındaki içeriği korunur.

**Kesinti.** Tek `web` kopyası olduğu için her dağıtımda `web` yeniden oluşturulur: birkaç ila onlarca saniye Caddy
502 verir (sıfır kesinti için ikinci kopya + sıralı güncelleme gerekir; kapsam dışı). `worker` kuyruğu Redis'te
beklediği için iş kaybolmaz.

**Elle kurulum (bir kez) — VPS (root):**

```bash
# 1) Gerekli araçlar: git python3 curl tar (apt install) ve docker compose
# 2) Motoru kur (depo herkese açık; kurulum kopyası geçicidir)
git clone --depth 1 https://github.com/ArillaSoftOrg/arilla.git /tmp/arilla-src
sudo /tmp/arilla-src/infra/vps/bin/install-deploy.sh            # /opt/arilla/bin + /etc/sudoers.d/arilla-deploy (visudo ile doğrulanır)
# 3) GitHub Actions için ANAHTAR (çalışma bilgisayarınızda): ssh-keygen -t ed25519 -N "" -f arilla-actions
#    Genel anahtarı deploy kullanıcısına KISITLI olarak ekleyin (/home/deploy/.ssh/authorized_keys, tek satır):
#    restrict,command="/opt/arilla/bin/deploy-gate" ssh-ed25519 AAAA... github-actions
# 4) GHCR girişi (paketler private): PAT (read:packages) ile ROOT için
echo "<PAT>" | sudo docker login ghcr.io -u <kullanıcı> --password-stdin
# 5) Dağıtım çalıştığını doğruladıktan SONRA deploy'u docker grubundan çıkar (artık gerekmez)
sudo gpasswd -d deploy docker
```

**Elle kurulum — GitHub** (Settings → Environments → **New environment** `vps-production`; *Deployment branches*:
yalnızca `main`; isteğe bağlı *Required reviewers* = elle onay):
- Secret `VPS_SSH_PRIVATE_KEY` = adım 3'te üretilen özel anahtar (dosyanın tamamı).
- Secret `VPS_SSH_KNOWN_HOSTS` = sunucu anahtarı satırı. Çalışma bilgisayarında `ssh-keyscan -t ed25519 187.7.77.163`
  çıktısı **sunucuda** `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` parmak iziyle karşılaştırılarak alınır
  (ilk bağlantıda kör güven yok: `StrictHostKeyChecking=yes`).
- Variable `VPS_HOST` = `187.7.77.163`, Variable `VPS_USER` = `deploy` (yazılmazsa `deploy`).
- Repo variable `ARILLA_APP_URL` zaten tanımlı (dış doğrulama için de kullanılır).
Bu üçü eksikse `deploy` işi **yeşil kalır ve "Dağıtım atlandı" uyarısı verir**. Kurulum doğrulaması (yerel
bilgisayardan): `ssh -i arilla-actions deploy@187.7.77.163 status` çalışır; `ssh ... bash` ve benzerleri
`izin verilmeyen komut` (126) ile reddedilir.

**Yerel test.** `infra/vps/bin/test-deploy.sh` (CI `compose-stack` işinde de koşar): yerel registry, sentetik
depo, iyi/kötü sürümler; güvenlik kapıları, başarılı dağıtım, **sağlık geçmeyen sürümde otomatik geri alma**,
bekleyen migration + `pg_dump`, Caddyfile değişimi, idempotent tekrar, es zamanlı dağıtım kilidi, elle geri
alma, `deploy-gate` izin listesi ve günlükte sır yokluğu. `infra/vps/bin/test-ssh-gate.sh` (CI `deploy ssh gate`
işi) **gerçek `sshd` + `sudo`** ile VPS yetki zincirini sınar (tek kullanımlık Ubuntu 24.04 konteyneri):
`install-deploy.sh` → sudoers (`visudo`) → `restrict,command=` → `deploy-gate` → `sudo` → motor; izin verilen 3
komut kök olarak ve doğru argümanla ulaşır, 15 izin dışı komut/pty/port yönlendirme reddedilir, `deploy` motoru,
kapıyı ve sudoers'i değiştiremez, docker grubunda değildir.

**VPS'e geçmeden önce** (hâlâ yapılmadı): bkz. PR açıklaması / `docs/decisions/0109`
"Faz 2 sonrası kontrol listesi".

## Sağlayıcı bağımsızlığı

Vercel'e özgü hiçbir hizmete kilitlenilmez. Taşınabilir muadiller kullanılır:
Redis için Upstash, obje deposu için S3 uyumlu servis, veritabanı için standart
Postgres. AWS'ye geçiş bir bağlantı dizesi değişikliğine inmelidir.

## Gizli anahtarlar

- Depoya asla anahtar yazılmaz. `.env.example` yalnızca anahtar adlarını içerir.
- Üretim anahtarları barındırma sağlayıcısının gizli anahtar deposunda durur.
- Model sağlayıcı anahtarları yalnızca sunucu tarafında kullanılır, istemciye
  hiçbir koşulda gönderilmez.
- Anahtar sızarsa: iptal, yenile, `api_usage` tablosundan anormal kullanım
  kontrolü.
- Özel anahtar dosyaları (Apple `.p8`, `.pem`, `.p12`, SSH anahtarı) depo
  klasöründe TUTULMAZ; depo dışında (ör. `~/.secrets/`) durur, değer ortam
  değişkenine yapıştırılır. `.gitignore` bu adları yok sayar ve
  `pnpm check:secrets` (CI: `security-checks`) izlenen ya da sahnelenmiş bir
  anahtar dosyası/PEM başlığı görürse başarısız olur (karar 0050). Anahtar bir
  kez bile commit'lenip push'landıysa geçmişten silmek yetmez: döndürülür.

## Ortam değişkenleri

Sözleşmenin tek kaynağı `.env.example`; her anahtar orada dört gruptan
birindedir ve okuyan dosya yanında yazar:

| Grup | Anlamı | Anahtarlar |
| --- | --- | --- |
| `REQUIRED_PRODUCTION` | Vercel production'da tanımlı olmalı | `APP_URL`*, `DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`, `JINA_API_KEY`, `CRON_SECRET` |
| `OPTIONAL_PRODUCTION` | Boşsa kod varsayılanı | `DEPLOY_ENV` (VPS'te `production`, karar 0109), `REDIS_PLAINTEXT_HOSTS` (karar 0109), `SMTP_SECURE`, `DATABASE_POOL_MAX`, `AUTH_TOKEN_TTL_MINUTES`, `SESSION_TTL_DAYS`, `FREE_SEARCHES_BEFORE_LOGIN`, `AI_SEARCH_DAILY_LIMIT`, `EMBEDDING_COST_MICROS_PER_1K_TOKENS`, `MATCH_AUTO_ACCEPT_THRESHOLD`, `MATCH_QUEUE_THRESHOLD` (yalnızca Python), `HOMEPAGE_DEMO_CONTENT`, `MARKETING_EMAIL_FROM` (pazarlama gönderimi için üretimde zorunlu), `MARKETING_EMAIL_ENABLED`, `MARKETING_EMAIL_REPLY_TO`, `MARKETING_EMAIL_BATCH_SIZE`, `MARKETING_EMAIL_SEND_INTERVAL_MS`, `MARKETING_EMAIL_TIME_BUDGET_MS`, `MARKETING_EMAIL_MAX_ATTEMPTS` (karar 0048), `GEMINI_REALTIME_ENABLED` (karar 0062; boş = kapalı), `LLM_COST_TRY_PER_USD` (karar 0082; boş = Gemini maliyeti fiyatlanmaz) |
| `DEVELOPMENT_ONLY` | Üretimde tanımlanmaz | `EMBEDDING_FAKE_CLIENT` (production'da reddedilir) |
| `TOOLING_ONLY` | Uygulama okumaz | `DATABASE_URL_OWNER` (Vercel'de **tanımlanmaz**), `APP_DB_PASSWORD`, `SEED_IMAGE_BASE_URL`; GitHub Actions secret'ları `ALERT_CRON_URL`, `MARKETING_CRON_URL`, `CRON_SECRET`; Vercel ayarı `ENABLE_EXPERIMENTAL_COREPACK=1` |

\* `APP_URL` boşsa Vercel'in verdiği `VERCEL_PROJECT_PRODUCTION_URL`
kullanılır (`https://` eklenir). `VERCEL_ENV=production` iken sonuç https ve
localhost dışı olmak zorundadır; hiçbir değer çözülmezse hata fırlatılır —
Vercel production'da localhost canonical üretilemez. Yerel `next build` /
`next start` (VERCEL_ENV yok) `http://localhost` kabul eder. Kodda hiçbir alan
adı gömülü değildir.

`VERCEL_ENV`, `VERCEL_PROJECT_PRODUCTION_URL` ve `NODE_ENV` sistem
değişkenleridir; elle ayarlanmaz. Vercel'de `DATABASE_URL` Supabase transaction
pooler adresidir (port 6543).

## Veritabanı erişim yüzeyi (Supabase)

Supabase yalnızca Postgres barındırıyor. **Supabase Auth, Data API
(PostgREST), Realtime ve Storage kullanılmıyor.** Uygulama veritabanına
yalnızca sunucudan, `arilla_app` rolüyle bağlanır. Yetki
`requireCapability` ve `assertCapability` ile uygulanır; RLS bu modelin
parçası değildir (0049).

Risk şurada: Supabase projesinde Data API açıksa, `public` şemadaki
tablolar `anon` ve `authenticated` rolleriyle HTTP üzerinden erişilebilir
olabilir. Bunu engelleyen RLS de yoktur. Her ortam için bir kez kontrol
edilir; şema veya Supabase ayarı değişince tekrarlanır.

1. **Panel:** Project Settings → Data API. Data API kapalı olmalı ya da
   açık şemalar listesinde `public` bulunmamalı.
2. **Yetki sorgusu** (salt okunur, sahip rolüyle):
   ```sql
   SELECT grantee, table_name, privilege_type
     FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND grantee IN ('anon', 'authenticated');
   ```
   Sonuç boş olmalı. **0042 (karar 0057) ile bu adım migration'a taşındı:**
   `pnpm db:migrate` yetkileri geri alır ve migration rolünün varsayılan
   yetkilerini kapatır; roller olmayan yerel/CI veritabanlarında hiçbir şey
   yapmaz. Aşağıdaki SQL yalnızca referanstır (migration'ın eşdeğeri):
   ```sql
   REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
   REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
   REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;
   ALTER DEFAULT PRIVILEGES IN SCHEMA public
       REVOKE ALL ON TABLES FROM anon, authenticated;
   ```
   Yapılan işlem tarihiyle bu bölüme not edilir.
3. **İstemciye sızma kontrolü:** `NEXT_PUBLIC_` önekli hiçbir değişken
   veritabanı adresi, Supabase anahtarı (`anon` / `service_role`) ya da
   başka bir gizli değer taşımaz. Kod tabanında Supabase istemci
   kütüphanesi ve service role anahtarı yoktur; yeni bir bağımlılık bunu
   değiştiriyorsa önce karar dosyası yazılır.

Son kontrol:
- **Kod tarafı (madde 3, 2026-10-03):** `@supabase/*` bağımlılığı yok,
  `service_role` anahtarı yok, `NEXT_PUBLIC_` önekli değişken yok; veritabanı
  adresi yalnızca sunucu kodunda okunuyor.
- **Panel ve yetki sorgusu (1-2, 2026-10-03):** Data API production'da
  **açık** ve `public` şemasını sunuyordu; 58 tablonun hepsinde `anon` /
  `authenticated` tam yetkiliydi (publishable anahtarla `/rest/v1/feedback`
  200 döndü). 0042 production'a uygulandı; yetki sorgusu boş, aynı probe
  yetki reddi döner. Data API açık kalır (kullanılmıyor, erişimi yok).
- **Kalan:** `supabase_admin`'in `public` için varsayılan yetkileri hâlâ
  `anon`/`authenticated`'e verir; `postgres` bu role üye olmadığı için
  migration düzeltemez. Bu yalnızca panelden eklenti/obje oluşturulursa
  etkilidir — panelden `public`'e obje eklendiyse yetki sorgusu (madde 2)
  tekrar çalıştırılır. `service_role` yetkileri bilerek korunur (gizli
  anahtar, kodda yok).

## Kullanıcı aktivitesi migration'ları (0036, 0037, 0038) — production

Karar 0049. Üçü de yalnızca ekleme yapar (yeni tablo, nullable kolon,
CHECK genişletme, indeks) ve mevcut satırları yeniden yazmaz. Backfill
yoktur: eski hesaplar için özet satırı ilk olayda açılır.

1. Production'ın migration seviyesini doğrula:
   `SELECT filename FROM schema_migration ORDER BY filename DESC LIMIT 5;`
   0034 ve 0035 uygulanmış olmalı. Değilse önce onlar.
2. Önce staging'de: `pnpm db:migrate && pnpm db:verify`. `db:verify`
   `auth_event`/`user_activity_event` UPDATE'inin engellendiğini ve
   `query_norm` güncellemesinin izinli olduğunu sınar.
3. Production'da aynı iki komut, onaylı bir pencerede. `DATABASE_URL_OWNER`
   yerel değilse `db:migrate` (ve `db:bootstrap-role`, `db:partitions`)
   hedefin makine adını ister: komutun başına
   `ARILLA_CONFIRM_REMOTE_DB=<hedef makine adı>` yazılır (aynı komutta, yalnızca
   gerçek ortamdan okunur, `.env`'den okunmaz; yanlış ya da genel değer
   kabul edilmez). `db:verify` ve `db:partitions --check` salt okunurdur,
   onay istemez. Tablolar küçük;
   0036'nın `app_user_created_idx` ve 0038'in trigram indeksleri tablo büyükse önce elle
   `CREATE INDEX CONCURRENTLY` ile açılır (migration `IF NOT EXISTS` ile
   boş geçer, 0030 deseni).
4. Kod dağıtımı migration'dan **sonra** yapılır: yeni kod yeni tablolara
   yazar.
5. Geri alma: kod geri alınır. Yeni tablolar boşta kalır, eski kod onları
   okumaz. DROP gerekiyorsa ayrı bir migration ile yapılır (CLAUDE.md
   kural 14).

**Yerel test uyarısı:** kök `.env` uzak veritabanını gösterebilir.
Entegrasyon testleri, `db:migrate`, `db:verify` ve `seed` komutları
`DATABASE_URL` ve `DATABASE_URL_OWNER` açıkça yerel Docker Postgres'e
verilerek çalıştırılır. Testler arasında yerel Redis'teki `ratelimit:*`
anahtarları birikirse giriş testleri oran sınırına takılır; yalnızca yerel
Redis'te temizlenir.

## Yedekleme ve geri yükleme (karar 0110)

**Fiyat geçmişi geriye dönük üretilemez.** Kaybedilirse savunulabilirliğin
tamamı kaybedilir. Bu yüzden yedekleme isteğe bağlı bir konu değildir.
**Test edilmemiş yedek yedek değildir.**

**Durum:** Kod hazır, CI'da uçtan uca sınanıyor (`backup + PITR restore` işi).
**Üretimde ETKİN DEĞİL.** Aşağıdaki aktivasyon yapılana kadar VPS dışında yedek yoktur.

### Politika

| | |
| --- | --- |
| Araç | pgBackRest 2.59 (`infra/vps/postgres/Dockerfile`), depo Cloudflare R2, istemci tarafı AES-256 |
| Tam yedek | Haftalık, Pazar 01:30 UTC (`arilla-backup-full.timer`) |
| Fark yedeği | Pazartesi–Cumartesi 01:30 UTC (`arilla-backup-diff.timer`) |
| WAL arşivi | Sürekli; `archive_timeout=300` sn (düşük trafikte RPO ≤ ~5 dk) |
| Saklama | 4 tam yedek (~4 hafta PITR penceresi) + aradaki fark yedekleri ve WAL |
| Depo doğrulaması | Haftalık `pgbackrest verify` (Çarşamba 02:30 UTC) |
| Geri yükleme provası | Aylık, ayın ilk Pazar'ı 03:30 UTC (`pg-restore-test`, izole) |
| Alarm | `arilla-healthcheck.timer` (5 dk) + yedek/prova birimlerinde `OnFailure` |
| Ürün görselleri | R2 medya bucket'ı; ayrı yedek kapsamı (bu bölüm değil) |

### Mimari (kısa)

`postgres` → (WAL, karşılıklı TLS, `data` ağı) → `backup` (pgBackRest TLS sunucusu) → R2.

- postgres konteyneri internete çıkmaz ve R2 anahtarlarını görmez.
- `backup` konteyneri veri dizinini salt-okunur bağlar ve unix soketini paylaşır.
- `restore` konteyneri yalnız `egress` ağındadır: üretim veritabanına erişemez.

Yapılandırma `/opt/arilla/backup/{pg,repo}` altındadır. Dağıtım bu dizine dokunmaz.

### Cloudflare R2 kurulumu (bir kez, panelden)

1. **Bucket oluştur.** R2 → *Create bucket*:
   - Ad önerisi: `manicepte-pg-backup`.
   - **Yalnız yedek için**; medya bucket'ı kullanılmaz.
   - Konum: *Automatic* ya da AB yurisdiksiyonu. AB seçilirse `backup.env`'de `R2_JURISDICTION=eu`
     yapılır. Yurisdiksiyon sonradan değiştirilemez; KVKK değerlendirmesine göre seçin.
   - Public access: **kapalı** (varsayılan). Custom domain bağlanmaz.
2. **API token.** R2 → *Manage R2 API Tokens* → *Create API token*:
   - Permission: **Object Read & Write**.
   - Specify bucket(s): **yalnız** bu bucket.
   - TTL: tercihe göre. Süreli seçilirse yenileme takvime yazılır.
   - Çıkan **Access Key ID** ve **Secret Access Key** yalnız bir kez gösterilir: doğrudan
     `backup.env`'e yazın.
   - Not: R2'de "silmesiz yazma" izni yok. Token sızarsa yedekler silinebilir.
   - Admin token **kullanmayın.**
3. **Hesap kimliği.** R2 → Overview → *Account ID* (32 hane).
4. **Şifreleme parolası.**
   - Üretin: `openssl rand -base64 48`.
   - **Önce parola yöneticisine kaydedin.** Kaybolursa yedekler açılamaz.
5. **İsteğe bağlı, sonra:** Bucket lock (silme koruması).
   - pgBackRest `backup.info`/`archive.info` dosyalarını yerinde yeniden yazdığı için bucket'ın
     tamamına uygulanmaz.
   - Prefix'e göre kural, gerçek R2'de test edilmeden açılmaz (karar 0110).

### Aktivasyon (VPS, root, PLANLI PENCERE — postgres ~10–60 sn yeniden başlar)

0. **Ön koşul:** Bu değişiklik main'de ve dağıtılmış olmalı. `/opt/arilla/vps/bin/pg-backup*`
   dosyaları var. Dağıtım günlüğünde beklenen uyarı: "postgres yapılandırması değişti ama
   OTOMATİK yeniden başlatılmaz".
1. **İmajı al.**
   - `build-postgres` iş akışı main'de çalışınca iş özetinde
     `ghcr.io/arillasoftorg/arilla-postgres@sha256:...` görünür.
   - Gerekirse Actions → build-postgres → *Run workflow* (main).
2. **Değerleri doldur.**
   ```bash
   sudo install -m 0640 -o root -g deploy /opt/arilla/vps/env/backup.env.example /opt/arilla/env/backup.env
   sudoedit /opt/arilla/env/backup.env        # R2_ACCOUNT_ID, R2_BACKUP_BUCKET, anahtarlar, PGBACKREST_REPO_CIPHER_PASS
   ```
3. **Ön kontrol.** Servislere dokunmaz:
   - imaj ve PostgreSQL ana sürümü;
   - yapılandırma üretimi;
   - **R2 erişim testi** (`repo-ls`);
   - disk.
   ```bash
   sudo /opt/arilla/vps/bin/pg-backup-activate preflight --image ghcr.io/arillasoftorg/arilla-postgres@sha256:<digest>
   ```
4. **Etkinleştirme.** Onaylı pencerede yapılır.
   - Adımlar: `archive.conf` → postgres yeni imajla yeniden oluşturulur → `backup` başlar →
     `stanza-create` → `check` → **ilk TAM yedek**.
   ```bash
   sudo /opt/arilla/vps/bin/pg-backup-activate activate --image <aynı-digest> --confirm-restart
   ```
5. **Zamanlayıcılar ve alarm.**
   ```bash
   sudo install -m 0640 -o root -g deploy /opt/arilla/vps/env/alert.env.example /opt/arilla/env/alert.env
   sudoedit /opt/arilla/env/alert.env         # HEALTHCHECK_PING_URL (önerilir), ALERT_WEBHOOK_URL
   sudo /opt/arilla/vps/bin/pg-backup-activate install-timers
   ```
6. **İlk geri yükleme provası** (aktivasyonun parçası):
   ```bash
   sudo /opt/arilla/vps/bin/pg-restore-test
   cat /opt/arilla/state/restore-test.json     # ok=true, schema_match=true, rto_s
   ```
7. **Kontrol:** `sudo python3 /opt/arilla/vps/bin/arilla_healthcheck.py` (GENEL: OK).

**Aktivasyonu geri alma** (arşivi kapatır; yedekler ve depo SİLİNMEZ; postgres yeniden başlar):
`sudo /opt/arilla/vps/bin/pg-backup-activate deactivate --confirm-restart`, ardından
`systemctl disable --now 'arilla-backup-*.timer' arilla-restore-test.timer`.

### Günlük işletim

| İş | Komut |
| --- | --- |
| Durum | `sudo /opt/arilla/vps/bin/pg-backup info` |
| Elle yedek | `sudo /opt/arilla/vps/bin/pg-backup full` (ya da `diff`) |
| Arşiv zinciri testi | `sudo /opt/arilla/vps/bin/pg-backup check` |
| Sağlık | `sudo python3 /opt/arilla/vps/bin/arilla_healthcheck.py` |
| Günlükler | `journalctl -u arilla-backup-full -u arilla-backup-diff -u arilla-restore-test` |

Durum dosyaları `/opt/arilla/state/*.json`'dadır; sağlık kontrolü bunları okur.

### Geri yükleme runbook'u

**Kural (V4.1 §6.2):** Üretime yerinde PITR, hedef zamandan sonraki **tüm** yazmaları siler.
Varsayılan yol **yan instance**'tır: veri oradan çıkarılır, üretime ileri-düzeltme ile yazılır.

**A) Yanlış silme / bozuk veri** (üretim çalışıyor). Varsayılan yol budur.
1. Olay zamanını belirleyin (UTC).
2. Yan instance'a, olaydan hemen önceki ana geri yükleyin. Prova betiği dizini sildiği için bu
   adım elle yapılır. Aşağıdaki **şablon prova edilmedi**; aynı restore ve başlatma mantığı
   `pg-restore-test` içinde CI'da sınanıyor:
   ```bash
   sudo mkdir -p /opt/arilla/restore-test/manual && sudo chown 999:999 /opt/arilla/restore-test/manual
   sudo ARILLA_RESTORE_DIR=/opt/arilla/restore-test/manual docker compose --env-file /opt/arilla/compose.env \
     -f /opt/arilla/compose.prod.yml --profile restore run --rm --no-deps --entrypoint bash restore -c '
       pgbackrest --stanza=arilla --pg1-path=/restore/data --archive-mode=off \
         --type=time "--target=2026-10-14 03:00:00+00" --target-action=promote restore &&
       pg_ctl -D /restore/data -l /restore/pg.log -o "-c listen_addresses= -c archive_mode=off -c max_connections=200" start -w &&
       psql -h /var/run/postgresql -U arilla -d arilla -c "\copy (SELECT ...) TO /restore/kurtarilan.csv csv header"; 
       pg_ctl -D /restore/data stop -m fast'
   ```
3. `kurtarilan.csv` incelenir. Üretime yeniden yazma, ileri-düzeltme olarak yapılır (migration ya da
   onaylı tek seferlik betik).
4. Dizini silin: `sudo rm -rf /opt/arilla/restore-test/manual`.

**B) VPS tamamen kayboldu** (felaket). Hedef RTO ilk provada ölçülür (`restore-test.json` → `rto_s`).
1. Yeni VPS → karar 0109 kurulumu (Docker, `install-deploy.sh`, `init-secrets.sh`).
   - **Postgres'i başlatmayın.**
2. `/opt/arilla/env/backup.env`'i aynı değerlerle yazın: R2 bilgileri ve **şifreleme parolası**
   (parola yöneticisinden).
3. `pg-backup-configure` → `compose.env`'e `ARILLA_POSTGRES_IMAGE=<digest>`.
4. **[HENÜZ PROVA EDİLMEDİ — ilk felaket tatbikatında betiğe dönüştürülecek]**
   - Boş `postgres_data` volume'una (sahibi uid 999) `pgbackrest --stanza=arilla --archive-mode=off restore`
     çalıştırılır. Kullanılan imaj ve yapılandırma `restore` servisiyle aynıdır; pg1-path volume köküdür.
   - Önceki sunucu kesin kapalı değilse **arşivi açmayın** (iki sunucu aynı depoya WAL yazmasın).
     Kapalıysa `archive.conf.pending` → `archive.conf`.
5. `up -d postgres` → kurtarma biter → `up -d` → `pg-backup check` → **yeni tam yedek** → DNS.
6. `postgres.env`/`migrate.env` parolaları yeni sunucuda yeniden üretildiyse:
   - `bootstrap-app-role` ile `arilla_app` parolası güncellenir.
   - Geri yüklenen veritabanındaki rol parolaları eski sunucudakiyle aynıdır; env dosyalarını eski
     değerlerle doldurmak en kısa yoldur (parola yöneticisi).

**C) Üretime yerinde zaman noktasına dönüş.**
- Yalnız A yolu mümkün değilse, kayıp penceresi yazılı olarak ve **açık onayla** yapılır.
- Adımlar B.4–B.5 ile aynıdır, ama önce mevcut `postgres_data`'nın bir kopyası alınır (silinmez).

### Alarmlar

| Kontrol | Uyarı | Kritik |
| --- | --- | --- |
| Disk (`/opt/arilla`, `/var/lib/docker`) | ≥ %70 | ≥ %80 |
| Bekleyen WAL (`pg_ls_archive_statusdir`) | ≥ 4 dosya | ≥ 16 dosya ya da 15 dk bekleyen |
| Son yedek | — | > 30 sa |
| Son tam yedek | — | > 8 gün |
| Geri yükleme provası | yok ya da > 35 gün | son prova başarısız |
| PG bağlantı | ≥ %80 | ≥ %90 |
| Konteyner / systemd | — | sağlıksız konteyner, başarısız `arilla-*` birimi |

`HEALTHCHECK_PING_URL` tanımlıysa her turda ping atılır (kritikte `/fail`). VPS düşerse ping
kesilir ve dış servis alarm verir. İkisi de boşsa alarmlar yalnız journald'dadır. **Bu yetersizdir.**

## İzleme

Veritabanından okunabilen eşikler `/yonetim/islemler` ekranındadır (yalnızca
yönetici; docs/decisions/0041). Harici uyarı üretmez; ekran bakıldığında
durumu gösterir.

`/yonetim/islemler` (Sistem sağlığı) her denetimi bir bulgu olarak gösterir:
önem (kritik / uyarı / bilinmiyor / bilgi / sağlıklı), kanıt zamanı, anlamı,
ne yapılacağı ve teşhis sayfası (karar 0055). Denetim çalışmazsa durum
"Bilinmiyor"dur, sağlıklı sayılmaz. Genel bakıştaki "Şimdi dikkat
isteyenler" aynı bulguların kritik/uyarı/bilinmiyor olanlarıdır (moderatör
yalnızca mağaza, boru hattı ve eşleştirme kuyruğu bulgularını görür).

İş koşuları `job_run`'a yazılır (karar 0052/0055) ve `/yonetim/islemler/isler`
sayfasında listelenir: Python işleri (`collect`, `collect_bootstrap`,
`resolve`, `enrich`, `similarity*`, `link_refresh`; dry-run ve sahte istemci
yazmaz) ve cron uçları (`discovery_slots`, `cleanup_auth`, `trigger_alerts`,
`marketing_campaigns`). 2 saatten uzun "sürüyor" kalan koşu takılıdır (süreç
öldü); günlük cron 30 saat, 15 dakikalık cron 2 saat koşu bırakmazsa
"zamanında çalışmadı" uyarısı çıkar. Koşular 180 gün saklanır
(`cleanup-auth` içinde silinir). Çalıştır/yeniden dene düğmesi yoktur.

"Veri boru hattı" bölümü her aşamanın (toplama, eşleştirme, fiyat özeti,
zenginleştirme, benzerlik kenarları, link çözümleme) durumunu ve elle
çalıştırma komutunu gösterir. Aşamanın iş koşusu varsa "son çalıştı" oradan,
yoksa üretilen verinin zamanından ("son kanıt", karar 0051) okunur. Eşleştirme
ve benzerlik kenarları her gece VPS'te zamanlanmıştır (`arilla-catalog-pipeline`,
yukarıda); toplama ve zenginleştirme elle kalır. "Geride olabilir" (bilgi) görünen
aşama sırayla çalıştırılır. Worker hostunda ücretsiz aşamalar (fiyat özeti, eşleştirme,
benzerlik kenarları) `infra/docker-compose.worker.yml` içindeki `batch`
servisiyle elle çalıştırılır (`docker compose ... run --rm batch ...`);
`up -d` bu servisi başlatmaz, ücretli Jina ve model çağrıları kapalıdır,
üretim veritabanı bilgisi GitHub'a taşınmaz.

Başarısız toplama koşusu (`ingest_run.status = 'failed'`) işlemi geri alır;
0055'ten beri kayıt da oluşturulan/güncellenen/fiyat noktası sayılarını 0
yazar, geri alınan miktar `error_text`'te not olarak durur.

Model maliyeti `api_usage.cost_micros`'tan okunur ve oran
(`EMBEDDING_COST_MICROS_PER_1K_TOKENS`) tanımsızken 0 yazılır. Ekran bu
çağrıları "fiyatlanmamış" sayar ve tutar yerine "Hesaplanmadı" gösterir.
Gerçek maliyet için oran hem Vercel'de hem Python işlerinin ortamında
tanımlanmalı; oran geriye dönük uygulanmaz.

Gemini çağrıları (sohbet, toplu ve anlık sorgu yorumu) karar 0082 ile
`packages/core/src/llm/pricing.ts`'teki sürümlü resmi liste fiyatından
(girdi + çıktı + düşünme token'ı) ve `LLM_COST_TRY_PER_USD` kuruyla
tahmin edilir. Kur tanımsızken, model için fiyat kuralı yokken ya da
sağlayıcı kullanım bilgisi döndürmediğinde (zaman aşımı, ağ hatası) satır 0
yazılır ve "fiyatlanmamış" sayılır. Tutar fatura değildir: gerçek tutar
Google Cloud faturalama dökümündedir. Fiyat değişince eski kurala bitiş
tarihi verilir, yeni kimlikle yeni kural eklenir (resmi sayfa ve doğrulama
günüyle); kural değişikliği geçmiş satırları yeniden fiyatlamaz.

| Ne | Eşik | Aksiyon |
| --- | --- | --- |
| `ingest_run` başarısızlığı | Aynı merchant 2 kez üst üste (tek başarısızlık: bilgi) | Uyarı |
| İş koşusu takılı | 2 saat "sürüyor" | Uyarı |
| Zamanlanmış iş gecikti | Günlük 30 saat, saatlik 3 saat, 15 dk'lık 2 saat | Uyarı |
| Model çağrısı sapması | Son 24 saat > önceki 7 günün günlük ortalaması × 3 (en az 50 çağrı) | Uyarı |
| Link çözümleme kuyruğu (Redis) | 100 üzeri | Uyarı |
| Feed'siz geçen süre | 24 saat | Uyarı |
| Oturum başına AI maliyeti | Belirlenen üst sınır | Acil inceleme |
| Kademe 3'e düşen sorgu oranı | %20 üzeri | Sözlük genişletme işi aç |
| `match_candidate` bekleyen sayısı | 500 üzeri | Kuyruk incelemesi |
| Yanıt süresi (p95) | 1,5 sn | İnceleme |
| Hata oranı | %1 | Uyarı |
| `price_point_default` satır sayısı | 0'dan büyük | **Kritik** — aşağıdaki runbook |
| `embedding` / `generated_content` yetim satırı | 0'dan büyük | **Kritik** — aşağıdaki runbook |

Maliyet uyarısı diğerleri kadar önemlidir. `api_usage` tablosundan günlük
oturum başına maliyet raporu üretilir ve eşiği aşınca bildirim gider.

### Veritabanı sağlık raporu ve sorgu istatistikleri

`pnpm db:health` (sahip rol, salt okunur oturum, uzak veritabanında onaysız çalışır)
beş bölüm raporlar: indekssiz foreign key'ler, başka bir indeksin baş kolonlarıyla
aynı olan gereksiz indeksler, istatistik sıfırlanmasından beri hiç taranmamış
indeksler, ölü satır birikimi ve **en pahalı 20 sorgu** (`pg_stat_statements`).
Sorgu metni normalize biçimdedir (`$1`, `$2`); parametre değeri (arama metni, kimlik)
içermez. Optimizasyon önce ve sonra bu raporla karşılaştırılır. VPS'te migrate
imajıyla: `docker compose --env-file /opt/arilla/compose.env -f /opt/arilla/compose.prod.yml run --rm migrate node scripts/db-health.ts`.

`pg_stat_statements` iki adımda etkinleşir:

1. Migration `0081` eklentiyi ayrı `monitoring` şemasına kurar (uygulama rolü
   okuyamaz). Normal dağıtımla gelir; ön yükleme olmadan da hata vermez.
2. `infra/vps/postgres/postgresql.conf` içindeki `shared_preload_libraries` ancak
   Postgres **yeniden başlatılınca** etkinleşir. Dağıtım dosyayı `/opt/arilla/vps/postgres`
   altına koyar ama Postgres'i yeniden başlatmaz. **Dikkat:** dosya sunucuya ulaştıktan
   sonra plansız her yeniden başlatma (VPS reboot, Docker güncellemesi) yeni ayarı
   yükler; kütüphane yoksa Postgres AÇILMAZ. Bu yüzden merge'den önce 0. adım yapılır.

Aynı yeniden başlatmayla `log_parameter_max_length = 0` de etkinleşir: 500 ms üstü
yavaş sorgu günlüğüne bağlı parametre değerleri yazılmaz (KVKK).

#### Yeniden başlatma prosedürü (planlı pencere, root/deploy kullanıcısı)

`C="docker compose --env-file /opt/arilla/compose.env -f /opt/arilla/compose.prod.yml"`

0. **Ön kontrol (merge'den ÖNCE, kesintisiz):** çalışan imajda kütüphane var mı:
   `$C exec -T postgres ls /usr/lib/postgresql/16/lib/pg_stat_statements.so` (yoksa
   merge etme). Yedekleme etkinse çalışan imaj `arilla-postgres`'tir (aynı taban +
   pgBackRest); kütüphane PostgreSQL paketinin parçasıdır, taban
   `pgvector/pgvector:0.8.1-pg16`'da (16.12) doğrulandı. Kontrol yine çalışan konteynerde yapılır.
1. **Pencere:** 04:00–05:30 UTC. Yedek (01:30), aylık bölüm (02:00), haftalık iş
   (02:30), geri yükleme tatbikatı (03:30, ayın ilk pazarı), aggregate onarımı (23:45)
   ve sorgu yorumu (00:30) bunun dışında. `*/15` cron uçları bir turu kaçırır, sorun değil.
   Elle çalışan ingest işi yok: `$C ps` ve `docker ps --filter name=ingest`.
2. **Dağıtım geldi mi:** `grep pg_stat_statements /opt/arilla/vps/postgres/postgresql.conf`
   ve 0081 uygulandı mı:
   `$C exec -T postgres psql -U arilla -d arilla -Atc "select 1 from schema_migration where filename like '0081%'"`.
3. **Yeniden başlat:** `$C restart postgres`. (`up -d` YETMEZ: bağlanan dosya
   değişince Compose konteyneri yeniden oluşturmaz.) Durdurma sinyali SIGINT (hızlı
   kapanış: açık işlemler geri alınır), `stop_grace_period` sınırı içinde kapanır.
4. **Beklenen kesinti:** kapanış denetim noktası + açılış genelde 5–30 sn, üst sınır
   ~60 sn. Bu sürede web isteklerinin bir kısmı 5xx/zaman aşımı alır, havuz yeniden
   bağlanır; worker/cron yeniden dener. WAL arşivi kesintisiz devam eder.
5. **Doğrulama:**
   - `$C exec -T postgres pg_isready -U arilla` ve `$C ps postgres` → healthy
   - `$C exec -T postgres psql -U arilla -d arilla -Atc "show shared_preload_libraries; show log_parameter_max_length"`
     → `pg_stat_statements`, `0`
   - İç ağdan hazırlık (dışarı kapalı): `$C exec -T web node -e "fetch('http://127.0.0.1:3000/api/health/ready').then(r=>console.log(r.status))"` → 200
   - Birkaç dakika sonra `$C run --rm migrate node scripts/db-health.ts`: "En pahalı
     sorgular" bölümü dolu.
   - `$C logs --since 10m postgres 2>&1 | grep -iE "fatal|error"` boş.
6. **Geri dönüş:** Postgres açılmazsa (`could not access file "pg_stat_statements"`):
   `/opt/arilla/vps/postgres/postgresql.conf` içinde `shared_preload_libraries` ve
   `pg_stat_statements.*` satırlarını `#` ile kapat, `$C up -d --no-deps postgres`
   (konteyner durmuşsa başlatır) ve 5. adımı tekrarla. Sonra depoda aynı geri alma
   commit'i yapılır; aksi halde sonraki dağıtım dosyayı yeniden getirir. Ayar geri
   alınırsa veri kaybı yok; eklenti nesneleri (0081) zararsız kalır.

Sayaçları sıfırlamak (ör. büyük bir değişiklik sonrası temiz ölçüm):
`SELECT monitoring.pg_stat_statements_reset();` (sahip rol).

### Gece toplu işleri: parti ve işlem süresi (Faz 3)

- `python -m similarity`: kenarlar (ürün vektörü SQL'de, 500 ürünlük `LATERAL` kNN
  partileri), fiyat istatistikleri ve özet onarımı (1 000 ürünlük partiler) **parti
  başına commit** eder; uzun işlem, xmin tutma ve geniş satır kilidi yoktur. Aynı anda
  tek kenar koşusu (advisory kilit; ikincisi hata verir). `--dry-run` tek işlemdir,
  sonunda geri alır.
- `--prune` (isteğe bağlı, varsayılan KAPALI): tam koşuda üretilmeyen eski kenarları
  siler. `--limit` ile birlikte etkisizdir.
- Model sürümleri karışmaz: her `model_version` ayrı ortalanır ve karşılaştırılır;
  birden fazla sürüm varsa uyarı yazılır, baskın sürüm en son işlenir.
- Kenar koşusu geçici tabloda ürün başına bir vektör tutar (768 boyut ≈ 3 KB): 1 milyon
  üründe kenar türü başına ~3 GB geçici disk.
- `collect`: kaynak taraması veritabanı işlemi AÇMADAN yapılır (teklifler geçici
  dosyada), yazım tek işlemde 500'lük partilerle. Koşu yine "ya hepsi ya hiç".
- `enrich`: görsel indirmesi ve sağlayıcı çağrısı açık işlem içinde yapılmaz.

### Runbook — `price_point_default` doldu

`price_point_default` **normal durumda boştur.** Dolu olması aylık partition
üretiminin çalışmadığı anlamına gelir; satırlar orada bırakılmaz, doğru
partition'a taşınır. Kontrol: `pnpm db:partitions --check` (dolu ise sıfırdan
farklı çıkış kodu döner, izleme bunu kullanır).

Sıra önemlidir: dolu default varken o ayın partition'ı **oluşturulamaz**,
Postgres "default partition kısıtı ihlal edilirdi" hatası verir.

1. `BEGIN;`
2. `ALTER TABLE price_point DETACH PARTITION price_point_default;`
3. Eksik ayın partition'ını aç: `pnpm db:partitions` (uzak veritabanında
   `ARILLA_CONFIRM_REMOTE_DB=<hedef makine adı>` ile)
4. Satırları geri taşı ve ayrılmış tablodan sil:
   `INSERT INTO price_point SELECT * FROM price_point_default;`
   `DELETE FROM price_point_default;`
5. `ALTER TABLE price_point ATTACH PARTITION price_point_default DEFAULT;`
6. `COMMIT;`

Sonra cron'un neden çalışmadığını bul. Fiyat geçmişi geriye dönük
üretilemez — bu uyarı ertelenmez.

### Runbook — yetim `embedding` / `generated_content` satırı

Bu iki tabloda `target_id` bir foreign key **değildir**: `target_type`'a göre
`offer`, `product` ya da `query` gösterir, bir kolon üç tabloya birden
referans veremez. Yani referans bütünlüğünü Postgres sağlamıyor.

Migration `0014` **silme** yönünü trigger'a bağladı: `offer` veya `product`
satırı silindiğinde ya da tablo `TRUNCATE` edildiğinde bağlı satırlar
temizlenir. Geriye üç yol kalıyor ve bu uyarı onları ölçüyor:

1. **Yazma yönü** — var olmayan bir `target_id` ile INSERT.
2. `ALTER TABLE ... DISABLE TRIGGER` veya `session_replication_role = replica`.
3. `generated_content.target_type` **serbest TEXT**'tir (`embedding`'in aksine
   CHECK kısıtı yok): `'ofer'` yazımı hem trigger'dan hem de naif bir yetim
   sorgusundan kaçar.

Kontrol: `pnpm db:orphans --check` (yetim varsa sıfırdan farklı çıkış kodu
döner, izleme bunu kullanır). `pnpm db:verify` de aynı sorguyu koşar.

1. `pnpm db:orphans` — kaç satır, hangi tabloda, hangi `target_type`.
2. **Satırlar silinir, bırakılmaz.** `price_point_default`'ta satırların
   taşınacağı doğru bir partition vardı; burada taşınacak yer yok — satırın
   işaret ettiği hedef artık mevcut değil.
   `DELETE FROM embedding WHERE target_type = 'offer' AND NOT EXISTS
   (SELECT 1 FROM offer o WHERE o.id = target_id);`
3. Trigger'lar yerinde ve etkin mi:
   `SELECT tgname, tgenabled FROM pg_trigger WHERE tgname LIKE '%_polymorphic_%';`
   `tgenabled` **`O`** olmalı; `D` ise devre dışıdır ve sebebi bulunur.
4. Trigger'lar etkinse arıza **yazma** yönündedir: son `enrich` ya da
   `similarity` koşusunda hangi kodun var olmayan bir `target_id` yazdığını
   bul. `tanimsiz_tur` raporlanıyorsa `target_type` yazımı bozuk demektir.

`target_type = 'query'` yetim **sayılmaz**: şema kullanıcı sorgusu
embedding'ine izin veriyor, karşılık gelen bir tablo yok.

`price_point` uyarısı gibi ertelenmez ve daha sinsidir: kimlikler yeniden
kullanıldığında yetim vektör sessizce **yanlış ürüne** bağlanır. Eksik veri
değil, yanlış veri üretir — B3'te tam olarak bu oldu.

## Hata takibi

Sunucu ve istemci hataları tek bir hata takip servisinde toplanır. Kişisel veri
hata kayıtlarına yazılmaz — özellikle giriş bağlantısı token'ları ve e-posta
adresleri maskelenir.

## Kişisel veri saklama işleri

Süre dolumu elle yapılmaz; günlük cron'larla yürür (`/api/cron/*`,
`CRON_SECRET`). 0036 tablolarında (`auth_event`, `user_activity_event`)
uygulama rolünün UPDATE yetkisi yoktur (tek istisna `query_norm` kolonu),
DELETE yetkisi vardır: temizlik uygulama rolüyle yapılır, SECURITY DEFINER
istisnası (0021) açılmaz. Cron yanıtındaki `retention` alanı silinen ya da
NULL'a çekilen satır sayılarını verir (kişisel veri yok).

| İş | Kapsam | Durum |
| --- | --- | --- |
| `cleanup-auth` | `auth_token`, `phone_login_code`, `session` süresi dolanlar | çalışıyor |
| `purgeExpiredActivity` | `user_activity_event` 180 gün, `query_norm` 90 gün, `auth_event` 1 yıl, `user_consent.ip` 1 yıl | çalışıyor: `cleanup-auth` içinde, ayrı cron yok (0049) |
| `purgeExpiredLinkSourceEmbeddings` | süresi dolmuş, aktif sohbetle ilişkisiz fiyatsız link kaynağı `image_upload` + `query` embedding (30 gün) | çalışıyor: `cleanup-auth` içinde, yalıtılmış adım (0079) |

İşin son koşusu `/yonetim/islemler/isler`'de (`cleanup_auth`) görünür;
süresi geçmiş giriş kaydı birikirse işletim ekranı uyarır (0055). En eski satır süreyi aşmışsa iş çalışmıyor demektir.
Ertelenmez: süresi geçmiş kişisel veri tutmak aydınlatma metnine aykırıdır.

Analitik rızası geri alındığında kullanıcının olaylarının silinmesi cron'a
bırakılmaz; rıza satırıyla aynı işlemde yapılır (0049 §8).

## Sorgu yorumlama (Gemini, çevrimdışı) — hukuken onaylı, anahtar eklenince etkin

**Durum:** kod, 0044 ve 0046 üretimde. Hukuk danışmanı üretimde etkinleştirmeyi
onayladı (m.5/2-f; KVKK m.9 aktarım sözleşmesi imzalandı). `GEMINI_API_KEY`
Vercel'e eklenene kadar Google'a hiçbir metin gitmez (günlük cron koşar ama atlanır).
Anahtar, `/gizlilik` ve `/kvkk-aydinlatma` güncel metinle (6 Ekim 2026)
yayına alındıktan ve docs/kvkk.md "Etkinleştirme kontrol listesi"ndeki açık
kalemler teyit edildikten sonra eklenir. `store: false` aktarımı ya da işlemeyi kaldırmaz;
Google kötüye kullanım tespiti için sınırlı süre kayıt tutabilir.

**Etkinleştirme sırası (birleştirme sonrası):**
1. 6 Ekim 2026 tarihli güncel metin üretimde
   (`/gizlilik`, `/kvkk-aydinlatma`) görülür. İşlemeden ÖNCE.
2. Google projesinde bütçe uyarısı ve kota tanımlanır.
3. Yetki denetimi SQL'i (aşağıda) yeniden çalıştırılır.
4. Vercel Production'a `GEMINI_API_KEY` (hassas, yalnızca Production) eklenir
   ve yeniden dağıtılır; tek başına hiçbir şey tetiklemez.
5. Toplu iş bir kez elle tetiklenir; `job_run`, `api_usage` (en fazla 40),
   `query_interpretation` ve `/yonetim/arama/tani` ("Saklanmış model yorumu")
   kontrol edilir.
6. Birkaç gün elle izleme; zamanlama ayrı bir PR/karardır.
Geri alma: anahtar Vercel'den kaldırılır (toplu iş atlanır); mevcut yorumlar
en fazla 90 günde silinir.

Karar 0059. Uç: `GET /api/cron/interpret-queries`, `Authorization: Bearer
${CRON_SECRET}`. **Günlük Vercel cron:** `apps/web/vercel.json`,
`30 0 * * *` (00:30 UTC, Türkiye saatiyle yaklaşık 03:30). Vercel, proje
ortamında `CRON_SECRET` tanımlıyken isteğe `Authorization: Bearer
${CRON_SECRET}` başlığını kendisi ekler; uç diğer cron'larla aynı kontrolü
kullanır. Plan Hobby ise Vercel günlük cron'u belirtilen saat içinde
herhangi bir dakikada çalıştırabilir. Koşu başına en fazla 20 sorgu, gün
başına en fazla 100 sağlayıcı denemesi (Europe/Istanbul günü) değişmedi; elle
tetikleme de aynı günlük tavana sayılır. Yanıttaki `providerCallsToday` bu
koşunun denemeleri DAHİL günün toplamıdır. Gecikme: `/yonetim/islemler`
`query_interpretation` için 30 saat (diğer günlük cron'larla aynı).
Durdurma: girişi `vercel.json`'dan kaldırıp dağıtmak ya da anahtarı
kaldırmak (koşu atlanır). `/ara` bu ucu çağırmaz.

**`/ara` okuma yolu ve dağıtım sırası.** `/ara`, deterministik netleştirme
ilk turda domain bulamadığında `query_interpretation`'dan (normalize sorgu +
bugünkü taksonomi özeti + bugünkü model sürümü, yalnızca `accepted`) OKUR;
model çağrısı, ağ isteği ya da yazma yoktur. Bu yüzden üretimde sıra:

1. `0044_query_interpretation.sql` uygulanır ve doğrulanır
   (`SELECT count(*) FROM schema_migration` / `to_regclass('public.query_interpretation')`).
2. Kod dağıtılır.

Okuma, tablo yoksa (`42P01`) ya da sorgu hata verirse sessizce deterministik
yola düşer (yalnızca sınıf + SQL kodu loglanır, sorgu metni yok); bu bir
emniyet ağıdır, migration'ın yerine geçmez — tablo yokken her
domain'siz `/ara` isteği bir hata satırı loglar. Okuma yolu için
`GEMINI_API_KEY` GEREKMEZ: anahtar yoksa uç "atlandı" döner, yeni yorum
üretilmez, `/ara` yalnızca tabloda zaten olan (bugün: hiç) satırları kullanır.

- `GEMINI_API_KEY` yoksa sağlayıcı çağrılmaz; yanıt `status: "skipped"`,
  `skippedReason: "missing_api_key"`. Üretimde anahtar yukarıdaki kontrol
  listesi tamamlanmadan tanımlanmaz.
- Koşu başına en fazla 20 sorgu; 35 sn'den sonra yeni sorguya başlanmaz.
  İstemci 10 sn zaman aşımı, en fazla 2 deneme. Aynı anda ikinci koşu
  (`already_running`) atlanır.
- **Günlük maliyet tavanı:** Europe/Istanbul günü başına en fazla 100 sağlayıcı
  HTTP denemesi (`QUERY_INTERPRETATION_DAILY_CALL_CAP`, yeniden denemeler
  dahil; elle tekrarlanan koşuların toplamı). Sayım `api_usage`'tan
  (`operation = 'query_interpretation'`), migration yok. Tavan doluysa koşu
  `skipped` / `daily_cap`; koşu ortasında dolarsa `stopCode = daily_cap`, kalan
  sorgular ertelenir. Google projesindeki bütçe/kota sınırı ayrıca önerilir.
- **Bağlantı dumanı (yalnızca sabit sentetik sorgu):** `GEMINI_SMOKE=1 pnpm
  gemini:smoke`. Gerçek `GeminiClient` ile tam bir HTTP denemesi; veritabanına
  dokunmaz, `search_query_day` ya da kullanıcı sorgusu okumaz, dışarıdan metin
  almaz (argüman verilirse reddeder), `api_usage`'a yazmaz (günlük tavana
  sayılmaz). Üretim ortamı işaretliyse (`VERCEL_ENV`/`NODE_ENV=production`)
  ayrıca `GEMINI_SMOKE_ALLOW_PRODUCTION=1` ister. Çıktı yalnızca durum ve token
  sayısıdır. Çıkış kodu 0/1/2 (geçti/başarısız/reddedildi).
- `/yonetim/arama/tani` "Yorum kaynağı" satırı: kural sözlüğü (deterministik),
  saklanmış model yorumu ya da yok - `/ara` ile aynı salt okunur yol.
- Aday: `search_query_day` son 30 gün, en az 3 arama VE en az 3 farklı gün,
  kişisel veri/kimlik/sır ve özel nitelikli veri bağlamı süzgecinden geçmiş,
  deterministik netleştirmenin domain bulamadığı normalize sorgu.
  Kullanıcı/oturum verisi okunmaz. Gönderilen metin anonim değildir:
  süzgeçler riski azaltır, garanti etmez; 3 farklı gün 3 farklı kişi demek
  değildir.
- Saklama: `query_interpretation` 90 gün (`created_at`). Günlük `cleanup-auth`
  cron'u siler; adım diğer saklama işlerinden yalıtılmıştır (tablo yoksa ya da
  `arilla_app`'in DELETE yetkisi yoksa diğer temizlik sürer, koşu `partial`,
  `detail.queryInterpretations_failed` SQL kodunu taşır).
- **Etkinleştirme ön koşulu (salt okunur, şimdi değil):** üretim çalışma
  rolünün okuma ve 90 günlük temizlik yetkisi doğrulanır; hiçbir yetki bu
  adımda verilmez ya da geri alınmaz, eksikse ayrı ve onaylı bir adımda
  düzeltilir:
  ```sql
  SELECT
    has_table_privilege('arilla_app', 'public.query_interpretation', 'SELECT') AS can_select,
    has_table_privilege('arilla_app', 'public.query_interpretation', 'DELETE') AS can_delete;
  ```
  İkisi de `true` olmalı (toplu iş ayrıca INSERT ister:
  `has_table_privilege('arilla_app', 'public.query_interpretation', 'INSERT')`).
- Sonuç `query_interpretation`'a yazılır (`accepted` / `empty` / `invalid`);
  sağlayıcı hatası satır yazmaz, sonraki koşu yeniden dener. 401/403/4xx ya da
  429'da koşu durur (`stopCode`).
- Her HTTP denemesi `api_usage`'a bir satır (`operation =
  'query_interpretation'`, `units` = toplam token, kimlik NULL, `cost_micros`
  0 — fiyat oranı henüz tanımlı değil, ekran "fiyatlanmamış" sayar).
- Koşu `job_run`'a `query_interpretation` adıyla yazılır; `/yonetim/islemler/isler`
  listesinde görünür. `job_run`'da `skipped` durumu yoktur: atlanan koşu
  `success` + `detail.skipped = true` ve `skippedReason` ile yazılır.
  Ayrıntı yalnızca sayılardır.

### Anlık sorgu yorumu (karar 0062) — bayrak arkasında, kapalı

`GEMINI_REALTIME_ENABLED=true` (ve `GEMINI_API_KEY`) iken `/ara` isteği
içinde Gemini çağrılır: metin süzgeci → saklanan yorum varsa yeniden kullanım
→ günlük anlık tavan (2.000 deneme, Europe/Istanbul günü) → Gemini (2,5 sn,
tek deneme) → doğrulama → `query_interpretation` + `api_usage`
(`operation = 'query_interpretation_realtime'`). Hata ya da tavan aramayı
durdurmaz; plan deterministik yola düşer. Toplu iş ve 100'lük tavanı
değişmez; anlık yol açıkken ikincil öğrenme/kurtarma yoludur.
Kişi başına ek limit (karar 0063): saatte 30 anlık model çağrısı (girişli
hesap ya da IP'nin SHA-256 özeti, Redis `rti:*` anahtarları); önbellek
isabeti sayılmaz, Redis yoksa model çağrılmaz. Ürünlerin üstündeki
"Yapay zekâ yorumu" özeti ikinci çağrı yapmaz; yorum yoksa gösterilmez.

**Açmadan önce:** hukuki yeniden değerlendirme ve `/gizlilik` güncellemesi
(`docs/legal-review/gemini-anlik-yorum-taslak.md`). **Kapatma:** bayrağı
silip yeniden dağıtmak; saklanan yorumlar okunmaya devam eder (0059 yolu).
**İzleme:** günlük anlık deneme sayısı

```sql
SELECT count(*) FROM api_usage
 WHERE operation = 'query_interpretation_realtime'
   AND created_at >= (now() AT TIME ZONE 'Europe/Istanbul')::date AT TIME ZONE 'Europe/Istanbul';
```

## Oran sınırlama ve kazımaya karşı koruma

Siz feed'lerden veri topluyorsunuz; rakip de sizden toplamaya çalışacak.

- Görsel arama: kullanıcı ve IP başına günlük limit. Hem maliyet hem kötüye
  kullanım koruması.
- Ürün API'si: oturum başına oran sınırı
- Fiyat geçmişi: tam seri hiçbir genel uçtan dışarı verilmez, yalnızca
  grafikte gösterilecek örneklenmiş hali döner
- Sıradışı gezinme örüntüsü tespitinde yavaşlatma
- `robots.txt` ve arama motoru botları için ayrı kural

## Besleme keşfi ve senkronizasyonu (karar 0111, 0112)

**Durum:** Kod ve testler hazır. Üretimde zamanlanmış çalışma **yok**.

**Ortam:**
- `ADMITAD_CLIENT_ID` ve `ADMITAD_CLIENT_SECRET`: `worker.env`'e eklenir.
- İsteğe bağlı: `ADMITAD_PROGRAMS` (program filtresi).
- `FEED_STAGING_DIR`: hazırlık dizini.
- `FEED_MAX_BYTES`: disk tavanı, varsayılan 4 GiB.
- `FEED_MIN_FREE_BYTES`: bu sınırın altında indirme durur. Varsayılan 15 GiB;
  PostgreSQL, WAL ve yedek diski korunur.
- `FEED_SAMPLE_BYTES`: örnek kipinde okunan miktar, varsayılan 64 MiB.

| İş | Komut |
| --- | --- |
| Keşif (yeni ya da kaybolan besleme) | `python -m feeds discover` |
| Liste | `python -m feeds list` |
| Bağlama / etkinleştirme | `python -m feeds bind --feed ID --merchant SLUG --activate` |
| Küçük doğrulama (pasifleştirmez) | `python -m feeds sync --feed ID --max-records 2000` |
| Tam senkronizasyon | `python -m feeds sync --feed ID` |
| Etkin ve değişmiş beslemeler | `python -m feeds sync-due` |

**Kurallar:**
- Yeni besleme `discovered` olarak kalır; yönetici bağlamadan senkronize edilmez.
- TRY dışı besleme (AliExpress USD) yalnızca **etkin olmayan** merchant'a bağlanır.
  Yaklaşık TRY gösterimi gelene kadar USD fiyat TL gibi görünemez.
- Kesik, kısmi ya da hatalı besleme (tamlık kapısı) hiçbir offer'ı pasifleştirmez.
- Bir offer şu üç şart birlikte sağlanınca pasifleşir:
  - hiçbir etkin ya da duraklatılmış beslemede kalmamış;
  - 48 saatlik bekleme süresi dolmuş;
  - tavan (%10) aşılmamış.
- Silme yok.

**Ölçüm (14 Ekim 2026, yerel):** AliExpress "10-25$" beslemesi gzip'li hâliyle
yüzlerce MB. İndirme ~0,7–1,1 MB/sn. Tam aktarım öncesi V4.1 §20 aşama kapıları
uygulanır: önce 10 bin, sonra 100 bin kayıt, her aşamada disk, WAL ve yedek ölçümü.

## Production besleme komutları (karar 0114)

Bir kez, root ile: `install -d -o 10001 -g 10001 -m 0750 /opt/arilla/feed-staging`.

Çalıştırma: `cd /opt/arilla && docker compose --env-file compose.env -f compose.prod.yml --profile feeds run --rm feeds python -m feeds <komut>`.

- Besleme dosyası diskteki `/opt/arilla/feed-staging`'e iner; RAM tabanlı `/tmp`'ye inmez.
- Diskte en az 20 GiB boş alan korunur.
- Kaynaklar: 1,5 GB bellek, 1 CPU.

**Ölçümler ve davranış (karar 0114):**
- Darboğaz Admitad dışa aktarma sunucusu.
  - Bağlantı başına ~0,25–0,5 MB/s sıkıştırılmış; ~292 bayt/kayıt.
  - CSV sıkıştırılmadan geliyor (~797 bayt/kayıt); XML gzip daha hızlı.
  - 3 paralel bağlantı toplamda ~2,2 kat hız veriyor.
- `feeds sync-due --parallel-downloads N` (varsayılan 2, en fazla 4).
  - İndirmeler paralel, işleme sırayla yapılır.
  - Her indirme `(boş alan − FEED_MIN_FREE_BYTES) / N` ile sınırlıdır.
- Kesinti ya da çökme sonrası, 24 saat içinde ve kaynak güncellenmemişse inmiş dosya yeniden indirilmez; birleştirilmiş parçalar atlanır.
  - Örnek kipindeki (eksik) dosya tam koşuda kullanılmaz.
- Değişmeyen teklif upsert'e girmez.
  - `ON CONFLICT` koşulu tutmasa da satırı kilitler ve WAL üretir.
  - Satıcı satırı günde en fazla bir kez güncellenir.
  - Üyelik tablosu `fillfactor=70` (0068) ile HOT güncellenir.

## Fiyat doğrulama ve döviz kuru (karar 0113)

**Durum:** VPS'te systemd zamanlayıcılarıyla zamanlanır (`batch-timers install`, yukarıda
"Toplu Python işleri").

| İş | Komut | Sıklık |
| --- | --- | --- |
| TCMB kuru | `python -m pricing fx` | Her gün 13:30 UTC (16:30 TR) |
| Doğrulama isteği ekle | `python -m pricing enqueue --older-than-hours 24` | Her gün 04:00 UTC |
| Doğrula | `python -m pricing verify --limit 50` | Saatlik, düşük hacim |

- Yaklaşık TRY yalnızca kur 4 günden yeniyse gösterilir; kur yoksa dönüşüm yapılmaz.
- İzinli canlı kaynağı olmayan offer'lar (AliExpress) `unsupported` olur; sonuç yazılmaz.
- Admitad tıklaması için `merchant.deeplink_template`'e Admitad hesabında doğrulanan
  biçim girilir (örn. `{affiliate_url}&subid={click_id}`).
- Yönetim: `/yonetim/ingest/beslemeler` (salt okunur).

## Kaynak ilanından katalog (karar 0121)

AliExpress gibi kesin kimliği (GTIN/marka) olmayan kaynakların teklifleri **taslak ürün** olur;
yayın ayrı ve açık bir karardır. Hiçbir adım `offer` fiyatına/para birimine yazmaz, hiçbiri
zamanlanmış değildir (yalnızca elle). `python -m resolve` AliExpress'e dokunmaz (TRY dışı
teklifleri atlar, 0112) ve taslakları aday saymaz.

```bash
cd services/ingest
# 0. YALNIZCA OKUR. Kaç teklif ürün olmaya uygun, neden elenenler? (uretimde guvenli)
python -m catalog_build audit  --merchant aliexpress
# 1. Aktarım: taslak ürün. Parti + kontrol noktası tek işlemde; Ctrl+C / kill sonrası aynı komut sürer.
python -m catalog_build build  --merchant aliexpress --batch 5000 --sleep-ms 100
python -m catalog_build status --merchant aliexpress
# 2. Kalite kapısı: draft/held/ready. Yurt dışı teklif karar bekler (draft kalır, satır yazılmaz).
python -m catalog_build gate
# 3. Yayın (AÇIK onay): ready -> published, offer.product_id bağlanır, özet yenilenir.
python -m catalog_build publish --limit 500 --merchant aliexpress --confirm
#    TRY dışı ürün için ayrıca: CATALOG_PUBLISH_FOREIGN_APPROVED=true ve --allow-foreign
# Geri alma (bağ + durum; teklif/fiyat verisine dokunmaz):
python -m catalog_build unpublish --product-id 123 --confirm
```

Üretimde ilk koşu için öneri: `audit` -> `build --max-batches 20` (yaklaşık 100 bin teklif) ->
`status` -> sorun yoksa `build`. İlk koşu sonrası `VACUUM (ANALYZE) product`. Yazma yükü
(2,5 milyon ürün): yaklaşık 1,5 GB tablo+indeks, benzer büyüklükte WAL (`pg_wal` ve
pgBackRest arşivini izle). Feed senkronizasyonu çalışırken de çalışabilir (offer'a yazmaz);
yine de yoğun saatte `--sleep-ms` kullan. Yönetimde: `/yonetim/katalog/urunler?durum=draft`
(kimlik/slug/kaynak kimliğiyle ara) ve `/yonetim/katalog/kalite` "Yayın bekleyen kaynak
ilanları".

## Bootstrap kataloğu (geçici, yalnızca yerel)

`docs/decisions/0027`. Admitad öncesi test kataloğu; Shopify `/products.json`
üzerinden, **yalnızca yerel veritabanına**. `collect.bootstrap` localhost
dışındaki bir `DATABASE_URL`'e yazmayı reddeder.

```bash
cd services/ingest
.venv/Scripts/python -m collect.bootstrap --manifest bootstrap/shopify_merchants.json --report rapor.json
.venv/Scripts/python -m resolve --limit 5000        # offer -> product
.venv/Scripts/python -m similarity --prices          # fiyat istatistikleri + özet onarımı (özet artık yazarken yenilenir, 0072)
.venv/Scripts/python -m enrich --kind image --limit 50   # JINA_API_KEY gerekir; küçük parti
.venv/Scripts/python -m similarity --edges
```

Rapor dosyası kaynak başına başlangıç, keşfedilen kayıt, yeni/güncellenen
offer, reddedilen kayıt, hata ve süreyi içerir. Tekrar çalıştırmak
idempotenttir (`(merchant_id, external_id)` upsert).

**Para birimi (0029, 0031).** `currency_verified = true` ve `currency = "TRY"`
taşımayan Shopify merchant'ı mağazaya istek atılmadan reddedilir
(`ingest_run`: `refused:currency_unverified`). Kanıt manifestin yanındaki `currency_provenance.json`
dosyasından okunur; dosyada olmayan mağaza reddedilir. Mağaza çekmeden yalnızca
merchant ayarını güncellemek: `--register-only`.

**Aktivasyon yok (0042).** Bootstrap yeni merchant'ı `is_active = false`
ekler, mevcut merchant'ın `is_active`'ine dokunmaz ve pasif merchant için
mağazaya istek atmaz (rapor: `inactive`). Aktivasyon ayrı, onaylı bir adımdır.
Para birimi doğrulanmış bir merchant'ın ayarı manifestten farklıysa kayıt
reddedilir (`refused`), satır değişmez. Toplama, ilk katalog isteğinden önce
robots.txt'i katı biçimde denetler.

**Barkod zenginleştirmesi (0034, 0036).** `collect.bootstrap` her mağazanın
toplamasından hemen sonra otomatik çalıştırır (`--skip-identifiers` ile kapanır;
hata toplamayı düşürmez, rapora yazılır). Bağımsız çalıştırma:
`python -m collect.identifiers --merchant <slug> [--force]`. Kapsam: yalnızca
birden fazla mağazada görülen markaların offer'ları. Kaynak: herkese açık
`/products/<handle>.js`, robots.txt'e tabi, sıralı, ≤ 0,5 istek/sn, yeniden deneme
yok, 401/403/429'da mağaza durur. Barkod varyant satırına (`offer_variant.gtin`)
yazılır; offer düzeyinde yalnızca tek ticari varyantsa. 7 gün içinde kontrol
edilen offer yeniden istenmez. Sonra `resolve`.

**Çakışma corpus'u (0029).** `bootstrap/overlap_merchants.json`: eşleştirmenin
doğru-pozitif tarafını ölçmek için 3 mağaza. Ölçüm: `python -m resolve.overlap_eval`.

**Tohum verisinden ayırma.** Geliştirme tohumu (`pnpm seed`) yalnızca yerel
veritabanına yazar. Merchant'ları `.example` alan adlıdır (RFC 2606, gerçek
mağaza olamaz). Bootstrap QA sırasında aramayı kirletmesin diye yerelde:
`UPDATE merchant SET is_active = FALSE WHERE domain LIKE '%.example';`
(geri almak: `TRUE`). Metin arama ölçümü (`node packages/core/scripts/search-eval.ts`)
kapsamı zaten bootstrap merchant'larıyla sınırlar.

**Nasıl ayırt edilir.** Şema değişmedi; işaret merchant üzerindedir:

```sql
-- bootstrap merchant'lari
SELECT id, slug, domain FROM merchant
 WHERE feed_config->>'bootstrap_source' = 'bootstrap_shopify';
-- bootstrap offer'lari
SELECT o.* FROM offer o JOIN merchant m ON m.id = o.merchant_id
 WHERE m.feed_config->>'bootstrap_source' = 'bootstrap_shopify';
-- YALNIZCA bootstrap offer'larina bagli urunler (baska kaynaktan offer'i
-- olan urun bootstrap sayilmaz)
SELECT p.id FROM product p
 WHERE EXISTS (SELECT 1 FROM offer o JOIN merchant m ON m.id = o.merchant_id
                WHERE o.product_id = p.id
                  AND m.feed_config->>'bootstrap_source' = 'bootstrap_shopify')
   AND NOT EXISTS (SELECT 1 FROM offer o JOIN merchant m ON m.id = o.merchant_id
                    WHERE o.product_id = p.id
                      AND m.feed_config->>'bootstrap_source' IS DISTINCT FROM 'bootstrap_shopify');
```

**Temizlik — hiçbir betik bunu otomatik çalıştırmaz.** İki yol:

1. **Yumuşak emeklilik (her ortamda geçerli).** `price_point` ve `click`
   append-only olduğu için (CLAUDE.md kural 4 ve 8) önce bu tercih edilir:
   `UPDATE merchant SET is_active = FALSE` ve bu merchant'ların offer'larında
   `is_active = FALSE`; ardından `public_find` / `discovery_slot` satırlarından
   bootstrap ürünleri çıkarılır. Yönetimden mağaza kapatmak özetleri aynı
   işlemde sıfırlar; elle SQL ile kapatıldıysa günlük onarım cron'u ya da
   `python -m similarity --prices` sıfırlar (karar 0072). Arama `m.is_active`
   ile zaten dışarıda bırakır.
2. **Tam silme (yalnızca hiçbir yere taşınmamış yerel veritabanı).** En temizi
   yerel veritabanını sıfırlamaktır: `docker compose -f infra/docker-compose.yml
   down -v`, ardından `pnpm db:migrate`, `pnpm db:bootstrap-role`, `pnpm seed`.
   Satır satır silmek gerekirse sahip rolüyle, tek transaction'da, şu sırayla
   (yukarıdaki kimlik sorgularıyla daraltılarak): `similarity_edge`,
   `product_price_stats`, `match_candidate`, `public_find`, `discovery_slot`,
   `click`, `product_view`, `saved_item`, `collection_item`, `alert`,
   `product_slug_history`, `price_point`, `offer` (varyant ve stok olayları
   cascade), `product`, `ingest_run`, `merchant`. `embedding` satırları
   `0014` trigger'ı ile düşer; sonra `pnpm db:orphans --check`.

## Rol değiştirme (yönetici / moderatör)

Karar 0039: rol arayüzden atanmaz; `app_user.role` tek kaynaktır ve yetenekler
koddaki sabit haritadan gelir (`packages/core/src/admin/capabilities.ts`).
Hesap önce normal girişle (Google/Apple) bir kez açılmış olmalıdır.

**Yerel geliştirme** - denetlenen, idempotent, geri alınabilir betik:

```bash
pnpm db:set-role -- --email kisi@ornek.com --role admin --reason "yerel test yöneticisi"
pnpm db:set-role -- --email kisi@ornek.com --role user  --reason "yetki geri alındı"
# e-posta yerine: --public-id <uuid>; başka bir yönetici adına: --actor-email <yönetici>
```

- Yalnızca yerel veritabanında çalışır (`DATABASE_URL_OWNER` localhost değilse durur).
- Rol zaten istenen değerse hiçbir şey yazmaz.
- `users.role_change` denetim satırını veritabanı tetikleyicisi
  (`app_user_role_change_audit`, 0039) aynı işlemde yazar; betik yalnızca aktörü
  ve gerekçeyi verir (`actor_role = 'cli'`). `/yonetim/denetim`'de "Rol
  değiştirildi" olarak görünür. Tetikleyici yoksa betik durur.
- Rol her istekte veritabanından okunur: açık oturum bir sonraki istekte yeni
  rolle değerlendirilir. Yönetim alanı ayrıca 12 saat / 30 dakika oturum
  kuralını uygular (karar 0044).

**Üretim** - betik bilerek çalışmaz. Onaylı bir işlemde, sahip rolüyle, tek
transaction'da elle. Denetim satırını tetikleyici yazar (karar 0050); elle
INSERT YAZILMAZ, yalnızca aktör ve gerekçe işleme verilir:

```sql
BEGIN;
SELECT set_config('arilla.audit_actor_user_id', '<işlemi yapan yöneticinin id''si ya da boş>', true),
       set_config('arilla.audit_actor_role', 'cli', true),
       set_config('arilla.audit_reason', '<gerekçe>', true);
UPDATE app_user SET role = 'admin'
 WHERE public_id = '<hesap kimliği>' AND role <> 'admin'
RETURNING id;                       -- tam olarak 1 satır dönmeli; dönmezse ROLLBACK
COMMIT;
```

Geri almak için aynı işlem `role = 'user'` ile. Ayar verilmeden yapılan rol
değişikliği de denetlenir (aktör boş, `actor_role = 'db'`, `after.dbRole` bağlanan
veritabanı rolü): `dbRole = 'arilla_app'` olan bir rol satırı uygulama rolünün
kötüye kullanıldığını gösterir, olay olarak ele alınır.

Yetkili hesap kendi hesabını `/hesap`'tan silemez; önce rolü bu yolla düşürülür.
Rolü düşürülmüş hesap silinince denetim satırları kalır, aktör bağlantısı boşalır.

## Yönetim ana makinesi (`ADMIN_HOST`, karar 0056)

`ADMIN_HOST` tanımsızken konsol bugünkü gibi `/yonetim`'dedir. Tanımlıyken
(ör. `admin.manicepte.com`) konsol, `/api/yonetim/*` ve yönetim yetenekleri
YALNIZCA o ana makinede çalışır; public sitedeki `/yonetim*` oraya 308 ile
gider, oradaki public yollar public siteye döner. Yönetim girişi orada yalnızca
Google'dır. Oturum çerezi host-only olduğu için yönetim oturumu public
oturumdan ayrıdır: geçişten sonra yöneticiler admin alan adında bir kez daha
giriş yapar.

Kod değişkensiz dağıtılabilir (etkisizdir). Açma sırası — sıra bozulursa
yönetim girişi kırılır, public site etkilenmez:

1. DNS: `admin` kaydı web'i gösterir (Vercel: CNAME `cname.vercel-dns.com`;
   VPS: A kaydı + Caddyfile'a `admin.<alan>` site bloğu, aynı `reverse_proxy`).
2. Vercel: Project → Settings → Domains → `admin.<alan>` ekle, sertifika "Valid"
   olsun. `https://admin.<alan>/yonetim/giris` açılmalı (henüz yönlendirme yok).
3. Google Cloud Console → OAuth istemcisi → Authorized redirect URIs'e
   `https://admin.<alan>/giris/google/callback` ekle (eskisi KALIR).
4. Ortam: `ADMIN_HOST=admin.<alan>` yalnızca Production'a (preview'a değil),
   yeniden dağıt. Üretimde değer port/localhost içerirse ya da biçim bozuksa
   konsol hiçbir yerde açılmaz (fail-closed), public site çalışır.
5. Doğrula:
   - `curl -sI https://<alan>/yonetim` → `308`, `location: https://admin.<alan>/yonetim`
   - `curl -sI https://admin.<alan>/` → `307` → `/yonetim`
   - `curl -sI https://admin.<alan>/hakkinda` → `308` → `https://<alan>/hakkinda`
   - `curl -s -o /dev/null -w '%{http_code}' -X POST https://<alan>/api/yonetim/katalog-toplama` → `404`
   - Tarayıcıda admin alan adında Google ile giriş, bir konsol sayfası ve bir
     işlem (ör. kullanıcı arama).

Geri alma: `ADMIN_HOST`'u sil ve yeniden dağıt; konsol `/yonetim`'e döner.

## Acil oturum kapatma (ele geçirilmiş hesap)

Karar 0050. Üç yol, en hızlısından:

1. Yönetim paneli: `/yonetim/kullanicilar/<hesap>` → "Tüm oturumları kapat"
   (yalnızca yönetici, son 1 saatte giriş, gerekçe zorunlu, denetlenir).
2. Kullanıcının kendisi: `/hesap` → "Tüm cihazlardan çıkış yap".
3. Panel erişilemiyorsa ya da ele geçirilen bir YÖNETİCİ ise, sahip rolüyle:

```bash
pnpm db:revoke-sessions -- --public-id <uuid> --reason "<gerekçe>" --demote --confirm-remote
# --demote: rolü 'user'a düşürür (tetikleyiciyle denetlenir); --actor-email <yönetici> isteğe bağlı
```

Oturum silme, `sessions.revoke_all` satırı ve rol düşürme tek işlemdir. Ardından:
`/yonetim/denetim`'de son `users.role_change`, `security.access_denied` ve
`sessions.revoke_all` satırlarını incele; hesabın Google/Apple tarafında da
oturumlarının kapatılmasını iste. `SESSION_SECRET` döndürmek BÜTÜN kullanıcıları
çıkışa zorlar; yalnızca sır sızıntısında yapılır.

## Pazarlama e-postası kampanyaları

Karar 0048. Yönetim: `/yonetim/kampanyalar` (yalnızca yönetici).

**Açma (üretim).** Gerçek gönderim varsayılan olarak kapalıdır. Açmadan önce:
İYS kaydı ve rıza metninin hukuk onayı (`docs/kvkk.md`), sağlayıcıda gönderen
alan adı doğrulaması (SPF/DKIM/DMARC). Sonra Vercel production'da
`MARKETING_EMAIL_FROM` ve `MARKETING_EMAIL_ENABLED=true`, GitHub Actions'ta
`MARKETING_CRON_URL` secret'ı. Kapatmak için `MARKETING_EMAIL_ENABLED`
boşaltılır: sürmekte olan kampanya `sending`te bekler, ileti gitmez,
yönetim ekranı "gerçek gönderim kapalı" der.

**Test gönderimi.** Yalnızca gönderen yöneticinin kendi adresine (hesap
e-postası ya da doğrulanmış Google/Apple e-postası) veya
`MARKETING_TEST_RECIPIENTS` (virgülle ayrılmış) listesindeki adreslere gider;
saatte en fazla 10 (karar 0050). Başka adres reddedilir ve sayılmaz.

**İlerleme.** Gönderim partiler hâlinde: başlatma anında bir parti, sonra
`trigger-alerts-cron.yml` ile 15 dakikada bir parti (varsayılan 40 ileti).
Büyük liste için `MARKETING_EMAIL_BATCH_SIZE` artırılır (süre bütçesine
dikkat) ya da kampanya sayfasındaki "sonraki partiyi şimdi işle" kullanılır.
Yerelde cron yok; düğme ya da `curl -H "Authorization: Bearer $CRON_SECRET"
http://localhost:3000/api/cron/marketing-campaigns`.

**Durumlar.** "Sağlayıcıya verildi" = SMTP kabul etti; teslim, bounce ve
şikâyet henüz izlenmiyor. `unknown_outcome` = ileti verilirken süreç durdu ya
da bağlantı veri aktarımında koptu; çift ileti riskine karşı yeniden
denenmez. Kampanya `sending`te takılı kaldıysa önce ekrandaki son hata
koduna bakılır (`configuration_error`: SMTP/gönderen; `bulk_send_disabled`:
ortam kapısı).

## GA4: rızaya bağlı trafik ölçümü (karar 0087)

Kod hazır; üretimde etkinleştirme bu adımlarla ELLE yapılır. Kimlik veya
anahtar uydurulmaz, depoya yazılmaz.

**1. GA4 mülkü (analytics.google.com, Yönetici):**
- Mülk saat dilimi **Europe/Istanbul**, para birimi TRY.
- Web veri akışı → Measurement ID'yi (`G-…`) not et.
- Veri akışı → **Gelişmiş ölçüm KAPALI** (en azından: sayfa görüntüleme
  altındaki "tarayıcı geçmişi olaylarına göre sayfa değişiklikleri", kaydırma,
  giden tıklamalar, site içi arama, form etkileşimleri, video, dosya
  indirme). Kod yalnızca elle `page_view` gönderir; açık kalan otomatik olay
  arındırılmamış veri toplayabilir.
- Veri saklama: **2 ay**; Google sinyalleri: **kapalı**; reklam ürünü
  bağlantısı yok.

**2. Raporlama erişimi — federe kimlik, anahtarsız (karar 0088, önerilen):**

Vercel production fonksiyonu kendi OIDC belirteciyle Google STS'den federe
belirteç alır ve servis hesabına bürünür. JSON anahtar **üretilmez**. Bu
projenin değerleri (sır değil):

| | |
|---|---|
| GCP projesi / numarası | `manicepte` / `535980235187` |
| Havuz / sağlayıcı | `vercel` / `vercel-prod` |
| Servis hesabı | `manicepte-ga4-reporting@manicepte.iam.gserviceaccount.com` |
| Issuer (Vercel Team modu) | `https://oidc.vercel.com/yusufsari4330-5616s-projects` |
| İzinli audience | `https://vercel.com/yusufsari4330-5616s-projects` |
| İzinli `sub` (yalnızca production) | `owner:yusufsari4330-5616s-projects:project:arilla-ai:environment:production` |

```sh
gcloud services enable sts.googleapis.com iamcredentials.googleapis.com \
  iam.googleapis.com analyticsdata.googleapis.com --project=manicepte

gcloud iam workload-identity-pools create vercel \
  --project=manicepte --location=global --display-name="Vercel"

gcloud iam workload-identity-pools providers create-oidc vercel-prod \
  --project=manicepte --location=global --workload-identity-pool=vercel \
  --issuer-uri="https://oidc.vercel.com/yusufsari4330-5616s-projects" \
  --allowed-audiences="https://vercel.com/yusufsari4330-5616s-projects" \
  --attribute-mapping="google.subject=assertion.sub" \
  --attribute-condition='assertion.sub == "owner:yusufsari4330-5616s-projects:project:arilla-ai:environment:production"'

# Tek özneye (principalSet değil) bürünme izni; servis hesabına proje rolü verilmez.
gcloud iam service-accounts add-iam-policy-binding \
  manicepte-ga4-reporting@manicepte.iam.gserviceaccount.com --project=manicepte \
  --role=roles/iam.workloadIdentityUser \
  --member="principal://iam.googleapis.com/projects/535980235187/locations/global/workloadIdentityPools/vercel/subject/owner:yusufsari4330-5616s-projects:project:arilla-ai:environment:production"
```

- GA4 Yönetici → Mülk erişim yönetimi → servis hesabı e-postası
  **Görüntüleyici** (başka rol verme). Federe kimlik mülke doğrudan
  eklenemez; bu yüzden servis hesabına bürünülür.
- Vercel → Project Settings → Security → **Secure Backend Access with OIDC
  Federation: açık, Issuer Mode: Team**.
- Preview ve geliştirme ortamları koşulu sağlamaz: orada `/yonetim/trafik`
  "federe kimlik reddedildi" gösterir. Bu bilinçlidir.

**2b. Yedek: özel anahtar kipi (yalnızca Vercel dışı barındırma).**
Servis hesabı → JSON anahtar → `GA4_PRIVATE_KEY`. Yerel kopya silinir, yılda
bir döndürülür. `GA4_WIF_AUDIENCE` ile **birlikte tanımlanamaz** (ikisi de
"Geçersiz" görünür, istek atılmaz).

**3. Vercel ortamı (yalnızca Production):**
- `GA4_MEASUREMENT_ID` = `G-…`
- `GA4_PROPERTY_ID` = mülk kimliği (yalnızca rakam)
- `GA4_CLIENT_EMAIL` = `manicepte-ga4-reporting@manicepte.iam.gserviceaccount.com`
- `GA4_WIF_AUDIENCE` =
  `//iam.googleapis.com/projects/535980235187/locations/global/workloadIdentityPools/vercel/providers/vercel-prod`
- `GA4_PRIVATE_KEY` **tanımlanmaz** (federe kipte).
- `GA4_TEST_API_BASE_URL` **tanımlanmaz**.
- **Yeniden dağıt:** CSP ve yasal metinler derlemede üretilir.

**4. Doğrulama (dağıtım sonrası):**
- `/yonetim/ayarlar` → "Trafik ölçümü (GA4)": hepsi "Tanımlı", servis hesabı
  notunda "Kip: federe (anahtarsız)".
- Gizli pencerede site: banner yeniden çıkar; reddedince ağ sekmesinde
  `googletagmanager` isteği OLMAMALI. Yalnızca "Analitik"i açınca
  `gtag/js` yüklenir; GA4 DebugView'da `page_view` adresinde `?q=` yok.
- `/yonetim/trafik` 24–48 saat içinde veri gösterir. Hata kodları:

| Kod | Anlamı | Bakılacak yer |
|---|---|---|
| `identity_unavailable` | Fonksiyon OIDC belirteci almadı | Vercel OIDC Federation açık mı, dağıtım yeniden yapıldı mı |
| `federation_rejected` | STS reddetti | Issuer/audience/`sub` koşulu, ekip adı, ortam production mı |
| `impersonation_denied` | Bürünme izni yok | Servis hesabındaki `roles/iam.workloadIdentityUser` bağı |
| `permission` | GA4 mülkü reddetti | Servis hesabı mülkte Görüntüleyici mi |

**Geri alma:** `GA4_MEASUREMENT_ID`'yi sil ve yeniden dağıt → betik, CSP
genişlemesi ve yasal metinlerdeki GA4 anışları birlikte kalkar. Raporlama
değişkenleri ayrı silinebilir. Federe erişimi tümden kesmek için
`gcloud iam workload-identity-pools providers disable vercel-prod
--workload-identity-pool=vercel --location=global --project=manicepte`
(belirteçler en geç 1 saatte düşer).

**Kota:** standart mülk; tam görünüm ~10 rapor (2 toplu istek), önbellek
6 saat/15 dk. Kalan saatlik/günlük token eşiğin altındaysa istek atılmaz
(`TRAFFIC_QUOTA_FLOOR`).

## Dağıtım

- `main` dalına birleşme staging'e otomatik gider
- Vercel production'ı Git entegrasyonuyla dağıtılır (geçiş bitene kadar sürer)
- VPS yolu (karar 0109, faz 6): CI ✔ → GHCR imajı (`:<sha>`, digest ile) → `deploy.yml` → VPS'te
  `arilla-deploy` (migration yedeği + `migrate`, sağlık kapısı, **otomatik geri alma**). Aynı anda tek
  dağıtım. Elle onay isteniyorsa `vps-production` environment'ına *Required reviewers* eklenir; kod
  değişmez. Ayrıntı: "Otomatik dağıtım (faz 6)".
- Migration'lar geriye uyumlu yazılır: önce kolon eklenir, kod dağıtılır, sonra
  eski kolon kaldırılır. Tek adımda kolon silen migration reddedilir.
- Geri alma planı her dağıtımda hazır olur

## Olay yönetimi

Üretim kesintisinde: önce durumu kaydet, sonra düzelt, sonra `docs/decisions/`
altına ne olduğunu ve neyin değiştiğini yaz. Aynı hatanın ikinci kez olması
belge eksikliğidir.

## Maliyet takibi

Aylık gider kalemleri tek bir tabloda takip edilir: barındırma, veritabanı,
obje deposu, model çağrıları, e-posta, alan adı. Bu tablo proje belgesindeki
birim ekonomisi hesabını besler ve boş bırakılmaz.


## Konuşmalı keşif (`/sohbet`, karar 0074) — varsayılan kapalı

İstek yolunda Gemini çağırır (CLAUDE.md kural 1 istisna b). Ortam değişkenleri
(yalnızca sunucu): `CHAT_DISCOVERY_ENABLED=true` (yoksa özellik kapalı: ana sayfa
kutusu `/ara`ya gider, `/sohbet` 404), `CHAT_TURNS_PER_HOUR` (varsayılan 20, kullanıcı
başına), `GEMINI_API_KEY` (0059 ile ortak). Etkinleştirme sırası: 0054 migration
production'da uygulanır (`pnpm db:migrate`, `db:verify`) → kod dağıtılır → hukuk
onayı (docs/kvkk.md "Konuşmalı keşif") → bayrak açılır. Maliyet: `api_usage`
`operation = 'chat_turn'`. Saklama: 90 gün, `cleanup-auth` cron'u (`job_run.detail.conversations`).

**Görsel eki (karar 0078, 0091) — varsayılan kapalı.** `CHAT_IMAGE_ENABLED=true`
(`CHAT_DISCOVERY_ENABLED` de açık olmalı). Kapalıyken ana sayfa ve sohbet kutusunda
"+" görünmez, eski `/ara/gorsel` akışına düşülmez. Görselli mesaj metinle aynı
sohbet turu kotasından geçer (arama hakkı harcanmaz); ek migration yok (0057 yeter).
Etkinleştirme: hukuk onayı + aydınlatma/açık rıza metni (docs/kvkk.md "Yüklenen
görseller"), sonra bayrak. Production'da onay olmadan açılmaz.
Ön koşul (karar 0101): migration 0057 **ve 0063** production'da uygulanmış olmalı (0063 yoksa
rıza kaydı CHECK hatası verir ve görsel gönderimi `unavailable` döner); `/gizlilik` ve
`/kvkk-aydinlatma` sohbet eki için hukuk onaylı metinle güncellenmiş olmalı.

**Tanılama: "sohbet çalışmıyor" (salt okunur).** Sırayla bakılır:

1. Bayrak: `/sohbet` 404 ya da ana sayfa kutusu `/ara`ya gidiyorsa `CHAT_DISCOVERY_ENABLED`
   tam olarak `true` değildir (`GEMINI_API_KEY` tek başına sohbeti açmaz). Değer yazdırılmadan
   yalnızca varlığı: `docker compose exec web sh -c 'test "$CHAT_DISCOVERY_ENABLED" = true && echo on || echo off'`.
   Lansman kapısı (`PRODUCT_ACCESS`) de ayrıca denetlenir.
2. Konteyner günlüğü: sağlayıcı hatasında tek satır yazılır, ör.
   `[sohbet] model provider_error code=client_error http=400 model=gemini-3.1-flash-lite attempts=1 detail=INVALID_ARGUMENT ...`.
   `docker compose logs --since 30m web | grep '\[sohbet\]'`. Anahtar, istem ve kullanıcı metni asla yazılmaz.
3. Veritabanı: `SELECT occurred_at, error_class, http_status, model_version, error_summary FROM ai_error_event WHERE surface = 'chat' ORDER BY occurred_at DESC LIMIT 20;`
   ve `SELECT operation, model_version, count(*) FROM api_usage WHERE operation = 'chat_turn' AND created_at > now() - interval '1 day' GROUP BY 1, 2;`
   (satır yoksa model hiç çağrılmamıştır: bayrak, oturum, kota ya da günlük tavan).

### Sohbette ürün linki (karar 0090) — varsayılan kapalı

`CHAT_LINK_ENABLED=true` (ayrıca `CHAT_DISCOVERY_ENABLED=true` ister) sohbetteki linki mevcut link kuyruğuna verir; modele gitmez. Önkoşul: link worker'ı üretimde çalışıyor olmalı ("Link worker" bölümü; yoksa istekler 2 dk sonra 'worker yanıt vermedi' olur). `CHAT_LINK_INTERPRET_ENABLED=true` (ayrıca `CHAT_LINK_ENABLED`) deterministik ayrıştırmanın çözemediği tercih metni için tek Gemini çağrısı yapar; `api_usage` `chat_turn`, mevcut günlük/saatlik tavanlar. `/ara/link` ve `LINK_SEARCH_PUBLIC` bu bayraklardan bağımsızdır. Kademe: iç ekip → küçük kitle → herkes; izle: kuyruk uzunluğu, `error_code` dağılımı, Jina maliyeti. Geri alma: bayrakları kapat (migration yok).

## Veri zekâsı bayrakları (karar 0103)

Hepsi varsayılan **kapalı**; hukuki onay olmadan açılmaz.

| Değişken | Etki |
| --- | --- |
| `DATA_INTELLIGENCE_BUILD_ENABLED=true` | Rızalı olaylardan veri seti üretimi (`/yonetim/veri-zekasi`) |
| `DATA_INTELLIGENCE_EXPORT_ENABLED=true` | Dahili dışa aktarım (üretim bayrağı da açık olmalı) |
| `DATA_INTELLIGENCE_CLEARED_SOURCES=user_activity_event` | Hukuken onaylanmış kaynaklar; boş = hiçbiri |

### İnternet ürün araması (karar 0102) — varsayılan kapalı

`WEB_SEARCH_ENABLED=true` + `GEMINI_API_KEY` iken `/ara` (ve açıkken `/ara/link`) sonuç sayfası, katalog aramasıyla paralel olarak Gemini Google Search grounding + URL Context çağırır ve sonuçları katalog sonuçlarının altında akıtır. **Production'da ayrıca `WEB_SEARCH_LEGAL_APPROVED=true` gerekir**; ikisi de hukuki onaydan sonra Vercel Production'da elle açılır. Migration gerekmez. Sonuçlar önbelleğe alınmaz ve izlenmez (Google şartları); bağlantılar doğrudan mağazaya gider.

Sınırlar: günlük 300 sağlayıcı denemesi (`web_search` bütçesi), kişi başına saatte 8 / günde 30, Redis yoksa model çağrılmaz. Sonuçlar kataloga yazılmaz. Geri alma: bayrakları kapat (migration gerekmez; `/git/web/*` 404 verir).

İzleme:

```sql
SELECT count(*), sum(cost_micros) FROM api_usage
 WHERE operation = 'web_search_grounded'
   AND created_at >= (now() AT TIME ZONE 'Europe/Istanbul')::date AT TIME ZONE 'Europe/Istanbul';
SELECT operation, count(*), sum(units) AS units, sum(cost_micros) FROM api_usage
 WHERE operation LIKE 'web_search%' AND created_at >= now() - interval '7 days' GROUP BY 1;
```

Maliyet: token satırı (`web_search_grounded`) ve Google arama sorgusu satırı (`web_search_grounding_queries`, liste fiyatı; ayda 5.000 ücretsiz kontenjan düşülmez) ayrıdır; `LLM_COST_TRY_PER_USD` tanımlı olmalı.

**Gerçek API dumanı (karar 0102):** `WEB_SEARCH_SMOKE=1 GEMINI_API_KEY=<anahtar> pnpm --filter @arilla/core web-search:smoke [1-3]` en fazla 3 sabit örnek sorgu çalıştırır (veritabanı/Redis yok, anahtar yazdırılmaz); atıf/URL Context/search_suggestions alanlarını, doğrulanan sonuçları ve tahmini maliyeti özetler. Anahtarı komut satırına yazmak yerine oturumda `read -s` ile ortama alın.

### Veritabanı bağlantısı: pooler modu (EMAXCONNSESSION)

Üretimde `DATABASE_URL` Supabase **Transaction pooler**'ını (port `6543`) göstermelidir; Session pooler (`5432`, `pool_size` 15) serverless'ta `EMAXCONNSESSION` verir. Uygulama başına varsayılan havuz 3 bağlantıdır (`DATABASE_POOL_MAX`). `DATABASE_URL_OWNER` (migration/bakım) Transaction pooler'a ÇEVRİLMEZ; doğrudan ya da session bağlantısıyla kalır.
