import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit YALNIZCA denetim icin kullanilir (`drizzle-kit pull` ile mevcut
 * semayi cekip elle yazilan tanimlarla karsilastirmak).
 *
 * Migration URETMEK icin KULLANILMAZ: migration'lar `migrations/` altinda elle
 * yazilan duz SQL dosyalaridir ve semanin tek kaynagi onlardir. `pull` ciktisi
 * her aylik price_point partition'ini ayri tablo olarak uretecegi icin dogrudan
 * kaynak olarak alinamaz.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle-audit",
  dbCredentials: { url: process.env.DATABASE_URL_OWNER ?? "" },
});
