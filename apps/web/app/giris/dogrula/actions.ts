"use server";

import {
  loginPathWithNext,
  safeRedirectPath,
  TokenAlreadyUsedError,
  TokenExpiredError,
  TokenNotFoundError,
  verifyLoginToken,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { clientIp } from "../../lib/client-ip.ts";
import { setSessionCookie } from "../../lib/session-cookie.ts";

function loginErrorPath(error: "expired" | "used", next: string): string {
  const base = loginPathWithNext(next);
  return `${base}${base.includes("?") ? "&" : "?"}error=${error}`;
}

/**
 * E-posta bağlantısının tüketildiği TEK yer. Server action: yalnızca POST
 * ile çağrılır ve Next, Origin'i Host ile karşılaştırır (başka bir site
 * formu tetikleyemez). Token hash'i, süre ve tek kullanımlık tüketim
 * `verifyLoginToken`'da; burada yalnızca çerez ve güvenli yönlendirme.
 * `redirect()` try/catch dışında çağrılır (Next rehberi).
 */
export async function confirmLoginAction(formData: FormData): Promise<void> {
  const rawToken = formData.get("token");
  const next = safeRedirectPath(formData.get("next"));
  if (typeof rawToken !== "string" || !rawToken) {
    redirect(loginPathWithNext(next));
  }

  const headerStore = await headers();
  let outcome: { kind: "ok"; rawSessionToken: string } | { kind: "error"; redirectTo: string };
  try {
    const { rawSessionToken } = await verifyLoginToken(getDatabase(), {
      rawToken,
      ip: clientIp(headerStore),
      userAgent: headerStore.get("user-agent"),
    });
    outcome = { kind: "ok", rawSessionToken };
  } catch (error) {
    if (error instanceof TokenExpiredError) {
      outcome = { kind: "error", redirectTo: loginErrorPath("expired", next) };
    } else if (error instanceof TokenAlreadyUsedError || error instanceof TokenNotFoundError) {
      outcome = { kind: "error", redirectTo: loginErrorPath("used", next) };
    } else {
      throw error;
    }
  }

  if (outcome.kind === "error") {
    redirect(outcome.redirectTo);
  }

  await setSessionCookie(outcome.rawSessionToken);
  redirect(next);
}
