/**
 * Suresi dolmus giris kayitlarinin temizligi (`/api/cron/cleanup-auth`,
 * gunde bir). Idempotent: ayni esikle ikinci calistirma hicbir sey silmez.
 *
 * Esik: `expires_at < now - 1 gun`. Bir gunluk pay, yeni dolmus bir
 * baglanti/kodun "suresi dolmus" yanitini (kullanilmis/bulunamadi yerine)
 * vermeye devam etmesini saglar. `admin/operations.ts` `complianceHealth`
 * ayni esikle "temizlenmemis" kayit sayar; bu is onu sifira indirir.
 *
 * docs/kvkk.md: token 15 dk, oturum 90 gun gecerli; IP en fazla 1 yil.
 * Suresi dolmus kaydi erken silmek bu tavanlarin altinda kalir.
 *
 * Silme sinirli partilerle yapilir: tek bir DELETE buyuk bir birikimde
 * tabloyu uzun sure kilitlemesin ve fonksiyon zaman asimina ugramasin.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";

export const AUTH_CLEANUP_GRACE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 5_000;
const DEFAULT_MAX_BATCHES = 20;

export interface AuthCleanupResult {
  authTokens: number;
  phoneLoginCodes: number;
  sessions: number;
  /** Parti tavanina ulasildi; kalan kayitlar bir sonraki calistirmada silinir. */
  truncated: boolean;
}

export interface AuthCleanupOptions {
  now?: Date;
  batchSize?: number;
  maxBatches?: number;
}

type CleanupTable = "auth_token" | "phone_login_code" | "session";

async function deleteExpired(
  db: Database,
  table: CleanupTable,
  cutoff: Date,
  batchSize: number,
  maxBatches: number,
): Promise<{ deleted: number; truncated: boolean }> {
  const tableSql = sql.identifier(table);
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const result = await db.execute(sql`
      DELETE FROM ${tableSql}
       WHERE id IN (
         SELECT id FROM ${tableSql}
          WHERE expires_at < ${cutoff.toISOString()}::timestamptz
          LIMIT ${batchSize}
       )
    `);
    const count = result.rowCount ?? 0;
    deleted += count;
    if (count < batchSize) return { deleted, truncated: false };
  }
  return { deleted, truncated: true };
}

export async function cleanupExpiredAuthRecords(
  db: Database,
  options: AuthCleanupOptions = {},
): Promise<AuthCleanupResult> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - AUTH_CLEANUP_GRACE_MS);
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? DEFAULT_MAX_BATCHES;

  const tokens = await deleteExpired(db, "auth_token", cutoff, batchSize, maxBatches);
  const codes = await deleteExpired(db, "phone_login_code", cutoff, batchSize, maxBatches);
  const sessions = await deleteExpired(db, "session", cutoff, batchSize, maxBatches);

  return {
    authTokens: tokens.deleted,
    phoneLoginCodes: codes.deleted,
    sessions: sessions.deleted,
    truncated: tokens.truncated || codes.truncated || sessions.truncated,
  };
}
