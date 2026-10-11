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
import { assertIsolatedTestUrl, isTestRuntime } from "./test-isolation.ts";

export type Database = ReturnType<typeof createDatabase>;

/**
 * Serverless (Vercel) ortaminda her fonksiyon ornegi kendi havuzunu acar;
 * pg'nin varsayilan 10 baglantisi Supabase pooler istemci sinirini hizla
 * doldurur. Kucuk, ortamdan ayarlanabilir bir ust sinir ve bos baglantilarin
 * hizla kapanmasi. SSL ayari baglanti adresinden gelir (ör. `sslmode`).
 *
 * Uretimde `DATABASE_URL` Supabase TRANSACTION pooler'ini (port 6543) gostermelidir:
 * Session pooler (5432) her istemci baglantisina bir sunucu baglantisi ayirir ve
 * kucuk `pool_size` (15) ile `EMAXCONNSESSION` uretir. Kod transaction moduyla
 * uyumludur: adlandirilmis prepared statement, LISTEN ve oturum duzeyi advisory
 * lock kullanilmaz (yalniz `pg_advisory_xact_lock`). Migration ve bakim betikleri
 * `DATABASE_URL_OWNER` ile dogrudan/session baglantisini kullanir, bu havuzu degil.
 */
const DEFAULT_POOL_MAX = 3;
const IDLE_TIMEOUT_MS = 5_000;

function poolMaxFromEnv(): number {
  const raw = process.env.DATABASE_POOL_MAX;
  if (raw === undefined || raw.trim() === "") return DEFAULT_POOL_MAX;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("DATABASE_POOL_MAX pozitif bir tamsayi olmali.");
  }
  return value;
}

export function createDatabase(connectionString: string) {
  // Test sürecinde uzak/üretim adresine bağlanma (fail-closed, bkz. test-isolation.ts).
  if (isTestRuntime()) assertIsolatedTestUrl("DATABASE_URL", connectionString);
  return drizzle(
    new Pool({
      connectionString,
      max: poolMaxFromEnv(),
      idleTimeoutMillis: IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: 10_000,
    }),
    { schema },
  );
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
