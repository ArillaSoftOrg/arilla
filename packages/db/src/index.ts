/**
 * Semanin tek sahibi. Migration'lar `migrations/` altindadir ve yalnizca bu
 * paket uretir; Python tarafi okur ve yazar ama migration uretmez.
 *
 * Append-only kurallari veritabani yetkileriyle zorlanir, bkz.
 * `migrations/0010_append_only_grants.sql`.
 */

export { createDatabase, type Database, getDatabase } from "./client.ts";
export * as schema from "./schema/index.ts";
export * from "./schema/index.ts";
export * from "./types.ts";

/** Migration dosyalarinin bu paket kokune gore konumu. */
export const MIGRATIONS_DIR = "migrations";
