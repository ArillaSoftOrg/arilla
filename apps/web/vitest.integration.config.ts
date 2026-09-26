import { defineConfig } from "vitest/config";

/**
 * `/yonetim` web sınırı testleri: sayfalar ve server action'lar arayüz
 * olmadan doğrudan çağrılır, gerçek yerel Postgres ile. Yalnızca
 * `next/headers` (çerez), `next/navigation` (yönlendirme/404) ve
 * `next/cache` taklit edilir; yetki kodu gerçektir.
 */
export default defineConfig({
  // Next derlerken otomatik JSX kullanır; vitest'e ayrıca söylenir.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["app/**/*.integration.test.ts"],
    // Yalnızca test sürecinde token özetlemek için; gerçek bir sır değildir.
    env: { SESSION_SECRET: "yonetim-yetki-testi-yalnizca-yerel" },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
