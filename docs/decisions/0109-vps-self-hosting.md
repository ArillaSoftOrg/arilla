# 0109 — Kendi sunucumuzda çalıştırma (Hostinger KVM 4, Docker Compose)

**Tarih:** 12 Ekim 2026
**Durum:** Kabul edildi. **Faz 1 (bu karar + bu PR) uygulandı:** imaj, sağlık uçları,
ortam tespiti. Compose yığını, Caddy, GHCR hattı ve otomatik dağıtım sonraki fazlardır.
**Mevcut Vercel production çalışmaya devam eder;** Supabase ve Upstash bu karar
kapsamında silinmez.

## Karar

Uygulama, Vercel/Supabase/Upstash yerine tek bir Hostinger KVM 4 VPS'te (Ubuntu 24.04,
4 vCPU / 16 GB / 200 GB) Docker Compose ile de çalışabilir hale getirilir; geçiş
tamamlanınca bağımsız çalışır.

1. **Topoloji (hedef):** Caddy (TLS, tek açık kapı) → `web` (Next.js standalone) →
   `postgres` (PostgreSQL 16 + pgvector) ve `redis` (Redis 7); `worker` (Python link
   worker'ı, `LINK_QUEUE_BACKEND=redis`); `cron` (zamanlayıcı konteyner). PostgreSQL ve
   Redis **internete açılmaz**: yalnızca `internal` Docker ağındadır, host'ta port
   yayınlanmaz.
2. **Veri:** Supabase verileri **taşınmaz.** PostgreSQL sıfırdan kurulur; mevcut
   migration zinciri (`packages/db/migrations`, 0001'den itibaren) tek şema kaynağıdır
   ve temiz bir veritabanında uçtan uca çalıştığı bu PR'da doğrulandı (58 migration,
   `bootstrap-role`, `partitions`, `verify-schema`). Katalog yeniden toplama ile dolar.
   Gerçek kullanıcı olmadığı için bu kabul edilebilir; kullanıcı verisi gelirse bu karar
   yeniden açılır.
3. **Redis:** Upstash yerine VPS Redis. Düz `redis://` yalnızca Docker iç ağ host'u için
   ve **açık izinle** kabul edilir (`REDIS_PLAINTEXT_HOSTS`); dış host'ta TLS (`rediss://`)
   zorunluluğu aynen sürer. Redis'te AOF açık, parola zorunlu, bellek tavanı sabit
   (`noeviction`); kuyruk ve kota sayaçları kaybolmasın.
4. **Ortam tespiti Vercel'den bağımsız:** üretim kapıları (https zorunlu, localhost
   reddi, TLS Redis, HSTS ve `upgrade-insecure-requests`, pazarlama toplu gönderimi,
   internet arama hukuki onayı) `DEPLOY_ENV=production` ile de açılır
   (`packages/core/src/config/deploy-env.ts`). `VERCEL_ENV=production` aynı kapıları
   açmaya devam eder: **Vercel davranışı değişmez.** `DEPLOY_ENV` boş ya da `staging`
   ise üretim kapısı açılmaz.
5. **Sağlık uçları:** `GET /api/health` (canlılık, bağımlılığa dokunmaz; Docker
   `HEALTHCHECK`) ve `GET /api/health/ready` (hazırlık: veritabanı `SELECT 1`, Redis
   `PING`; dağıtım kapısı). Hazırlık ucu **dışarıya açılmaz** (Caddy engeller); yanıt
   yalnızca bileşen adı ve `ok`/`fail` taşır, 2 sn önbelleklenir.
6. **İmajlar:** `apps/web/Dockerfile` (çok aşamalı, kök bağlam, `node:24-bookworm-slim`,
   non-root, `output: standalone`) ve `migrate` hedefi (yalnızca `packages/db`). Python
   imajı değişmez (`services/ingest/Dockerfile`). İmaja **gizli değer girmez**:
   `.dockerignore` `.env*`'i dışarıda tutar, yalnızca sır olmayan `APP_URL` ve
   `GA4_MEASUREMENT_ID` build-arg'dır.
7. **Dağıtım ilkesi (sonraki faz):** `main` birleşmesi → CI → GHCR imajı (`:<sha>`) →
   VPS betiği: çek → `migrate` → `up -d` → `/api/health/ready` kapısı → başarısızsa
   önceki sha'ya otomatik dönüş. **Runtime sırlar yalnızca VPS'te** (`/opt/arilla/.env`,
   `root:deploy 0640`) durur; GitHub'da yalnızca SSH/deploy anahtarı olur. CI iş akışı
   `secrets.*` kullanmamaya devam eder.

## Gerekçe

- Vercel/Supabase/Upstash'e bağımlılık maliyet, çıkış ve KVKK yerleşimi açısından
  tek hizmete kilitlenmedir; `ops.md` "Sağlayıcı bağımsızlığı" ilkesi zaten taşınabilir
  muadilleri şart koşuyordu.
- `price_point` değiştirilemez (kural 4) ve `arilla_app` rolü superuser değildir: bu
  kurallar yönetilen servise değil, şemaya (0010) bağlıdır; kendi PostgreSQL'imizde de
  motor tarafından zorlanır.
- Veri taşımamak, replikasyon/kesinti penceresi riskini ortadan kaldırır.
- `DEPLOY_ENV` olmadan VPS'te `VERCEL_ENV` bulunmadığından üretim kapıları **sessizce
  kapanırdı** (canonical `http://localhost`, düz Redis, HSTS yok, pazarlama gönderimi
  kapalı). Açık ortam bildirimi bunu fail-closed yapar.

## Reddedilen alternatifler

| Alternatif | Neden değil |
| --- | --- |
| Supabase'i `pg_dump`/replikasyonla taşımak | Gerçek kullanıcı yok; katalog yeniden toplanabilir. Extension şeması (`extensions.vector`) ve rol farkları ek risk getirir. Veri gerekirse sonradan tek seferlik dump yeterli. |
| `VERCEL_ENV`'i VPS'te taklit etmek | Vercel kodunu VPS'e sızdırır; Vercel kaldırılınca kafa karıştırır. Açık `DEPLOY_ENV` daha dürüst. |
| Kubernetes / Swarm / ayrı servis ağı | CLAUDE.md yasaklar; tek VPS için Compose yeterli. Büyüme: DB'yi ayrı VPS'e almak yalnızca `DATABASE_URL` host'unu değiştirir. |
| Cloudflare proxy'sini hemen eklemek | İstemci IP'si için ek güven zinciri gerekir (`resolveClientIp` zincirin SON elemanını alır). Caddy doğrudan internette iken uyumludur; Cloudflare eklenirse kod önce güncellenir. |
| Redis'i TLS'siz serbest bırakmak | Dış host'larda parola ve kuyruk trafiği şifresiz giderdi. İzin listesi yalnızca iç ağ host'una açılır. |

## Sonuçlar ve sınırlar

- **Vercel yolu aynen çalışır;** `output: standalone` yalnızca imaj derlemesinde
  (`NEXT_OUTPUT=standalone`) açılır. Vercel derlemesinde çıktı biçimi değişmez.
- Vercel cron'ları (`vercel.json`) ve `trigger-alerts` GitHub Actions iş akışı Vercel
  production yaşadığı sürece olduğu gibi kalır. VPS'te aynı uçlar `cron` konteynerinden
  çağrılır (sonraki faz); **iki ortam aynı veritabanına yazmaz** (VPS kendi veritabanını
  kullanır).
- İstemci IP'si: VPS'te `VERCEL=1` yoktur; `resolveClientIp` `x-forwarded-for`
  zincirinin **son** elemanını alır. Caddy, güvenilmeyen istemcinin başlığını kendi
  gördüğü adresle ezdiği için doğrudan internete bakan Caddy ile doğru çalışır.
  Önüne başka bir proxy konursa bu karar yeniden değerlendirilir.
- GA4 federe kimlik (`@vercel/oidc`) yalnızca Vercel'de çalışır; VPS'te yalnızca
  `GA4_PRIVATE_KEY` kipi kullanılabilir. Bağımlılık Vercel'den çıkıldığında kaldırılır.
- Hukuk: `gizlilik` ve `kvkk-aydinlatma` sayfaları hâlâ Vercel/Supabase'i işleyici
  olarak sayar. Alan adı VPS'e çevrilmeden önce Hostinger (ve yurt dışı aktarım durumu)
  ile güncellenir; bu kod değil hukuk onayı işidir.
- Vercel'den çıkış sonrası (son faz): `DEPLOY_ENV` dışındaki `VERCEL*` okumaları,
  `vercel.json`, `@vercel/oidc` ve `@vercel/queue` yolu kaldırılır.

## Fazlar

1. **(Bu PR)** Karar, imaj, standalone, sağlık uçları, ortam tespiti, CI imaj derlemesi.
2. Compose yığını (`infra/`), Caddy, `postgresql.conf`, Redis ayarları, host sertleştirme.
3. GHCR yayın hattı (`build-push`), imaj taraması.
4. VPS'te staging: `migrate` → web+worker+cron, duman testleri, katalog toplama.
5. Yedekleme (WAL arşivi, geri yükleme testi), izleme.
6. Otomatik dağıtım ve rollback (`deploy.yml`).
7. Hukuk metinleri, alan adı geçişi, Vercel cron'larının kapatılması.
8. Vercel/Supabase/Upstash kodunun ve belgelerinin temizliği.
