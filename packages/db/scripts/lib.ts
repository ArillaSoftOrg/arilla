import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

export const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const migrationsDir = join(packageRoot, "migrations");

/**
 * Uzak veritabanina yazmanin onayi (bkz. `assertRemoteWriteConfirmed`). Yalniz
 * komutla birlikte verilen GERCEK ortamdan okunur; `.env` bu degiskeni asla
 * saglayamaz, yoksa kalici olarak korumayi kapatirdi.
 */
export const REMOTE_CONFIRM_ENV = "ARILLA_CONFIRM_REMOTE_DB";

/** Depo kokundeki .env dosyasini okur. Gercek degerler asla depoya girmez. */
function loadDotEnv(): void {
  for (const candidate of [
    join(packageRoot, "../../.env"),
    join(packageRoot, "../../.env.local"),
  ]) {
    let raw: string;
    try {
      raw = readFileSync(candidate, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (key === undefined || rawValue === undefined) continue;
      if (key === REMOTE_CONFIRM_ENV) continue;
      if (process.env[key] !== undefined) continue;
      process.env[key] = rawValue.trim().replace(/^["']|["']$/g, "");
    }
  }
}

export function requireEnv(name: string, fallback?: string): string {
  loadDotEnv();
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`${name} tanimli degil. .env.example dosyasina bakin.`);
  }
  return value;
}

/** Migration ve bakim islerinin baglantisi — sahip rol (`arilla`). */
export function ownerUrl(): string {
  return requireEnv("DATABASE_URL_OWNER");
}

/**
 * Baglanti yerel gelistirme veritabanina mi gidiyor.
 *
 * Yikici ya da kilit alan islemler bununla korunur: `seed.ts` katalogu
 * silmeden once, `verify-schema.ts` ise ACCESS EXCLUSIVE kilit alan TRUNCATE
 * probunu kosmadan once bakar. Tek yerde durur ki iki betikte ayrismasin.
 */
export function isLocal(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/** `local`: yerel; `confirmed`: uzak ama hedef makine adi acikca onaylandi; `blocked`: durdur. */
export function remoteWriteDecision(
  url: string,
  env: Record<string, string | undefined> = process.env,
): "local" | "confirmed" | "blocked" {
  if (isLocal(url)) return "local";
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "blocked";
  }
  const confirmed = env[REMOTE_CONFIRM_ENV]?.trim().toLowerCase();
  return host !== "" && confirmed === host ? "confirmed" : "blocked";
}

/**
 * Sahip baglantisiyla YAZAN betikler (migration, rol, partition) yerel olmayan
 * bir veritabanina yanlislikla gitmesin: kok `.env` uretim adresini tasiyabilir.
 * Uzak hedefe yazmak icin hedefin makine adi `ARILLA_CONFIRM_REMOTE_DB` ile
 * AYNI komutta verilir (kasitli bir onay; bayrak gibi aliskanlikla yazilmaz).
 * Mesaj makine adini ya da parolayi gostermez.
 */
export function assertRemoteWriteConfirmed(action: string, url: string = ownerUrl()): void {
  const decision = remoteWriteDecision(url);
  if (decision === "blocked") {
    console.error(
      `${action} durduruldu: DATABASE_URL_OWNER yerel olmayan bir veritabanini gosteriyor. ` +
        "Bilerek uzak/uretim veritabanina yazacaksaniz hedefin makine adini " +
        `${REMOTE_CONFIRM_ENV} ile AYNI komutta verin (.env'den okunmaz). ` +
        "Yerel gelistirme icin DATABASE_URL_OWNER'i yerele cevirin (infra/docker-compose.yml).",
    );
    process.exit(1);
  }
  if (decision === "confirmed") {
    console.warn(`UYARI: ${action} yerel olmayan bir veritabanina yaziyor (onaylandi).`);
  }
}

export async function withClient<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
