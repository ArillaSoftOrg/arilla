/**
 * `/hesap` İzinler bölümü (docs/pages.md, docs/kvkk.md). `user_consent`
 * append-only bir geçmiş tablosu - `(user_id, kind)` üzerinde unique kısıt
 * yok, "neye ne zaman rıza verildi" sorusuna cevap veren bir denetim izi.
 * Güncel durum, her `kind` için EN SON satırdır; bu yüzden `setConsent` bir
 * UPDATE değil, yeni bir satır INSERT eder.
 */

import { type Database, userConsent } from "@arilla/db";
import { and, desc, eq } from "drizzle-orm";
import { getMarketingEmailPreference } from "../marketing/consent.ts";
import type { ConsentKind } from "./types.ts";

export const CONSENT_KINDS: readonly ConsentKind[] = [
  "browsing_history",
  "marketing_email",
  "personalization",
  "public_discovery",
];

export type ConsentState = Record<ConsentKind, boolean>;

/**
 * Hiç kayıt yoksa varsayılan `false` - opt-in, opt-out değil (kvkk.md).
 * `marketing_email` ham son satır değil, gönderim kapısıyla aynı etkin
 * durumdur (sürümlü rıza, bastırma yok): 0033 öncesi sürümsüz satırlar
 * "izin verildi" görünmez (docs/decisions/0046).
 */
export async function getConsents(db: Database, userId: number): Promise<ConsentState> {
  const state: ConsentState = {
    browsing_history: false,
    marketing_email: false,
    personalization: false,
    public_discovery: false,
  };

  for (const kind of CONSENT_KINDS) {
    if (kind === "marketing_email") {
      state.marketing_email = (await getMarketingEmailPreference(db, userId)).optedIn;
      continue;
    }
    const rows = await db
      .select({ granted: userConsent.granted })
      .from(userConsent)
      .where(and(eq(userConsent.userId, userId), eq(userConsent.kind, kind)))
      .orderBy(desc(userConsent.grantedAt))
      .limit(1);
    const latest = rows[0];
    if (latest) state[kind] = latest.granted;
  }

  return state;
}

export interface SetConsentInput {
  userId: number;
  /** `marketing_email` burada yazılamaz: `recordMarketingEmailConsent` kullanılır. */
  kind: Exclude<ConsentKind, "marketing_email">;
  granted: boolean;
  ip: string | null;
}

export async function setConsent(db: Database, input: SetConsentInput): Promise<void> {
  // Tip dışından (ör. istemciden gelen `kind`) gelen çağrıya karşı çalışma
  // zamanı kapısı: pazarlama rızası kaynak ve metin sürümü olmadan yazılmaz.
  if ((input.kind as ConsentKind) === "marketing_email") {
    throw new Error(
      "marketing_email setConsent ile yazilamaz; recordMarketingEmailConsent kullanin.",
    );
  }
  await db.insert(userConsent).values({
    userId: input.userId,
    kind: input.kind,
    granted: input.granted,
    ip: input.ip,
  });
}
