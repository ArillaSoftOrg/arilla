import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import { securityHeaderOptionsFromEnv, securityHeaderRoutes } from "./security-headers.ts";

/**
 * `next.config.ts` `apps/web` icinden calisir, repo kokundeki `.env`'i
 * Next.js kendiliginden okumaz. `packages/db/scripts/lib.ts` ve
 * `packages/core/src/test-db.ts`'teki ayni desen burada da tekrarlanir.
 */
function loadDotEnv(): void {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
  for (const candidate of [join(repoRoot, ".env"), join(repoRoot, ".env.local")]) {
    let raw: string;
    try {
      raw = readFileSync(candidate, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (key === undefined || rawValue === undefined) continue;
      if (process.env[key] !== undefined) continue;
      process.env[key] = rawValue.trim().replace(/^["']|["']$/g, "");
    }
  }
}

loadDotEnv();

/**
 * Guvenlik basliklari (CSP dahil) DERLEMEDE bir kez uretilir. Ayni secenekler `env` ile
 * koda gomulur: Umami izleyicisi yalnizca bu CSP'nin izin verdigi kokene basilir
 * (apps/web/app/lib/umami.ts); calisma ortamina sonradan eklenen degisken CSP'yi
 * degistirmez, betigi de bastirmaz.
 */
const securityOptions = securityHeaderOptionsFromEnv();

/**
 * Kendi sunucumuzda (Docker, karar 0109) kendi kendine yeten `standalone` cikti.
 * Yalnizca imaj derlemesinde `NEXT_OUTPUT=standalone` ile acilir; Vercel
 * derlemesi bu degiskeni gormez ve cikti bicimi DEGISMEZ.
 *
 * `outputFileTracingRoot` monorepo kokudur: workspace paketleri
 * (`packages/*`) kok `node_modules` uzerinden baglandigi icin izleme kokten
 * baslamazsa `standalone` klasorune eksik kopyalanir.
 */
const standaloneOutput: Pick<NextConfig, "output" | "outputFileTracingRoot"> =
  process.env.NEXT_OUTPUT === "standalone"
    ? {
        output: "standalone",
        outputFileTracingRoot: join(dirname(fileURLToPath(import.meta.url)), "../.."),
      }
    : {};

const nextConfig: NextConfig = {
  ...standaloneOutput,
  // Workspace paketleri ham TypeScript disa aktarir; derlemesini Next yapar.
  // @arilla/db de ham .ts disa aktarir - listede olmazsa derleme yalnizca
  // pnpm'in paketi node_modules disina baglamasi sayesinde calisir.
  transpilePackages: ["@arilla/core", "@arilla/db", "@arilla/ui"],
  env: {
    ARILLA_CSP_UMAMI_ORIGIN: securityOptions.umamiOrigin ?? "",
  },
  // Karar 0038: hukuk paketinin onerdigi adlar, canli /kosullar ve /cerez'e
  // kalici yonlendirilir (URL'ler geri alinamaz, docs/routes.md).
  async redirects() {
    return [
      { source: "/kullanim-kosullari", destination: "/kosullar", permanent: true },
      { source: "/cerez-politikasi", destination: "/cerez", permanent: true },
      // Karar 0176: tek arama yuzeyi /sohbet. Sorgu parametreleri (q, sort, sayfa, n,
      // yanit, uyari, url) Next yonlendirmesinde aynen tasinir.
      { source: "/ara/gorsel", destination: "/", permanent: true },
      { source: "/ara/link", destination: "/sohbet/link", permanent: true },
      { source: "/ara", destination: "/sohbet", permanent: true },
    ];
  },
  // Karar 0050: CSP, çerçeveleme yasağı ve diğer güvenlik başlıkları tek merkezde.
  async headers() {
    return [
      ...securityHeaderRoutes(securityOptions),
      // Degismeyen statik varliklar: varsayilan `max-age=0` her ziyarette
      // yeniden dogrulama yaptirir. Dosya adlari hash'siz oldugundan bir
      // hafta + arka planda yenileme; kullaniciya ozel icerik degildir.
      {
        source: "/:dir(fonts|ways)/:file*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=604800, stale-while-revalidate=86400",
          },
        ],
      },
    ];
  },
  poweredByHeader: false,
  experimental: {
    serverActions: {
      // Sohbet gorsel eki yuklemesi 4 MB ile sinirli (karar 0078/0091).
      // Limit ham multipart govdeye uygulanir (sinir + parca basliklari
      // ~10-20 KB ekler), bu yuzden 4 MB dosya icin 4mb yetmez. 4.5mb
      // Vercel Function istek govdesi ust siniriyla da ayni.
      bodySizeLimit: "4.5mb",
    },
  },
};

export default nextConfig;
