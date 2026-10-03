/**
 * Erken erisim listesi (`early_access`, 0031). Kullanici basina tek satir.
 *
 * Kayit her basarili giriste `createSessionForUser` icinden, giris
 * isleminin kendisiyle ayni transaction'da yazilir: e-posta, Google, Apple
 * ve telefon ayni yoldan gecer. `ON CONFLICT (user_id) DO NOTHING`:
 * tekrar giris ve esanli iki giris ikinci satiri olusturmaz, hata da
 * vermez. Mevcut kullanici ilk kez giris yaptiginda da kayit acilir.
 */
import { type Database, type EarlyAccessStatus, earlyAccess } from "@arilla/db";
import { eq } from "drizzle-orm";

export async function ensureEarlyAccess(
  db: Pick<Database, "insert">,
  userId: number,
): Promise<void> {
  await db
    .insert(earlyAccess)
    .values({ userId })
    .onConflictDoNothing({ target: earlyAccess.userId });
}

export interface EarlyAccessView {
  status: EarlyAccessStatus;
  createdAt: Date;
}

export async function getEarlyAccess(
  db: Pick<Database, "select">,
  userId: number,
): Promise<EarlyAccessView | null> {
  const rows = await db
    .select({ status: earlyAccess.status, createdAt: earlyAccess.createdAt })
    .from(earlyAccess)
    .where(eq(earlyAccess.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}
