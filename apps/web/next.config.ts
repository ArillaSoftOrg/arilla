import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

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

const nextConfig: NextConfig = {
  // Workspace paketleri ham TypeScript disa aktarir; derlemesini Next yapar.
  // @arilla/db de ham .ts disa aktarir - listede olmazsa derleme yalnizca
  // pnpm'in paketi node_modules disina baglamasi sayesinde calisir.
  transpilePackages: ["@arilla/core", "@arilla/db", "@arilla/ui"],
  // Karar 0038: hukuk paketinin onerdigi adlar, canli /kosullar ve /cerez'e
  // kalici yonlendirilir (URL'ler geri alinamaz, docs/routes.md).
  async redirects() {
    return [
      { source: "/kullanim-kosullari", destination: "/kosullar", permanent: true },
      { source: "/cerez-politikasi", destination: "/cerez", permanent: true },
    ];
  },
  experimental: {
    serverActions: {
      // Gorsel arama yuklemesi 4 MB ile sinirli (ara/gorsel/actions.ts).
      // Limit ham multipart govdeye uygulanir (sinir + parca basliklari
      // ~10-20 KB ekler), bu yuzden 4 MB dosya icin 4mb yetmez. 4.5mb
      // Vercel Function istek govdesi ust siniriyla da ayni.
      bodySizeLimit: "4.5mb",
    },
  },
};

export default nextConfig;
