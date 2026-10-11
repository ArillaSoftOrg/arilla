/**
 * Sohbet gorsel eki icin acik riza (docs/decisions/0101). Tek kaynak `user_consent`
 * (`kind = 'chat_image'`); guncel durum en son satirdir. Kod yalnizca satir ekler.
 *
 * Riza ONCEDEN ISARETLI ya da ZORUNLU DEGILDIR: kullanici gorsel yuklemeden once
 * bilgilendirme metnini gorur ve kabul/ret ayri, esit agirlikli dugmelerle secilir.
 * Riza yoksa, reddedildiyse, geri cekildiyse ya da metin surumu eskidiyse gorsel
 * sunucuda islenmez (`hasChatImageConsent`). Geri cekmek yalnizca ileriye etkilidir;
 * mevcut sohbet gorselleri sohbetle birlikte silinir (90 gun / hesap silme).
 *
 * `CHAT_IMAGE_CONSENT_VERSION` bilgilendirme metni (`apps/web/app/sohbet/chat-image-consent-copy.ts`)
 * degisince birlikte guncellenir; eski surume verilmis riza gecersiz sayilir ve yeniden sorulur.
 */
import { type Database, userConsent } from "@arilla/db";
import { getLatestConsents } from "../consent/account-consent.ts";

export const CHAT_IMAGE_CONSENT_VERSION = "chat-image-2026-10-12";

export interface ChatImageConsentState {
  /** Gecerli (guncel surume verilmis, geri cekilmemis) acik riza var mi. */
  granted: boolean;
  /** Kullanici daha once karar verdi mi (kabul ya da ret, herhangi bir surum). */
  decided: boolean;
}

/** Saf: en son satirdan durum turetir. */
export function deriveChatImageConsent(
  latest: { granted: boolean; textVersion: string | null } | undefined,
): ChatImageConsentState {
  if (!latest) return { granted: false, decided: false };
  return {
    granted: latest.granted && latest.textVersion === CHAT_IMAGE_CONSENT_VERSION,
    decided: true,
  };
}

export async function getChatImageConsent(
  db: Pick<Database, "execute">,
  userId: number,
): Promise<ChatImageConsentState> {
  const latest = (await getLatestConsents(db, userId, ["chat_image"])).get("chat_image");
  return deriveChatImageConsent(latest);
}

export async function hasChatImageConsent(
  db: Pick<Database, "execute">,
  userId: number,
): Promise<boolean> {
  return (await getChatImageConsent(db, userId)).granted;
}

/**
 * Karari ekler. Durum degismiyorsa (zaten gecerli kabul / zaten ret) satir yazilmaz.
 * IP yazilmaz (yalnizca hesap izinlerinde tutulan alan; burada gerek yok).
 */
export async function recordChatImageConsent(
  db: Database,
  input: { userId: number; granted: boolean; source: "chat_image_prompt" | "account_settings" },
  now: Date = new Date(),
): Promise<{ written: boolean }> {
  const current = await getChatImageConsent(db, input.userId);
  if (input.granted ? current.granted : current.decided && !current.granted) {
    return { written: false };
  }
  await db.insert(userConsent).values({
    userId: input.userId,
    kind: "chat_image",
    granted: input.granted,
    grantedAt: now,
    source: input.source,
    textVersion: CHAT_IMAGE_CONSENT_VERSION,
    ip: null,
  });
  return { written: true };
}
