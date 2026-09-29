/**
 * Pazarlama e-postası rızasının TEK yazım yolu (docs/decisions/0046).
 * `account/consent.ts`'teki genel `setConsent` bu türü reddeder.
 *
 * - Her değişiklik `user_consent`'e YENİ satırdır (tablo veritabanında
 *   append-only). Satır kaynak, metin sürümü ve o anki adresi taşır.
 * - Adres ve metin sürümü sunucuda belirlenir; istemci yalnızca "aç/kapat"
 *   der, kimliği oturumdan gelir.
 * - Aynı durumu tekrar yazmak (çift tık, yeniden deneme) yeni olay üretmez.
 * - Adresi olan her olay için İYS senkron satırı `pending` açılır. İYS
 *   entegrasyonu yokken satır öyle kalır; yerel durum yine anında geçerlidir.
 */
import { appUser, consentExternalSync, type Database, userConsent } from "@arilla/db";
import { eq } from "drizzle-orm";
import {
  MARKETING_EMAIL_CONSENT_TEXT,
  MARKETING_OPT_IN_SOURCES,
  MARKETING_OPT_OUT_SOURCES,
  type MarketingOptInSource,
  type MarketingOptOutSource,
} from "./consent-text.ts";
import {
  isDemonstrableOptIn,
  isSuppressedSince,
  latestMarketingConsent,
  lockMarketingSubject,
  type Tx,
} from "./eligibility.ts";
import { emailHash, normalizeEmail } from "./email-hash.ts";

export class MarketingConsentError extends Error {
  readonly code: "no_user" | "no_email" | "invalid_source" | "invalid_time";
  constructor(code: MarketingConsentError["code"]) {
    super(`Pazarlama rizasi yazilamadi (${code}).`);
    this.name = "MarketingConsentError";
    this.code = code;
  }
}

export type RecordMarketingConsentInput =
  | {
      userId: number;
      granted: true;
      source: MarketingOptInSource;
      ip: string | null;
      /**
       * Yalnızca `admin_import`: rızanın gerçekte verildiği an. Geçmiş tarih
       * sonraki bir iptali EZEMEZ (bastırma ve güncel durum `granted_at`
       * sırasıyla değerlendirilir).
       */
      consentedAt?: Date;
    }
  | { userId: number; granted: false; source: MarketingOptOutSource; ip: string | null };

export interface MarketingEmailPreference {
  /** Sunucu durumunda gösterilebilir, bastırılmamış, güncel adrese ait rıza. */
  optedIn: boolean;
  /** Adresi olmayan (telefon, e-postasız Apple) hesap rıza veremez. */
  hasEmail: boolean;
  /** Son olayın rıza anı; hiç olay yoksa null. */
  changedAt: Date | null;
}

async function preferenceIn(db: Database | Tx, userId: number): Promise<MarketingEmailPreference> {
  const user = (
    await db.select({ email: appUser.email }).from(appUser).where(eq(appUser.id, userId)).limit(1)
  )[0];
  if (!user) throw new MarketingConsentError("no_user");
  const latest = await latestMarketingConsent(db, userId);
  if (!user.email || !latest || !isDemonstrableOptIn(latest)) {
    return { optedIn: false, hasEmail: Boolean(user.email), changedAt: latest?.grantedAt ?? null };
  }
  const sameAddress = normalizeEmail(latest.email as string) === normalizeEmail(user.email);
  const suppressed = await isSuppressedSince(db, emailHash(user.email), latest.grantedAt);
  return { optedIn: sameAddress && !suppressed, hasEmail: true, changedAt: latest.grantedAt };
}

export function getMarketingEmailPreference(
  db: Database,
  userId: number,
): Promise<MarketingEmailPreference> {
  return preferenceIn(db, userId);
}

export interface RecordMarketingConsentResult {
  /** false: istenen durum zaten geçerliydi, yeni olay yazılmadı. */
  changed: boolean;
  consentId: number | null;
  preference: MarketingEmailPreference;
}

/** Aynı işlem içinde çağrılabilsin diye (abonelik iptali) `Tx` alan çekirdek. */
export async function recordMarketingConsentIn(
  tx: Tx,
  input: RecordMarketingConsentInput,
): Promise<RecordMarketingConsentResult> {
  if (input.granted) {
    if (!(MARKETING_OPT_IN_SOURCES as readonly string[]).includes(input.source)) {
      throw new MarketingConsentError("invalid_source");
    }
    if (input.consentedAt && input.source !== "admin_import") {
      throw new MarketingConsentError("invalid_time");
    }
    if (input.consentedAt && input.consentedAt.getTime() > Date.now()) {
      throw new MarketingConsentError("invalid_time");
    }
  } else if (!(MARKETING_OPT_OUT_SOURCES as readonly string[]).includes(input.source)) {
    throw new MarketingConsentError("invalid_source");
  }

  await lockMarketingSubject(tx, { userId: input.userId });
  const user = (
    await tx
      .select({ email: appUser.email })
      .from(appUser)
      .where(eq(appUser.id, input.userId))
      .limit(1)
  )[0];
  if (!user) throw new MarketingConsentError("no_user");
  if (input.granted && !user.email) throw new MarketingConsentError("no_email");

  const current = await preferenceIn(tx, input.userId);
  const latest = await latestMarketingConsent(tx, input.userId);
  const textVersion = MARKETING_EMAIL_CONSENT_TEXT.version;

  const alreadyInState = input.granted
    ? current.optedIn && latest?.textVersion === textVersion
    : !latest?.granted;
  if (alreadyInState) return { changed: false, consentId: null, preference: current };

  const inserted = await tx
    .insert(userConsent)
    .values({
      userId: input.userId,
      kind: "marketing_email",
      granted: input.granted,
      ip: input.ip,
      source: input.source,
      textVersion: input.granted ? textVersion : null,
      email: user.email,
      ...(input.granted && input.consentedAt ? { grantedAt: input.consentedAt } : {}),
    })
    .returning({ id: userConsent.id });
  const consentId = inserted[0]?.id ?? null;

  if (consentId !== null && user.email) {
    await tx
      .insert(consentExternalSync)
      .values({ consentId, provider: "iys" })
      .onConflictDoNothing();
  }

  return { changed: true, consentId, preference: await preferenceIn(tx, input.userId) };
}

export function recordMarketingEmailConsent(
  db: Database,
  input: RecordMarketingConsentInput,
): Promise<RecordMarketingConsentResult> {
  return db.transaction((tx) => recordMarketingConsentIn(tx, input));
}
