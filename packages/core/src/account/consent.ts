/**
 * `/hesap` İzinler bölümü (docs/pages.md, docs/kvkk.md). `user_consent`
 * append-only bir geçmiş tablosu - `(user_id, kind)` üzerinde unique kısıt
 * yok, "neye ne zaman rıza verildi" sorusuna cevap veren bir denetim izi.
 * Güncel durum, her `kind` için EN SON satırdır (`granted_at`, eşitlikte
 * `id`); bu yüzden `setConsent` bir UPDATE değil, yeni bir satır INSERT eder.
 * Pazarlama e-postası uygunluğu da aynı kuralla okunur
 * (`marketing/eligibility.ts`) ve abonelik iptali de buradan yazar.
 */

import { type Database, userConsent } from "@arilla/db";
import { and, desc, eq } from "drizzle-orm";
import type { ConsentKind } from "./types.ts";

export const CONSENT_KINDS: readonly ConsentKind[] = [
  "browsing_history",
  "marketing_email",
  "personalization",
  "public_discovery",
];

export type ConsentState = Record<ConsentKind, boolean>;

/** Hiç kayıt yoksa varsayılan `false` - opt-in, opt-out değil (kvkk.md). */
export async function getConsents(
  db: Pick<Database, "select">,
  userId: number,
): Promise<ConsentState> {
  const state: ConsentState = {
    browsing_history: false,
    marketing_email: false,
    personalization: false,
    public_discovery: false,
  };

  for (const kind of CONSENT_KINDS) {
    const rows = await db
      .select({ granted: userConsent.granted })
      .from(userConsent)
      .where(and(eq(userConsent.userId, userId), eq(userConsent.kind, kind)))
      .orderBy(desc(userConsent.grantedAt), desc(userConsent.id))
      .limit(1);
    const latest = rows[0];
    if (latest) state[kind] = latest.granted;
  }

  return state;
}

export interface SetConsentInput {
  userId: number;
  kind: ConsentKind;
  granted: boolean;
  ip: string | null;
}

/** `db` bir işlem (`tx`) de olabilir: abonelik iptali kilit altında yazar. */
export async function setConsent(
  db: Pick<Database, "insert">,
  input: SetConsentInput,
): Promise<void> {
  await db.insert(userConsent).values({
    userId: input.userId,
    kind: input.kind,
    granted: input.granted,
    ip: input.ip,
  });
}
