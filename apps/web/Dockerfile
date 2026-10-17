# syntax=docker/dockerfile:1.7
#
# Web imaji (Next.js 16, standalone). Baglam REPO KOKUDUR (pnpm workspace):
#
#   docker build -f apps/web/Dockerfile --build-arg APP_URL=https://alan-adi.com -t arilla-web .
#   docker build -f apps/web/Dockerfile --target migrate -t arilla-migrate .
#
# Karar 0109. Ilkeler:
# - Imaja GIZLI DEGER GIRMEZ. `.dockerignore` `.env*`'i disarida tutar; calisma
#   zamani degerleri (DATABASE_URL, REDIS_URL, SESSION_SECRET, ...) konteynere
#   `env_file`/`secrets` ile verilir, `ARG`/`ENV` ile asla.
# - Build-arg'lar yalnizca SIR OLMAYAN, derlemeye gomulen degerlerdir:
#   `APP_URL` (robots.txt/canonical derlemede uretilir) ve `GA4_MEASUREMENT_ID`
#   (CSP derlemede uretilir; sayfa HTML'inde zaten gorunur). Degisince yeniden
#   derleme gerekir.
# - Son asama (varsayilan hedef) calisma imajidir; `migrate` hedefi ayri, kucuk
#   bir imajdir (yalnizca packages/db) ve dagitimda bir kez calisir.
# - Node surumu CI ile ayni ana surum (24); pnpm, kok `package.json`
#   `packageManager` ile ayni surume sabitlenir. Calisma imajlari `node-runtime`
#   (debian-slim + yalniz node ikilisi) uzerindedir: npm/yarn/corepack yok, ~90 MB kucuk.

ARG NODE_VERSION=24.15.0
ARG PNPM_VERSION=11.20.0

# --- node-runtime: debian-slim + YALNIZ node ikilisi -------------------------------
# Resmi `node` imajinda npm, corepack ve yarn de gelir (~25 MB + sik raporlanan
# bagimlilik zafiyetleri); calisma ve migrate imajlarinin hicbiri bunlari kullanmaz.
# Node yalnizca libstdc++/libgcc ister (debian-slim'de var); kok sertifikalari Node'un
# kendi paketindedir. Kullanici adi/uid (node:1000) resmi imajla ayni kalir.
FROM node:${NODE_VERSION}-bookworm-slim AS node-source
FROM debian:bookworm-slim AS node-runtime
COPY --from=node-source /usr/local/bin/node /usr/local/bin/node
# `apt-get upgrade`: taban imajdan sonra yayinlanan guvenlik yamalari (ornegin perl-base)
# derleme aninda alinir; Trivy bunlari dogrular.
RUN apt-get update     && apt-get -y --no-install-recommends upgrade     && rm -rf /var/lib/apt/lists/*     && groupadd --gid 1000 node     && useradd --uid 1000 --gid node --shell /usr/sbin/nologin --create-home node

# --- base: node + pnpm ----------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS base
ARG PNPM_VERSION
ENV NEXT_TELEMETRY_DISABLED=1 \
    CI=true
RUN npm install --global --no-audit --no-fund "pnpm@${PNPM_VERSION}"
WORKDIR /app

# --- deps: tum bagimliliklar (yalnizca manifestler; kaynak degisince katman kalir) --
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# --- build: next build (standalone) ---------------------------------------------
FROM deps AS build
ARG APP_URL
ARG GA4_MEASUREMENT_ID=""
# Karar 0116: Umami izleyicisi (sir DEGIL; CSP derlemede uretilir). Bos = Umami kapali.
ARG UMAMI_BASE_URL=""
ARG UMAMI_WEBSITE_ID=""
ARG UMAMI_TRACKER_SCRIPT_NAME=""
# Uretim imaji: APP_URL olmadan derleme baslamaz (yanlis canonical ile canliya
# cikmaktan iyidir). `DEPLOY_ENV=production` derlemede de uretim kapilarini acar
# (https zorunlu, localhost reddedilir; packages/core/src/config/app-url.ts).
RUN test -n "$APP_URL" || (echo "APP_URL build-arg zorunlu (orn. https://alan-adi.com)" >&2; exit 1)
ENV NODE_ENV=production \
    NEXT_OUTPUT=standalone \
    DEPLOY_ENV=production \
    APP_URL=${APP_URL} \
    GA4_MEASUREMENT_ID=${GA4_MEASUREMENT_ID} \
    UMAMI_BASE_URL=${UMAMI_BASE_URL} \
    UMAMI_WEBSITE_ID=${UMAMI_WEBSITE_ID} \
    UMAMI_TRACKER_SCRIPT_NAME=${UMAMI_TRACKER_SCRIPT_NAME}
COPY tsconfig.base.json ./
COPY apps/web apps/web
COPY packages packages
RUN pnpm --filter @arilla/web build

# --- migrate-deps: yalnizca packages/db uretim bagimliliklari ----------------------
FROM base AS migrate-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @arilla/db...

# --- migrate: sema/rol/bolum betikleri (dagitimda bir kez, sonra cikar) -----------
# Komut ornekleri (docs/ops.md "Migration job"): node scripts/migrate.ts,
# node scripts/bootstrap-app-role.ts, node scripts/partitions.ts [--check],
# node scripts/verify-schema.ts. Sahip kimligi (DATABASE_URL_OWNER) yalnizca bu
# konteynere calisma aninda verilir; web konteynerinde YOKTUR.
FROM node-runtime AS migrate
ENV NODE_ENV=production
WORKDIR /app/packages/db
COPY --chown=node:node package.json /app/package.json
COPY --chown=node:node pnpm-workspace.yaml /app/pnpm-workspace.yaml
COPY --chown=node:node packages/db/package.json packages/db/tsconfig.json ./
COPY --chown=node:node packages/db/src ./src
COPY --chown=node:node packages/db/scripts ./scripts
COPY --chown=node:node packages/db/migrations ./migrations
COPY --from=migrate-deps --chown=node:node /app/node_modules /app/node_modules
COPY --from=migrate-deps --chown=node:node /app/packages/db/node_modules ./node_modules
USER node
CMD ["node", "scripts/migrate.ts"]

# --- runner: calisma imaji (SON ASAMA = varsayilan hedef) ---------------------------
FROM node-runtime AS runner
# Uretim varsayilani; staging `DEPLOY_ENV=staging` ile ezer (calisma zamani).
ENV NODE_ENV=production \
    DEPLOY_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app
# standalone: izlenen minimum node_modules + server.js. Monorepo kokunden
# izlendigi icin giris noktasi `apps/web/server.js`.
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public
# Next onbellegi (ISR/veri) calisma aninda yazilir; kok dosya sistemi salt-okunur
# calistirilirsa bu yol bir volume/tmpfs olmali (infra/compose).
RUN mkdir -p /app/apps/web/.next/cache && chown -R node:node /app/apps/web/.next/cache
USER node
EXPOSE 3000
# Canlilik: yalniz surec (bagimlilik yok). Hazirlik `/api/health/ready` dagitim
# betiginde, ic agdan sorulur; Redis/DB gecici koparsa konteyner yeniden baslamaz.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]
