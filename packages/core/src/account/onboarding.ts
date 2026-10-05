/**
 * İlk giriş karşılaması ve yeni hesap rıza varsayılanları (docs/decisions/0060).
 *
 * - Yeni hesap açılırken (`createSessionForUser`, `isNewUser`) kişiselleştirme
 *   (gezinme geçmişi + kişiselleştirme) ve anonim keşif katkısı AÇIK yazılır;
 *   kaynak `signup_default`. Mevcut hesaplara dokunulmaz.
 * - Haftalık özet (`marketing_email`) varsayılan KAPALI: yalnızca karşılamanın
 *   son adımında kullanıcı açıkça açarsa `granted = true` yazılır.
 * - `app_user.onboarded_at` doluysa karşılama bir daha açılmaz.
 */
import { appUser, type Database, form, userConsent } from "@arilla/db";
import { and, eq, isNull } from "drizzle-orm";
import type { ConsentKind } from "./types.ts";

export const SIGNUP_DEFAULT_TEXT_VERSION = "signup-default-v1";
/** Karşılama (anket son adımı) bülten kararının metin sürümü. */
export const ONBOARDING_TEXT_VERSION = "onboarding-v1";

/** Yeni hesapta varsayılan AÇIK olan izinler (eski `/hesap` kutusuyla aynı türler). */
export const SIGNUP_DEFAULT_CONSENTS: readonly ConsentKind[] = [
  "browsing_history",
  "personalization",
  "public_discovery",
];

export async function applySignupConsentDefaults(
  db: Pick<Database, "insert">,
  userId: number,
): Promise<void> {
  await db.insert(userConsent).values(
    SIGNUP_DEFAULT_CONSENTS.map((kind) => ({
      userId,
      kind,
      granted: true,
      ip: null,
      source: "signup_default" as const,
      textVersion: SIGNUP_DEFAULT_TEXT_VERSION,
    })),
  );
}

/** `onboarded_at` boşsa karşılama gösterilir. Hesap yoksa `false`. */
export async function needsOnboarding(
  db: Pick<Database, "select">,
  userId: number,
): Promise<boolean> {
  const rows = await db
    .select({ onboardedAt: appUser.onboardedAt })
    .from(appUser)
    .where(eq(appUser.id, userId))
    .limit(1);
  const row = rows[0];
  return row ? row.onboardedAt === null : false;
}

export interface CompleteOnboardingInput {
  userId: number;
  /** Açıkça açılmadıkça (devam/atla) `false`. */
  newsletter: boolean;
  ip: string | null;
}

/**
 * Karşılamayı bitirir. İlk tamamlamada `onboarded_at` doldurulur ve bülten
 * kararı (`true`/`false`) AYNI işlemde yazılır; tekrar çağrı hiçbir şey
 * yazmaz (yeniden gönderim sonradan verilen kararı ezemez). `true` döner =
 * bu çağrı tamamladı.
 */
export async function completeOnboarding(
  db: Pick<Database, "transaction">,
  input: CompleteOnboardingInput,
): Promise<boolean> {
  if (typeof input.newsletter !== "boolean") {
    throw new TypeError("newsletter boolean olmalı");
  }
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(appUser)
      .set({ onboardedAt: new Date() })
      .where(and(eq(appUser.id, input.userId), isNull(appUser.onboardedAt)))
      .returning({ id: appUser.id });
    if (updated.length === 0) return false;

    await tx.insert(userConsent).values({
      userId: input.userId,
      kind: "marketing_email",
      granted: input.newsletter,
      ip: input.ip,
      source: "onboarding",
      textVersion: ONBOARDING_TEXT_VERSION,
    });
    return true;
  });
}

/**
 * Onboarding anketinin (`form.kind = 'onboarding'`, karar 0058) bülten kararı.
 * Anket sihirbazının SON adımı "haftalık özet"tir; bu fonksiyon yalnızca
 * `slug` gerçekten bir onboarding formuysa `completeOnboarding`'i çağırır
 * (başka bir formdan bülten rızası yazılamaz). Karar ilk kez yazılır;
 * sonrası no-op'tur (`completeOnboarding`). `true` = bu çağrı yazdı.
 */
export async function recordOnboardingNewsletterDecision(
  db: Pick<Database, "select" | "transaction">,
  input: CompleteOnboardingInput & { slug: string },
): Promise<boolean> {
  const rows = await db
    .select({ kind: form.kind })
    .from(form)
    .where(eq(form.slug, input.slug))
    .limit(1);
  if (rows[0]?.kind !== "onboarding") return false;
  return completeOnboarding(db, input);
}
