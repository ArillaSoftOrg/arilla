/**
 * Veritabani baglantisi.
 *
 * `DATABASE_URL` UYGULAMA rolunu (`arilla_app`) gosterir. O rol superuser
 * degildir ve `price_point` ile `variant_stock_event` uzerinde yalnizca SELECT
 * ve INSERT yetkisine sahiptir — append-only kurali motor tarafindan zorlanir.
 * Migration ve bakim betikleri `DATABASE_URL_OWNER` kullanir, uygulama asla.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema/index.ts";

export type Database = ReturnType<typeof createDatabase>;

export function createDatabase(connectionString: string) {
  return drizzle(new Pool({ connectionString }), { schema });
}

let cached: Database | undefined;

/** Surec basina tek havuz. Serverless soguk baslangicta yeniden kurulur. */
export function getDatabase(): Database {
  if (cached) return cached;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL tanimli degil. .env.example dosyasina bakin.");
  }
  cached = createDatabase(connectionString);
  return cached;
}
