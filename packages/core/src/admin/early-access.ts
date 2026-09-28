/**
 * `/yonetim/kullanicilar` icindeki erken erisim ozeti: SALT OKUNUR, yalnizca
 * yonetici (`users.read`). CRM degil: sayilar ve son kayitlar.
 *
 * Listede kisisel iletisim bilgisi yok: e-posta/telefon degil, yalnizca
 * `public_id` (ayrintisi mevcut, denetime yazilan kullanici sayfasinda).
 */

import type { Database } from "@arilla/db";
import { appUser, type EarlyAccessStatus, earlyAccess } from "@arilla/db";
import { count, desc, eq, gte } from "drizzle-orm";
import { readOnly } from "./bounds.ts";
import { type AdminActor, assertCapability } from "./capabilities.ts";

export const EARLY_ACCESS_RECENT_LIMIT = 20;

export interface EarlyAccessOverview {
  total: number;
  last7Days: number;
  byStatus: { status: EarlyAccessStatus; count: number }[];
  recent: { publicId: string; status: EarlyAccessStatus; createdAt: Date }[];
}

export async function earlyAccessOverview(
  db: Database,
  actor: AdminActor,
  now: Date = new Date(),
): Promise<EarlyAccessOverview> {
  assertCapability(actor, "users.read");
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  return readOnly(db, 5_000, async (tx) => {
    const byStatus = await tx
      .select({ status: earlyAccess.status, count: count() })
      .from(earlyAccess)
      .groupBy(earlyAccess.status)
      .orderBy(earlyAccess.status);
    const [recentCount] = await tx
      .select({ count: count() })
      .from(earlyAccess)
      .where(gte(earlyAccess.createdAt, weekAgo));
    const recent = await tx
      .select({
        publicId: appUser.publicId,
        status: earlyAccess.status,
        createdAt: earlyAccess.createdAt,
      })
      .from(earlyAccess)
      .innerJoin(appUser, eq(appUser.id, earlyAccess.userId))
      .orderBy(desc(earlyAccess.createdAt))
      .limit(EARLY_ACCESS_RECENT_LIMIT);

    return {
      total: byStatus.reduce((sum, row) => sum + Number(row.count), 0),
      last7Days: Number(recentCount?.count ?? 0),
      byStatus: byStatus.map((row) => ({ status: row.status, count: Number(row.count) })),
      recent,
    };
  });
}
