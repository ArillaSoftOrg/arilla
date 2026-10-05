/**
 * Hesaba bağlı rıza kayıtları (docs/decisions/0049 §6-§8). Sunucu tarafıdır;
 * istemci yalnızca `cookie-consent.ts`'i (saf) içe aktarır.
 *
 * Tek kaynak `user_consent`: güncel durum, her tür için en son satırdır
 * (`granted_at DESC, id DESC`). Kod yalnızca satır ekler. Mevcut satırlar
 * (`text_version` NULL) GEÇERLİDİR; yalnızca "sürümsüz kayıt" diye etiketlenir.
 *
 * - Girişli kullanıcı çerez bandında karar verince karar hesaba da yazılır
 *   (`cookie_banner`).
 * - Girişte, tarayıcıdaki geçerli çerez kararı hesapta daha yeni bir karar
 *   yoksa hesaba aktarılır (`cookie_sync`; `granted_at` = çerezin karar anı).
 *   Bu uydurma değildir: çerez, o tarayıcıdaki gerçek bir karardır.
 * - Analitik rızası `false` olarak yazılınca AYNI işlemde kişiye bağlı
 *   analitik geçmişi silinir ve sayaçlar NULL olur.
 * - `privacy_notice` bir RIZA DEĞİLDİR: girişte gösterilen aydınlatma
 *   (gizlilik) metninin sürümünün kaydıdır. Hiçbir işleme ona dayanmaz.
 */
import {
  type CookieConsentKind,
  type Database,
  type UserConsentKind,
  type UserConsentSource,
  userConsent,
} from "@arilla/db";
import { sql } from "drizzle-orm";
import { clearAnalyticsData } from "../activity/summary.ts";
import {
  CONSENT_VERSION,
  type CookieConsent,
  OPTIONAL_CONSENT_CATEGORIES,
  type OptionalConsentCategory,
} from "./cookie-consent.ts";

/** `user_consent.text_version` değeri: çerez kategori/politika sürümü. */
export const COOKIE_CONSENT_TEXT_VERSION = `cookie-v${CONSENT_VERSION}`;

/**
 * Giriş ekranında bağlantısı gösterilen gizlilik/aydınlatma metninin
 * sürümü. `apps/web/app/legal-identity-block.tsx` `LEGAL_EFFECTIVE_LABEL`
 * ile aynı tarih; metin değişince ikisi birlikte güncellenir.
 */
export const PRIVACY_NOTICE_VERSION = "2026-10-03";

export const COOKIE_CONSENT_KIND: Readonly<Record<OptionalConsentCategory, CookieConsentKind>> = {
  functional: "cookie_functional",
  analytics: "cookie_analytics",
  marketing: "cookie_marketing",
};

export interface LatestConsentRow {
  kind: UserConsentKind;
  granted: boolean;
  grantedAt: Date;
  source: UserConsentSource | null;
  textVersion: string | null;
}

type Executor = Pick<Database, "execute">;

/** Tür başına en son satır (`granted_at DESC, id DESC`, `user_consent_latest_idx`). */
export async function getLatestConsents(
  db: Executor,
  userId: number,
  kinds: readonly UserConsentKind[],
): Promise<Map<UserConsentKind, LatestConsentRow>> {
  const result = await db.execute(sql`
    SELECT DISTINCT ON (kind) kind, granted, granted_at, source, text_version
      FROM user_consent
     WHERE user_id = ${userId}
       AND kind IN (${sql.join(
         kinds.map((kind) => sql`${kind}`),
         sql`, `,
       )})
     ORDER BY kind, granted_at DESC, id DESC
  `);
  const map = new Map<UserConsentKind, LatestConsentRow>();
  for (const row of result.rows as {
    kind: UserConsentKind;
    granted: boolean;
    granted_at: string | Date;
    source: UserConsentSource | null;
    text_version: string | null;
  }[]) {
    map.set(row.kind, {
      kind: row.kind,
      granted: row.granted,
      grantedAt: new Date(row.granted_at),
      source: row.source,
      textVersion: row.text_version,
    });
  }
  return map;
}

/** Aynı kullanıcı için eşzamanlı iki rıza kararı birbirinin önünü kesmez. */
function consentLockSql(userId: number) {
  return sql`SELECT pg_advisory_xact_lock(hashtext('user_consent:cookie'), ${userId}::int)`;
}

export interface CookieDecisionResult {
  written: OptionalConsentCategory[];
  analyticsRevoked: boolean;
  eventsDeleted: number;
}

/**
 * Çerez kararını hesaba yazar. Değişmeyen kategori için satır yazılmaz.
 * `cookie_sync`'te hesapta daha yeni (ya da aynı anlı) bir karar varsa o
 * kategori atlanır: eski bir tarayıcı çerezi yeni bir hesap kararını ezemez.
 */
export async function recordCookieDecision(
  db: Database,
  input: { userId: number; consent: CookieConsent; source: "cookie_banner" | "cookie_sync" },
  now: Date = new Date(),
): Promise<CookieDecisionResult> {
  const decidedMs = Date.parse(input.consent.updatedAt);
  if (Number.isNaN(decidedMs)) throw new Error("gecersiz cerez karar zamani");
  // Gelecekteki zaman damgası (saat kayması) "en son" sırasını bozmasın.
  const decidedAt = new Date(Math.min(decidedMs, now.getTime()));

  return db.transaction(async (tx) => {
    await tx.execute(consentLockSql(input.userId));
    const latest = await getLatestConsents(tx, input.userId, Object.values(COOKIE_CONSENT_KIND));
    const written: OptionalConsentCategory[] = [];
    let analyticsRevoked = false;
    let eventsDeleted = 0;

    for (const category of OPTIONAL_CONSENT_CATEGORIES) {
      const kind = COOKIE_CONSENT_KIND[category];
      const granted = input.consent[category] === true;
      const previous = latest.get(kind);
      if (input.source === "cookie_sync" && previous && previous.grantedAt >= decidedAt) continue;
      if (previous && previous.granted === granted) continue;

      await tx.insert(userConsent).values({
        userId: input.userId,
        kind,
        granted,
        grantedAt: decidedAt,
        source: input.source,
        textVersion: COOKIE_CONSENT_TEXT_VERSION,
        ip: null,
      });
      written.push(category);

      if (category === "analytics" && !granted) {
        analyticsRevoked = previous?.granted === true;
        // Ret ya da geri alma: kişiye bağlı analitik geçmişi kalmaz.
        ({ eventsDeleted } = await clearAnalyticsData(tx, input.userId));
      }
    }
    return { written, analyticsRevoked, eventsDeleted };
  });
}

/**
 * Etkin analitik rızası (0049 §7). Muhafazakâr:
 * - O istekteki çerez geçerli ve güncel sürümde `analytics = true` olmalı.
 * - Hesapta o çerez kararından DAHA YENİ bir `cookie_analytics = false`
 *   satırı olmamalı (başka cihazdan geri alma).
 * Çerez yok, sürüm eski, bozuk ya da `false` → izin yok.
 */
export function effectiveAnalyticsConsent(
  cookie: CookieConsent | null,
  accountLatest: Pick<LatestConsentRow, "granted" | "grantedAt"> | null | undefined,
): boolean {
  if (!cookie || cookie.version !== CONSENT_VERSION || cookie.analytics !== true) return false;
  const cookieAt = Date.parse(cookie.updatedAt);
  if (Number.isNaN(cookieAt)) return false;
  if (accountLatest && !accountLatest.granted && accountLatest.grantedAt.getTime() > cookieAt) {
    return false;
  }
  return true;
}

export async function isAnalyticsAllowed(
  db: Executor,
  userId: number,
  cookie: CookieConsent | null,
): Promise<boolean> {
  // Çerez izin vermiyorsa veritabanına hiç gidilmez.
  if (!effectiveAnalyticsConsent(cookie, null)) return false;
  const latest = await getLatestConsents(db, userId, ["cookie_analytics"]);
  return effectiveAnalyticsConsent(cookie, latest.get("cookie_analytics"));
}

/**
 * Girişte gösterilen gizlilik/aydınlatma metninin sürümünü kaydeder. Bu
 * sürüm zaten kayıtlıysa satır yazılmaz. `granted = true` burada "gösterildi"
 * anlamındadır, rıza değildir.
 */
export async function recordPrivacyNoticeShown(
  db: Database,
  userId: number,
  now: Date = new Date(),
): Promise<boolean> {
  const latest = await getLatestConsents(db, userId, ["privacy_notice"]);
  if (latest.get("privacy_notice")?.textVersion === PRIVACY_NOTICE_VERSION) return false;
  await db.insert(userConsent).values({
    userId,
    kind: "privacy_notice",
    granted: true,
    grantedAt: now,
    source: "sign_in",
    textVersion: PRIVACY_NOTICE_VERSION,
    ip: null,
  });
  return true;
}

/**
 * Başarılı girişten sonra (oturum işlemi kapandıktan sonra) çağrılır:
 * tarayıcının çerez kararı hesaba aktarılır ve aydınlatma sürümü kaydedilir.
 */
export async function syncConsentOnSignIn(
  db: Database,
  input: { userId: number; cookie: CookieConsent | null },
): Promise<void> {
  if (input.cookie && input.cookie.version === CONSENT_VERSION) {
    await recordCookieDecision(db, {
      userId: input.userId,
      consent: input.cookie,
      source: "cookie_sync",
    });
  }
  await recordPrivacyNoticeShown(db, input.userId);
}

// ---------------------------------------------------------------------------
// Durum türetme (yönetim ekranı, `/hesap`)
// ---------------------------------------------------------------------------

export type ConsentStatus = "accepted" | "rejected" | "revoked" | "unknown";

export interface ConsentHistoryRow {
  kind: UserConsentKind;
  granted: boolean;
  grantedAt: Date;
  source: UserConsentSource | null;
  textVersion: string | null;
}

export interface ConsentKindState {
  kind: UserConsentKind;
  status: ConsentStatus;
  /** En son satırın zamanı; kayıt yoksa `null`. */
  at: Date | null;
  /** En son satır sürüm bilgisi taşımıyor (0037 öncesi). Durumu DEĞİŞTİRMEZ. */
  versionless: boolean;
  textVersion: string | null;
  source: UserConsentSource | null;
}

/**
 * Bir türün geçmişinden güncel durum. `rows` herhangi bir sırada olabilir.
 * - kayıt yok → `unknown` (işleme açısından izin yok)
 * - son satır true → `accepted`
 * - son satır false, öncesinde true var → `revoked`
 * - son satır false, öncesinde true yok → `rejected`
 */
export function deriveConsentState(
  kind: UserConsentKind,
  rows: readonly (ConsentHistoryRow & { id?: number })[],
): ConsentKindState {
  const own = rows
    .filter((row) => row.kind === kind)
    .slice()
    .sort((a, b) => {
      const byTime = b.grantedAt.getTime() - a.grantedAt.getTime();
      return byTime !== 0 ? byTime : (b.id ?? 0) - (a.id ?? 0);
    });
  const latest = own[0];
  if (!latest) {
    return {
      kind,
      status: "unknown",
      at: null,
      versionless: false,
      textVersion: null,
      source: null,
    };
  }
  let status: ConsentStatus;
  if (latest.granted) status = "accepted";
  else status = own.slice(1).some((row) => row.granted) ? "revoked" : "rejected";
  return {
    kind,
    status,
    at: latest.grantedAt,
    versionless: latest.textVersion === null,
    textVersion: latest.textVersion,
    source: latest.source,
  };
}
