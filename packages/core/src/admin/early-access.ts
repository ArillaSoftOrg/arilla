/**
 * `/yonetim/kullanicilar` icindeki erken erisim ozeti: SALT OKUNUR, yalnizca
 * yonetici (`users.read`). CRM degil: sayilar ve son kayitlar.
 *
 * Listede kisisel iletisim bilgisi yok: e-posta/telefon degil, yalnizca
 * `public_id` (ayrintisi mevcut, denetime yazilan kullanici sayfasinda).
 */

import type { Database } from "@arilla/db";
import { appUser, type EarlyAccessStatus, earlyAccess } from "@arilla/db";
import { count, desc, eq, gte, sql } from "drizzle-orm";
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

/**
 * `/yonetim/erken-erisim` başvuru listesi (karar 0086). SALT OKUNUR:
 * `early_access.status` bugün yalnızca `pending` alabilir (CHECK); erişim verme
 * ya da durum değiştirme yok (onaylı yetenek ve iş akışı gerektirir).
 * Kişisel iletişim bilgisi yok: yalnızca hesabın public kimliği.
 * Sayfalama imleçli (`created_at DESC, user_id DESC`). İmleç yalnızca son
 * satırın `user_id`'si: zaman karşılaştırması o satırın veritabanındaki TAM
 * değeriyle yapılır (JS `Date` milisaniyedir, `timestamptz` mikrosaniye;
 * zaman imleci aynı milisaniyedeki satırları atlardı).
 */
export const EARLY_ACCESS_PAGE_SIZE = 50;

export interface EarlyAccessApplication {
  publicId: string;
  status: EarlyAccessStatus;
  createdAt: Date;
}

export interface EarlyAccessPage {
  rows: EarlyAccessApplication[];
  /** Sonraki sayfa imleci (son satırın hesap kimliği); yoksa null. */
  nextCursor: number | null;
}

export async function listEarlyAccessApplications(
  db: Database,
  actor: AdminActor,
  options: { cursor?: unknown } = {},
): Promise<EarlyAccessPage> {
  assertCapability(actor, "early_access.manage");
  const cursor =
    typeof options.cursor === "number" && Number.isSafeInteger(options.cursor) && options.cursor > 0
      ? options.cursor
      : null;
  return readOnly(db, 5_000, async (tx) => {
    const rows = await tx
      .select({
        userId: earlyAccess.userId,
        publicId: appUser.publicId,
        status: earlyAccess.status,
        createdAt: earlyAccess.createdAt,
      })
      .from(earlyAccess)
      .innerJoin(appUser, eq(appUser.id, earlyAccess.userId))
      .where(
        cursor
          ? sql`(${earlyAccess.createdAt}, ${earlyAccess.userId}) <
                (SELECT c.created_at, c.user_id FROM early_access c WHERE c.user_id = ${cursor})`
          : undefined,
      )
      .orderBy(desc(earlyAccess.createdAt), desc(earlyAccess.userId))
      .limit(EARLY_ACCESS_PAGE_SIZE + 1);
    const hasMore = rows.length > EARLY_ACCESS_PAGE_SIZE;
    const page = hasMore ? rows.slice(0, EARLY_ACCESS_PAGE_SIZE) : rows;
    const last = page[page.length - 1];
    return {
      rows: page.map(({ publicId, status, createdAt }) => ({ publicId, status, createdAt })),
      nextCursor: hasMore && last ? last.userId : null,
    };
  });
}
