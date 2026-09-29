"use server";

import type { ConsentKind } from "@arilla/core";
import {
  clearHistory,
  deleteAccount,
  getMarketingEmailPreference,
  MarketingConsentError,
  recordMarketingEmailConsent,
  setConsent,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { clientIp } from "../lib/client-ip.ts";
import { requireUser } from "../lib/dal.ts";
import { clearSessionCookie } from "../lib/session-cookie.ts";

function isGenericConsentKind(kind: unknown): kind is Exclude<ConsentKind, "marketing_email"> {
  return kind === "browsing_history" || kind === "personalization" || kind === "public_discovery";
}

export async function updateConsentAction(kind: ConsentKind, granted: boolean): Promise<void> {
  const user = await requireUser();
  // `kind` istemciden gelir: pazarlama rızası bu genel yoldan yazılamaz.
  if (!isGenericConsentKind(kind)) {
    throw new Error("Gecersiz riza turu.");
  }
  const ip = clientIp(await headers());
  await setConsent(getDatabase(), { userId: user.id, kind, granted: granted === true, ip });
  revalidatePath("/hesap");
}

export interface MarketingPreferenceResult {
  optedIn: boolean;
  hasEmail: boolean;
  error?: "no_email" | "failed";
}

/**
 * Pazarlama e-postası tercihi (docs/decisions/0046). İstemci yalnızca
 * aç/kapat der; kimlik oturumdan, adres ve metin sürümü sunucudan gelir.
 * Dönen değer SUNUCU durumudur: arayüz kendi varsayımını değil bunu gösterir.
 * Kapatma anında geçerlidir; işlemsel e-postalar etkilenmez.
 */
export async function updateMarketingEmailAction(
  granted: boolean,
): Promise<MarketingPreferenceResult> {
  const user = await requireUser();
  const db = getDatabase();
  const ip = clientIp(await headers());
  try {
    const result = await recordMarketingEmailConsent(
      db,
      granted === true
        ? { userId: user.id, granted: true, source: "account_settings", ip }
        : { userId: user.id, granted: false, source: "account_settings", ip },
    );
    revalidatePath("/hesap");
    return { optedIn: result.preference.optedIn, hasEmail: result.preference.hasEmail };
  } catch (error) {
    const current = await getMarketingEmailPreference(db, user.id);
    const code =
      error instanceof MarketingConsentError && error.code === "no_email" ? "no_email" : "failed";
    return { optedIn: current.optedIn, hasEmail: current.hasEmail, error: code };
  }
}

/** docs/pages.md "/hesap": "gezinme geçmişini sil" - `/gecmis`'in aynı çekirdek fonksiyonu, ayrı bir sayfadan. */
export async function clearHistoryAction(): Promise<void> {
  const user = await requireUser();
  await clearHistory(getDatabase(), user.id);
  revalidatePath("/hesap");
  revalidatePath("/gecmis");
}

/**
 * docs/pages.md: "Onay adımı vardır ama geri alınamaz olduğu açıkça
 * yazılır." Onay istemci tarafında (bkz. delete-account-button-client.tsx);
 * bu action geri dönüşü olmayan asıl işlemi yapar.
 */
export async function deleteAccountAction(): Promise<void> {
  const user = await requireUser();
  await deleteAccount(getDatabase(), user.id);
  await clearSessionCookie();
  redirect("/");
}
