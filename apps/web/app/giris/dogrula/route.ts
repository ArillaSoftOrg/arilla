import {
  TokenAlreadyUsedError,
  TokenExpiredError,
  TokenNotFoundError,
  verifyLoginToken,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { setSessionCookie } from "../../lib/session-cookie.ts";

function clientIp(forwardedFor: string | null): string | null {
  return forwardedFor?.split(",")[0]?.trim() || null;
}

/**
 * docs/routes.md `/giris/dogrula?token=...`: tek kullanımlık, 15 dk. Aynı
 * üslup `/git/[offerId]/route.ts` ile - GET, tek istekte doğrula ve
 * yönlendir. Next'in kendi rehberi: `redirect()` try/catch içinde
 * ÇAĞRILMAMALI, bu yüzden sonuç önce bir değişkende toplanıp try/catch
 * bittikten sonra yönlendiriliyor.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const rawToken = url.searchParams.get("token");
  if (!rawToken) {
    redirect("/giris");
  }

  const headerStore = await headers();
  const ip = clientIp(headerStore.get("x-forwarded-for"));
  const userAgent = headerStore.get("user-agent");

  let outcome: { kind: "ok"; rawSessionToken: string } | { kind: "error"; redirectTo: string };
  try {
    const { rawSessionToken } = await verifyLoginToken(getDatabase(), { rawToken, ip, userAgent });
    outcome = { kind: "ok", rawSessionToken };
  } catch (error) {
    if (error instanceof TokenExpiredError) {
      outcome = { kind: "error", redirectTo: "/giris?error=expired" };
    } else if (error instanceof TokenAlreadyUsedError || error instanceof TokenNotFoundError) {
      outcome = { kind: "error", redirectTo: "/giris?error=used" };
    } else {
      throw error;
    }
  }

  if (outcome.kind === "error") {
    redirect(outcome.redirectTo);
  }

  await setSessionCookie(outcome.rawSessionToken);
  redirect("/");
}
