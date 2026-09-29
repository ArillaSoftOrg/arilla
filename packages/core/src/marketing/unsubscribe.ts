/**
 * Girişsiz abonelik iptali (docs/decisions/0046).
 *
 * Her pazarlama gönderimi kendi rastgele token'ını üretir; veritabanında
 * yalnızca SHA-256 özeti durur (`marketing_email_send.unsubscribe_token_hash`).
 * `SESSION_SECRET` pepper'ı bilerek KULLANILMAZ: sır döndürüldüğünde gelen
 * kutularındaki iptal bağlantıları çalışmaya devam etmeli; 256 bitlik
 * rastgele girdi için pepper gerekmez.
 *
 * İptal anında ve kalıcı: rıza satırı (`unsubscribe_link`) ve adres
 * bastırması aynı işlemde yazılır; İYS senkronu beklenmez. Tekrarlanan
 * istek (bağlantı tarayıcıları, çift tık) yeni satır üretmez.
 */
import { createHash, randomBytes } from "node:crypto";
import { type Database, emailSuppression, marketingEmailSend, userConsent } from "@arilla/db";
import { and, eq, max } from "drizzle-orm";
import { recordMarketingConsentIn } from "./consent.ts";
import { isSuppressedSince, lockMarketingSubject } from "./eligibility.ts";

/** Sayfa (onay düğmeli) ve RFC 8058 tek tık uç noktası. */
export const UNSUBSCRIBE_PAGE_PATH = "/abonelik-iptali";
export const UNSUBSCRIBE_ONE_CLICK_PATH = "/api/email/unsubscribe";

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function generateUnsubscribeToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashUnsubscribeToken(raw) };
}

export function hashUnsubscribeToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export function isUnsubscribeTokenShape(raw: unknown): raw is string {
  return typeof raw === "string" && TOKEN_SHAPE.test(raw);
}

export function unsubscribeUrls(
  appUrl: string,
  rawToken: string,
): { page: string; oneClick: string } {
  const token = encodeURIComponent(rawToken);
  return {
    page: `${appUrl}${UNSUBSCRIBE_PAGE_PATH}?t=${token}`,
    oneClick: `${appUrl}${UNSUBSCRIBE_ONE_CLICK_PATH}?t=${token}`,
  };
}

export type UnsubscribeResult =
  | { status: "unsubscribed"; alreadyUnsubscribed: boolean }
  | { status: "invalid" };

export async function unsubscribeByToken(
  db: Database,
  rawToken: unknown,
  context: { ip: string | null },
): Promise<UnsubscribeResult> {
  if (!isUnsubscribeTokenShape(rawToken)) return { status: "invalid" };
  const tokenHash = hashUnsubscribeToken(rawToken);

  return db.transaction(async (tx) => {
    const send = (
      await tx
        .select({ userId: marketingEmailSend.userId, emailHash: marketingEmailSend.emailHash })
        .from(marketingEmailSend)
        .where(eq(marketingEmailSend.unsubscribeTokenHash, tokenHash))
        .limit(1)
    )[0];
    if (!send) return { status: "invalid" } as const;

    await lockMarketingSubject(tx, { userId: send.userId, emailHash: send.emailHash });

    // Bastırmanın geçersiz kılması gereken en son rıza anı. Hesap silinmişse
    // (user_id NULL) herhangi bir bastırma yeterlidir.
    let lastGrantAt: Date | null = null;
    if (send.userId !== null) {
      const row = await tx
        .select({ at: max(userConsent.grantedAt) })
        .from(userConsent)
        .where(
          and(
            eq(userConsent.userId, send.userId),
            eq(userConsent.kind, "marketing_email"),
            eq(userConsent.granted, true),
          ),
        );
      lastGrantAt = row[0]?.at ?? null;
    }

    let changed = false;
    if (!(await isSuppressedSince(tx, send.emailHash, lastGrantAt))) {
      await tx.insert(emailSuppression).values({
        emailHash: send.emailHash,
        reason: "unsubscribe_link",
        userId: send.userId,
      });
      changed = true;
    }

    if (send.userId !== null) {
      const revoked = await recordMarketingConsentIn(tx, {
        userId: send.userId,
        granted: false,
        source: "unsubscribe_link",
        ip: context.ip,
      });
      changed ||= revoked.changed;
    }

    return { status: "unsubscribed", alreadyUnsubscribed: !changed } as const;
  });
}
