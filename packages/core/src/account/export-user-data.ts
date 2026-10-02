/**
 * KVKK m.11 "Görüntüleme" hakkı (docs/kvkk.md): "hakkımdaki verileri indir
 * (JSON)". `session`/`auth_token` içeriği (hash'ler) dahil değil - bunlar
 * güvenlik durumu, kullanıcıya anlamlı "hakkımdaki veri" değil.
 */

import {
  aiSearchCharge,
  alert,
  appUser,
  bonusAccount,
  bonusLedger,
  click,
  type Database,
  earlyAccess,
  marketingCampaign,
  marketingCampaignDelivery,
  product,
  productView,
  referral,
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
    email: string | null;
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
  /** Erken erişim listesi kaydı (0031); listede değilse `null`. */
  earlyAccess: { status: string; joinedAt: Date } | null;
  /** Arama hakları (0047): bonus bakiye, harcamalar, bonus defteri, davetler. */
  searchRights: {
    referralCode: string | null;
    bonusBalance: number;
    searches: Array<{
      operation: string;
      state: string;
      day: string;
      fromDaily: number;
      fromBonus: number;
      createdAt: Date;
    }>;
    bonusLedger: Array<{ reason: string; delta: number; balanceAfter: number; createdAt: Date }>;
    /** Bu hesabin davet edilme kaydi; davet edenin kimligi disa verilmez. */
    invitedBy: { status: string; createdAt: Date } | null;
    invitesSent: Array<{ status: string; createdAt: Date; qualifiedAt: Date | null }>;
  };
  /**
   * Bu hesaba yönelik pazarlama e-postası teslimleri (0035). `state = sent`
   * sağlayıcının kabul ettiği anlamına gelir. İptal token özeti verilmez.
   */
  marketingEmails: Array<{ subject: string; state: string; sentAt: Date | null; createdAt: Date }>;
}

export async function exportUserData(db: Database, userId: number): Promise<UserDataExport> {
  const userRows = await db.select().from(appUser).where(eq(appUser.id, userId)).limit(1);
  const user = userRows[0];
  if (!user) {
    throw new UserNotFoundError();
  }

  const [savedRows, alertRows, historyRows, sizeRows, consentRows, clickRows, earlyRows] =
    await Promise.all([
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
      db
        .select({ status: earlyAccess.status, joinedAt: earlyAccess.createdAt })
        .from(earlyAccess)
        .where(eq(earlyAccess.userId, userId))
        .limit(1),
    ]);

  const marketingRows = await db
    .select({
      subject: marketingCampaign.subject,
      state: marketingCampaignDelivery.state,
      sentAt: marketingCampaignDelivery.sentAt,
      createdAt: marketingCampaignDelivery.createdAt,
    })
    .from(marketingCampaignDelivery)
    .innerJoin(marketingCampaign, eq(marketingCampaign.id, marketingCampaignDelivery.campaignId))
    .where(eq(marketingCampaignDelivery.userId, userId))
    .orderBy(desc(marketingCampaignDelivery.createdAt));

  const [bonusRows, chargeRows, ledgerRows, invitedByRows, invitesSentRows] = await Promise.all([
    db
      .select({ balance: bonusAccount.balance })
      .from(bonusAccount)
      .where(eq(bonusAccount.userId, userId))
      .limit(1),
    db
      .select({
        operation: aiSearchCharge.operation,
        state: aiSearchCharge.state,
        day: aiSearchCharge.day,
        fromDaily: aiSearchCharge.fromDaily,
        fromBonus: aiSearchCharge.fromBonus,
        createdAt: aiSearchCharge.createdAt,
      })
      .from(aiSearchCharge)
      .where(eq(aiSearchCharge.userId, userId))
      .orderBy(desc(aiSearchCharge.createdAt)),
    db
      .select({
        reason: bonusLedger.reason,
        delta: bonusLedger.delta,
        balanceAfter: bonusLedger.balanceAfter,
        createdAt: bonusLedger.createdAt,
      })
      .from(bonusLedger)
      .where(eq(bonusLedger.userId, userId))
      .orderBy(desc(bonusLedger.createdAt), desc(bonusLedger.id)),
    db
      .select({ status: referral.status, createdAt: referral.createdAt })
      .from(referral)
      .where(eq(referral.inviteeUserId, userId))
      .limit(1),
    db
      .select({
        status: referral.status,
        createdAt: referral.createdAt,
        qualifiedAt: referral.qualifiedAt,
      })
      .from(referral)
      .where(eq(referral.inviterUserId, userId))
      .orderBy(desc(referral.createdAt)),
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
    earlyAccess: earlyRows[0] ?? null,
    searchRights: {
      referralCode: user.referralCode,
      bonusBalance: bonusRows[0]?.balance ?? 0,
      searches: chargeRows,
      bonusLedger: ledgerRows,
      invitedBy: invitedByRows[0] ?? null,
      invitesSent: invitesSentRows,
    },
    marketingEmails: marketingRows,
  };
}
