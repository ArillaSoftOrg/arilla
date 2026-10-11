import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // IP/e-posta takma adi (`pseudonymize`) bir sir ister; yalnizca test degeri.
    env: { SESSION_SECRET: "core-birim-testi-yalnizca-yerel-sir-degil" },
    // Gercek Postgres gerektiren testler ayri config'te (vitest.integration.config.ts).
    exclude: ["**/node_modules/**", "**/*.integration.test.ts"],
  },
});
