import { defineConfig } from "vitest/config";

/**
 * Gercek Postgres gerektiren testler. `services/ingest`'teki
 * `pytest.mark.integration` deseninin vitest karsiligi: ayri config +
 * `*.integration.test.ts` adlandirmasi, boylece duz `pnpm test` hicbir
 * zaman veritabani gerektirmez.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    // Üretim veritabanına bağlanmayı engeller (fail-closed).
    setupFiles: ["../db/src/vitest-isolation-setup.ts"],
  },
});
