/**
 * docs/decisions/0001 (Model A): yalnizca creator'in KENDI affiliate hesabi
 * komisyon uretir. `status='active'` disinda (invalid/revoked) hesap yok
 * sayilir.
 */
import { creatorAffiliateAccount, type Database } from "@arilla/db";
import { and, eq } from "drizzle-orm";

export async function findActiveTrackingId(
  db: Database,
  creatorId: number,
  merchantId: number,
): Promise<string | null> {
  const rows = await db
    .select({ trackingId: creatorAffiliateAccount.trackingId })
    .from(creatorAffiliateAccount)
    .where(
      and(
        eq(creatorAffiliateAccount.creatorId, creatorId),
        eq(creatorAffiliateAccount.merchantId, merchantId),
        eq(creatorAffiliateAccount.status, "active"),
      ),
    )
    .limit(1);
  return rows[0]?.trackingId ?? null;
}
