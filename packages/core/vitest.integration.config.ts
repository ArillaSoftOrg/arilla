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
    // Hepsi ayni yalitilmis veritabanini paylasir ve fixture'lari birbirinin sonucunu
    // etkileyebilir (ornegin "iphone 17" baslikli urunler): dosyalar sirayla kosar.
    fileParallelism: false,
    // Üretim veritabanına bağlanmayı engeller (fail-closed).
    setupFiles: ["../db/src/vitest-isolation-setup.ts"],
  },
});
