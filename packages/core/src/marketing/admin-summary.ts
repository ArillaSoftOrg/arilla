/**
 * Yönetim konsolu için salt okunur pazarlama e-postası özeti. Adres, IP ve
 * token içermez; çağıran (`admin/users.ts`) yetkiyi ve denetim kaydını
 * sağlar.
 */
import { emailSuppression, marketingEmailSend } from "@arilla/db";
import { and, count, desc, eq } from "drizzle-orm";
import { isDemonstrableOptIn, loadMarketingFacts, type Tx } from "./eligibility.ts";
import { emailHash, normalizeEmail } from "./email-hash.ts";

export interface MarketingEmailAdminSummary {
  /** Gösterilebilir, bastırılmamış, güncel adrese ait rıza. */
  optedIn: boolean;
  latest: {
    granted: boolean;
    source: string | null;
    textVersion: string | null;
    at: Date;
    /** 0033 öncesi sürümsüz satır: gösterilebilir rıza sayılmaz. */
    legacy: boolean;
  } | null;
  /** Güncel adresin en son bastırma kaydı. */
  lastSuppression: { reason: string; at: Date } | null;
  externalSyncStatus: "pending" | "synced" | "failed" | null;
  sentCount: number;
}

export async function getMarketingEmailAdminSummary(
  tx: Tx,
  userId: number,
): Promise<MarketingEmailAdminSummary> {
  const facts = await loadMarketingFacts(tx, userId);
  const email = facts.user?.email ?? null;

  const suppression = email
    ? ((
        await tx
          .select({ reason: emailSuppression.reason, at: emailSuppression.createdAt })
          .from(emailSuppression)
          .where(
            and(
              eq(emailSuppression.emailHash, emailHash(email)),
              eq(emailSuppression.channel, "marketing"),
            ),
          )
          .orderBy(desc(emailSuppression.createdAt))
          .limit(1)
      )[0] ?? null)
    : null;

  const sent = await tx
    .select({ n: count() })
    .from(marketingEmailSend)
    .where(and(eq(marketingEmailSend.userId, userId), eq(marketingEmailSend.status, "sent")));

  const latest = facts.latest;
  const demonstrable = isDemonstrableOptIn(latest);
  return {
    optedIn:
      demonstrable &&
      !facts.suppressed &&
      Boolean(email && latest?.email && normalizeEmail(latest.email) === normalizeEmail(email)),
    latest: latest
      ? {
          granted: latest.granted,
          source: latest.source,
          textVersion: latest.textVersion,
          at: latest.grantedAt,
          legacy: latest.textVersion === null,
        }
      : null,
    lastSuppression: suppression,
    externalSyncStatus: facts.externalSyncStatus,
    sentCount: sent[0]?.n ?? 0,
  };
}
