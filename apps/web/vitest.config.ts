import { defineConfig } from "vitest/config";

/**
 * Veritabanı gerektirmeyen web birim testleri (`pnpm test`). Veritabanlı
 * yetki testleri ayrı: `vitest.integration.config.ts`.
 */
export default defineConfig({
  // Bilesen testleri (renderToStaticMarkup) Next'in otomatik JSX calisma zamanini kullanir.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    env: { SESSION_SECRET: "web-birim-testi-yalnizca-yerel-sir-degil" },
    include: ["*.test.ts", "app/**/*.test.ts"],
    exclude: ["**/*.integration.test.ts", "**/node_modules/**"],
  },
});
