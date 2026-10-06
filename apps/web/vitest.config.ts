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
    include: ["*.test.ts", "app/**/*.test.ts"],
    exclude: ["**/*.integration.test.ts", "**/node_modules/**"],
  },
});
