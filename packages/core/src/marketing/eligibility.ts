/**
 * Pazarlama e-postası alıcı uygunluğunun TEK tanımı (docs/decisions/0048).
 *
 * Aynı SQL sınıflandırması üç yerde kullanılır; kural başka yerde
 * tekrarlanmaz:
 * 1. Önizleme sayımı (`getRecipientPreview`): yalnızca toplam sayılar.
 * 2. Gönderim başlangıcı: `eligible` olanlar için teslim satırı açılır.
 * 3. Gönderim ANI (`classifyRecipient`): her alıcı, ileti gönderilmeden
 *    hemen önce yeniden sınıflandırılır. Önizleme ya da başlangıçtaki sonuç
 *    bir adresi kalıcı olarak yetkilendirmez; arada rızasını geri alan
 *    kişiye ileti gitmez.
 *
 * Kurallar (ilk tutan neden kazanır):
 * - `no_email`: hesapta e-posta yok (telefon/Apple girişi, 0025).
 * - `invalid_email`: biçim geçersiz ya da 254 karakterden uzun.
 * - `unverified_email`: `email_verified_at` boş.
 * - `no_consent`: `marketing_email` rızası hiç verilmemiş (opt-in, kvkk.md).
 * - `consent_revoked`: en son rıza satırı ret (`/hesap` ya da iptal bağlantısı).
 * - `duplicate_email`: aynı adresi (harf duyarsız) taşıyan, kendisi uygun ve
 *   `id`'si daha küçük başka bir hesap var; adres başına tek ileti.
 * - `eligible`.
 *
 * Güncel rıza = `user_consent`'te `kind = 'marketing_email'` olan en son satır
 * (`granted_at DESC, id DESC`) — `account/consent.ts` ile aynı tanım. İkinci
 * bir abonelik bayrağı yoktur.
 */
import type { Database } from "@arilla/db";
import { type SQL, sql } from "drizzle-orm";
import { type AdminActor, assertCapability } from "../admin/capabilities.ts";

export type RecipientReason =
  | "eligible"
  | "no_email"
  | "invalid_email"
  | "unverified_email"
  | "no_consent"
  | "consent_revoked"
  | "duplicate_email";

export const RECIPIENT_REASONS: readonly RecipientReason[] = [
  "eligible",
  "no_email",
  "invalid_email",
  "unverified_email",
  "no_consent",
  "consent_revoked",
  "duplicate_email",
];

type Executor = Pick<Database, "execute">;

/** POSIX sınıflı, Postgres ARE. `content.ts`'teki biçimle aynı kapsam. */
const EMAIL_SHAPE = "^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$";

function latestMarketingConsent(userAlias: string): SQL {
  return sql.raw(`(
    SELECT c.granted FROM user_consent c
     WHERE c.user_id = ${userAlias}.id AND c.kind = 'marketing_email'
     ORDER BY c.granted_at DESC, c.id DESC
     LIMIT 1
  )`);
}

/**
 * `SELECT user_id, email, reason FROM app_user u ...`. `where` yalnızca
 * `u` üzerinde ek filtre (tek kullanıcı ya da tümü). Sonuç sütunları sabittir.
 */
export function recipientClassificationSql(where?: SQL): SQL {
  return sql`
    SELECT u.id AS user_id, u.email AS email,
      CASE
        WHEN u.email IS NULL OR btrim(u.email) = '' THEN 'no_email'
        WHEN char_length(u.email) > 254 OR u.email !~ ${EMAIL_SHAPE} THEN 'invalid_email'
        WHEN u.email_verified_at IS NULL THEN 'unverified_email'
        WHEN mc.granted IS NULL THEN 'no_consent'
        WHEN mc.granted IS NOT TRUE THEN 'consent_revoked'
        WHEN EXISTS (
          SELECT 1 FROM app_user u2
           WHERE u2.email IS NOT NULL
             AND lower(u2.email) = lower(u.email)
             AND u2.id < u.id
             AND u2.email_verified_at IS NOT NULL
             AND ${latestMarketingConsent("u2")} IS TRUE
        ) THEN 'duplicate_email'
        ELSE 'eligible'
      END AS reason
    FROM app_user u
    LEFT JOIN LATERAL (SELECT ${latestMarketingConsent("u")} AS granted) mc ON true
    ${where ? sql`WHERE ${where}` : sql``}
  `;
}

export type RecipientClassification =
  | { reason: "eligible"; userId: number; email: string }
  | { reason: Exclude<RecipientReason, "eligible"> | "no_user"; userId: number };

/** Gönderim anı denetimi. Hesap yoksa `no_user`. */
export async function classifyRecipient(
  db: Executor,
  userId: number,
): Promise<RecipientClassification> {
  const result = await db.execute<{
    user_id: string;
    email: string | null;
    reason: RecipientReason;
  }>(recipientClassificationSql(sql`u.id = ${userId}`));
  const row = result.rows[0];
  if (!row) return { reason: "no_user", userId };
  if (row.reason === "eligible" && row.email) {
    return { reason: "eligible", userId, email: row.email };
  }
  return { reason: row.reason === "eligible" ? "no_email" : row.reason, userId };
}

export interface RecipientPreview {
  /** Tüm hesaplar. */
  total: number;
  eligible: number;
  excluded: Record<Exclude<RecipientReason, "eligible">, number>;
}

/** Önizleme: yalnızca sayılar. Adres ya da kimlik DÖNMEZ. */
export async function getRecipientPreview(
  db: Database,
  actor: AdminActor,
): Promise<RecipientPreview> {
  assertCapability(actor, "marketing.manage");
  const result = await db.execute<{ reason: RecipientReason; n: string }>(
    sql`SELECT r.reason, count(*) AS n FROM (${recipientClassificationSql()}) r GROUP BY r.reason`,
  );
  const preview: RecipientPreview = {
    total: 0,
    eligible: 0,
    excluded: {
      no_email: 0,
      invalid_email: 0,
      unverified_email: 0,
      no_consent: 0,
      consent_revoked: 0,
      duplicate_email: 0,
    },
  };
  for (const row of result.rows) {
    const n = Number(row.n);
    preview.total += n;
    if (row.reason === "eligible") preview.eligible = n;
    else preview.excluded[row.reason] = n;
  }
  return preview;
}
