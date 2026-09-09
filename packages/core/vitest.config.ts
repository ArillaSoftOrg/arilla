import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Gercek Postgres gerektiren testler ayri config'te (vitest.integration.config.ts).
    exclude: ["**/node_modules/**", "**/*.integration.test.ts"],
  },
});
