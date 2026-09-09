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
  transpilePackages: ["@arilla/core", "@arilla/ui"],
};

export default nextConfig;
