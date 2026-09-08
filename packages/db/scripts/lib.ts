import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

export const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const migrationsDir = join(packageRoot, "migrations");

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

export async function withClient<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
