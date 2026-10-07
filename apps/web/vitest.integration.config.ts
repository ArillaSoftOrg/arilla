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
    // Üretim veritabanına bağlanmayı engeller (fail-closed).
    setupFiles: ["../../packages/db/src/vitest-isolation-setup.ts"],
    // Yalnızca test sürecinde token özetlemek için; gerçek bir sır değildir.
    env: { SESSION_SECRET: "yonetim-yetki-testi-yalnizca-yerel" },
    // Yayında tek onboarding formu kısıtı (karar 0058): onboarding testleri aynı anda koşmaz.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
