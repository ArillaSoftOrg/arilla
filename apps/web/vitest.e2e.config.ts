import { defineConfig } from "vitest/config";

/**
 * Güvenlik/kimlik E2E (karar 0050, P4): çalışan bir `next start`'a gerçek
 * HTTP istekleri. Oturumlar yerel veritabanına doğrudan yazılır (OAuth
 * sağlayıcısına gidilmez). Sunucu ve test AYNI `SESSION_SECRET` ve AYNI
 * yerel veritabanını kullanmalı; uzak adres görülürse test durur.
 *
 *   E2E_BASE_URL=http://localhost:3312 pnpm --filter @arilla/web test:e2e
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["e2e/**/*.e2e.test.ts"],
    setupFiles: ["../../packages/db/src/vitest-isolation-setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
