/**
 * Girişsiz abonelik iptali (docs/decisions/0048).
 *
 * Her gönderim denemesi kendi 256 bitlik rastgele token'ını üretir; veritabanında
 * yalnızca SHA-256 özeti durur (`marketing_campaign_delivery.
 * unsubscribe_token_hash`). Token sır taşımaz ve türetilmez: hesap kimliği,
 * imza anahtarı ya da oturum bilgisi içermez; tek yetkisi o teslim satırının
 * sahibinin pazarlama rızasını GERİ ALMAKTIR (veremez, başka hesaba dokunamaz).
 * İmzalı (HMAC) token bilerek seçilmedi: sır döndürülünce gelen kutusundaki
 * iptal bağlantıları bozulurdu.
 *
 * İptal = `user_consent`'e `marketing_email` ret satırı (`setConsent`).
 * İkinci bir abonelik bayrağı yok; `/hesap` anahtarı aynı durumu gösterir ve
 * sonraki her gönderim (`classifyRecipient`) onu hemen görür. Tekrarlanan
 * istek (bağlantı tarayıcısı, çift tık, posta istemcisinin tek tık POST'u)
 * yeni satır yazmaz: kullanıcı başına danışma kilidi altında güncel durum
 * okunur, zaten ret ise dokunulmaz.
 */
import { createHash, randomBytes } from "node:crypto";
import { type Database, marketingCampaignDelivery } from "@arilla/db";
import { eq, sql } from "drizzle-orm";
import { getConsents, setConsent } from "../account/consent.ts";

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
  | { status: "unsubscribed"; changed: boolean }
  /** Biçim bozuk, kurcalanmış ya da hiç üretilmemiş token. Hiçbir şey yazılmaz. */
  | { status: "invalid" };

/** Hesap ve pazarlama rızası için ortak kilit anahtarı. */
export function marketingConsentLockSql(userId: number) {
  return sql`SELECT pg_advisory_xact_lock(hashtextextended(${`marketing_consent:${userId}`}, 0))`;
}

export async function unsubscribeByToken(
  db: Database,
  rawToken: unknown,
  context: { ip: string | null },
): Promise<UnsubscribeResult> {
  if (!isUnsubscribeTokenShape(rawToken)) return { status: "invalid" };
  const tokenHash = hashUnsubscribeToken(rawToken);

  const delivery = (
    await db
      .select({ userId: marketingCampaignDelivery.userId })
      .from(marketingCampaignDelivery)
      .where(eq(marketingCampaignDelivery.unsubscribeTokenHash, tokenHash))
      .limit(1)
  )[0];
  if (!delivery) return { status: "invalid" };
  // Hesap silinmiş: rıza da silindi, bu hesaba bir daha ileti gidemez.
  if (delivery.userId === null) return { status: "unsubscribed", changed: false };
  const userId = delivery.userId;

  return db.transaction(async (tx) => {
    await tx.execute(marketingConsentLockSql(userId));
    const current = await getConsents(tx, userId);
    if (!current.marketing_email) return { status: "unsubscribed", changed: false } as const;
    await setConsent(tx, { userId, kind: "marketing_email", granted: false, ip: context.ip });
    return { status: "unsubscribed", changed: true } as const;
  });
}
