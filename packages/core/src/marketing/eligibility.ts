/**
 * Pazarlama e-postası uygunluğunun TEK kararı (docs/decisions/0046).
 *
 * Girdi yalnızca sunucu durumudur: kullanıcı kimliği oturumdan ya da
 * kampanya işinden gelir, rıza/bastırma/senkron bilgisi veritabanından okunur.
 * İstemciden gelen hiçbir "izinli" bayrağı bu karara girmez — fonksiyonun
 * böyle bir parametresi yok.
 *
 * `decideMarketingEligibility` saf karar, `loadMarketingFacts` veritabanı
 * okuması. Gönderici ikisini, kilit altında, gönderimden hemen önce çağırır.
 */
import {
  appUser,
  consentExternalSync,
  type Database,
  emailSuppression,
  userConsent,
} from "@arilla/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { emailHash, isDeliverableEmailShape, normalizeEmail } from "./email-hash.ts";
import type { MarketingPolicy } from "./policy.ts";

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Executor = Database | Tx;

export interface MarketingConsentEvent {
  id: number;
  granted: boolean;
  grantedAt: Date;
  source: string | null;
  textVersion: string | null;
  email: string | null;
}

export interface MarketingFacts {
  user: { id: number; email: string | null; emailVerified: boolean } | null;
  /** `granted_at` sırasıyla en son pazarlama rızası olayı. */
  latest: MarketingConsentEvent | null;
  /** Güncel adres için, en son rızadan SONRA (veya aynı anda) yazılmış bastırma var mı. */
  suppressed: boolean;
  /** En son rıza olayının İYS senkron durumu; satır yoksa null. */
  externalSyncStatus: "pending" | "synced" | "failed" | null;
}

export type IneligibleReason =
  | "disabled"
  | "no_user"
  | "no_email"
  | "invalid_email"
  | "email_unverified"
  | "no_consent"
  | "opted_out"
  | "unverifiable_consent"
  | "consent_email_mismatch"
  | "suppressed"
  | "not_allowlisted"
  | "external_sync_pending";

export type MarketingEligibility =
  | { eligible: true; userId: number; email: string; emailHash: string; consentId: number }
  | { eligible: false; reason: IneligibleReason };

/** Gösterilebilir rıza: sürümlü metin, kaynak ve adres dolu `granted` satırı. */
export function isDemonstrableOptIn(event: MarketingConsentEvent | null): boolean {
  return Boolean(event?.granted && event.textVersion && event.source && event.email);
}

export function decideMarketingEligibility(
  facts: MarketingFacts,
  policy: Pick<MarketingPolicy, "mode" | "allowlist" | "requireExternalSync">,
): MarketingEligibility {
  if (policy.mode === "off") return { eligible: false, reason: "disabled" };
  const { user, latest } = facts;
  if (!user) return { eligible: false, reason: "no_user" };
  if (!user.email) return { eligible: false, reason: "no_email" };
  if (!isDeliverableEmailShape(user.email)) return { eligible: false, reason: "invalid_email" };
  if (!user.emailVerified) return { eligible: false, reason: "email_unverified" };
  if (!latest) return { eligible: false, reason: "no_consent" };
  if (!latest.granted) return { eligible: false, reason: "opted_out" };
  // 0033 öncesi (sürümsüz) satır gösterilebilir rıza değildir.
  if (!isDemonstrableOptIn(latest)) return { eligible: false, reason: "unverifiable_consent" };
  if (normalizeEmail(latest.email as string) !== normalizeEmail(user.email)) {
    return { eligible: false, reason: "consent_email_mismatch" };
  }
  if (facts.suppressed) return { eligible: false, reason: "suppressed" };
  if (policy.mode === "allowlist" && !policy.allowlist.has(normalizeEmail(user.email))) {
    return { eligible: false, reason: "not_allowlisted" };
  }
  if (policy.requireExternalSync && facts.externalSyncStatus !== "synced") {
    return { eligible: false, reason: "external_sync_pending" };
  }
  return {
    eligible: true,
    userId: user.id,
    email: user.email,
    emailHash: emailHash(user.email),
    consentId: latest.id,
  };
}

export async function latestMarketingConsent(
  db: Executor,
  userId: number,
): Promise<MarketingConsentEvent | null> {
  const rows = await db
    .select({
      id: userConsent.id,
      granted: userConsent.granted,
      grantedAt: userConsent.grantedAt,
      source: userConsent.source,
      textVersion: userConsent.textVersion,
      email: userConsent.email,
    })
    .from(userConsent)
    .where(and(eq(userConsent.userId, userId), eq(userConsent.kind, "marketing_email")))
    .orderBy(desc(userConsent.grantedAt), desc(userConsent.id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Bastırma yalnızca kendisinden önce verilmiş rızayı geçersiz kılar. Rıza
 * yoksa (`since` null) her bastırma geçerlidir.
 */
export async function isSuppressedSince(
  db: Executor,
  hash: string,
  since: Date | null,
): Promise<boolean> {
  const conditions = [
    eq(emailSuppression.emailHash, hash),
    eq(emailSuppression.channel, "marketing"),
  ];
  if (since) conditions.push(gte(emailSuppression.createdAt, since));
  const rows = await db
    .select({ one: sql<number>`1` })
    .from(emailSuppression)
    .where(and(...conditions))
    .limit(1);
  return rows.length > 0;
}

export async function loadMarketingFacts(db: Executor, userId: number): Promise<MarketingFacts> {
  const user = (
    await db
      .select({ id: appUser.id, email: appUser.email, emailVerifiedAt: appUser.emailVerifiedAt })
      .from(appUser)
      .where(eq(appUser.id, userId))
      .limit(1)
  )[0];
  if (!user) return { user: null, latest: null, suppressed: false, externalSyncStatus: null };

  const latest = await latestMarketingConsent(db, userId);
  const suppressed = user.email
    ? await isSuppressedSince(db, emailHash(user.email), latest?.grantedAt ?? null)
    : false;

  let externalSyncStatus: MarketingFacts["externalSyncStatus"] = null;
  if (latest) {
    const sync = await db
      .select({ status: consentExternalSync.status })
      .from(consentExternalSync)
      .where(
        and(eq(consentExternalSync.consentId, latest.id), eq(consentExternalSync.provider, "iys")),
      )
      .limit(1);
    externalSyncStatus = sync[0]?.status ?? null;
  }

  return {
    user: { id: user.id, email: user.email, emailVerified: user.emailVerifiedAt !== null },
    latest,
    suppressed,
    externalSyncStatus,
  };
}

/**
 * Salt okuma kontrolü (ör. kampanya öncesi sayım). Gönderim bunu DEĞİL,
 * `sendMarketingEmail` içindeki kilitli kontrolü kullanır.
 */
export async function checkMarketingEligibility(
  db: Database,
  userId: number,
  policy: Pick<MarketingPolicy, "mode" | "allowlist" | "requireExternalSync">,
): Promise<MarketingEligibility> {
  return decideMarketingEligibility(await loadMarketingFacts(db, userId), policy);
}

/**
 * Kullanıcı ve adres düzeyinde işlem kilidi. Rıza yazımı, abonelik iptali ve
 * gönderim talebi aynı anahtarlarla, aynı sırayla (önce kullanıcı, sonra
 * adres) kilitler: iptal işlendikten sonra hiçbir gönderim kontrolü eski
 * durumu göremez ve eşzamanlı iki yazım aynı olayı iki kez üretmez.
 */
export async function lockMarketingSubject(
  tx: Tx,
  subject: { userId?: number | null; emailHash?: string | null },
): Promise<void> {
  if (subject.userId != null) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`marketing:user:${subject.userId}`}, 0))`,
    );
  }
  if (subject.emailHash) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`marketing:email:${subject.emailHash}`}, 0))`,
    );
  }
}
