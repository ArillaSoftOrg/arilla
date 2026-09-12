/**
 * KVKK m.11 "Görüntüleme" hakkı (docs/kvkk.md): "hakkımdaki verileri indir
 * (JSON)". `session`/`auth_token` içeriği (hash'ler) dahil değil - bunlar
 * güvenlik durumu, kullanıcıya anlamlı "hakkımdaki veri" değil.
 */

import {
  alert,
  appUser,
  click,
  type Database,
  product,
  productView,
  savedItem,
  userConsent,
  userSizeProfile,
} from "@arilla/db";
import { desc, eq } from "drizzle-orm";

export class UserNotFoundError extends Error {
  constructor() {
    super("kullanici bulunamadi");
    this.name = "UserNotFoundError";
  }
}

export interface UserDataExport {
  profile: {
    publicId: string;
    email: string;
    displayName: string | null;
    role: string;
    createdAt: Date;
    lastSeenAt: Date | null;
  };
  savedItems: Array<{ productId: number; productTitle: string; savedAt: Date }>;
  alerts: Array<{
    productId: number;
    productTitle: string;
    kind: string;
    targetPrice: number | null;
    sizeNorm: string | null;
    isActive: boolean;
    createdAt: Date;
  }>;
  history: Array<{ productId: number; productTitle: string; viewedAt: Date }>;
  sizeProfile: Array<{ categoryPath: string; sizeNorm: string }>;
  consents: Array<{ kind: string; granted: boolean; grantedAt: Date }>;
  clicks: Array<{
    offerId: number;
    channel: string;
    surface: string | null;
    priceAtClickKurus: number | null;
    createdAt: Date;
  }>;
}

export async function exportUserData(db: Database, userId: number): Promise<UserDataExport> {
  const userRows = await db.select().from(appUser).where(eq(appUser.id, userId)).limit(1);
  const user = userRows[0];
  if (!user) {
    throw new UserNotFoundError();
  }

  const [savedRows, alertRows, historyRows, sizeRows, consentRows, clickRows] = await Promise.all([
    db
      .select({
        productId: savedItem.productId,
        productTitle: product.title,
        savedAt: savedItem.createdAt,
      })
      .from(savedItem)
      .innerJoin(product, eq(product.id, savedItem.productId))
      .where(eq(savedItem.userId, userId)),
    db
      .select({
        productId: alert.productId,
        productTitle: product.title,
        kind: alert.kind,
        targetPrice: alert.targetPrice,
        sizeNorm: alert.sizeNorm,
        isActive: alert.isActive,
        createdAt: alert.createdAt,
      })
      .from(alert)
      .innerJoin(product, eq(product.id, alert.productId))
      .where(eq(alert.userId, userId)),
    db
      .select({
        productId: productView.productId,
        productTitle: product.title,
        viewedAt: productView.viewedAt,
      })
      .from(productView)
      .innerJoin(product, eq(product.id, productView.productId))
      .where(eq(productView.userId, userId))
      .orderBy(desc(productView.viewedAt)),
    db
      .select({ categoryPath: userSizeProfile.categoryPath, sizeNorm: userSizeProfile.sizeNorm })
      .from(userSizeProfile)
      .where(eq(userSizeProfile.userId, userId)),
    db
      .select({
        kind: userConsent.kind,
        granted: userConsent.granted,
        grantedAt: userConsent.grantedAt,
      })
      .from(userConsent)
      .where(eq(userConsent.userId, userId))
      .orderBy(desc(userConsent.grantedAt)),
    db
      .select({
        offerId: click.offerId,
        channel: click.channel,
        surface: click.surface,
        priceAtClickKurus: click.priceAtClick,
        createdAt: click.createdAt,
      })
      .from(click)
      .where(eq(click.userId, userId))
      .orderBy(desc(click.createdAt)),
  ]);

  return {
    profile: {
      publicId: user.publicId,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      createdAt: user.createdAt,
      lastSeenAt: user.lastSeenAt,
    },
    savedItems: savedRows,
    alerts: alertRows,
    history: historyRows,
    sizeProfile: sizeRows,
    consents: consentRows,
    clicks: clickRows,
  };
}
