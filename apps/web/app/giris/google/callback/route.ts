import {
  classifyGoogleFailure,
  completeGoogleSignIn,
  googleRedirectUri,
  postAuthRedirect,
  requireAppUrl,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { clientIp } from "../../../lib/client-ip.ts";
import { setSessionCookie } from "../../../lib/session-cookie.ts";
import { takeAuthNext } from "../../next-cookie.ts";
import { GOOGLE_STATE_COOKIE } from "../google-cookies.ts";

/** Google'in callback'e koydugu `error` (`access_denied` gibi); guvenli degilse "other". */
function providerError(value: string): string {
  return /^[a-z_]{1,40}$/.test(value) ? value : "other";
}

/**
 * Google donusu. Kullanici her basarisizlikta ayni genel mesaji gorur
 * (`/giris?error=google`); sunucu logu ise ayirt edilebilir bir kategori
 * tasir - `state_missing`, `provider:access_denied`,
 * `token:http_401:invalid_client`, `db:42P01:user_identity`, ... (bkz.
 * `classifyGoogleFailure`). Code, token, secret, e-posta loglanmaz.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const store = await cookies();
  const expectedState = store.get(GOOGLE_STATE_COOKIE)?.value;
  store.delete(GOOGLE_STATE_COOKIE);
  // Her durumda okunup silinir; hata yolunda da eski değer kalmaz.
  const next = takeAuthNext(store);

  const rejection = error
    ? `provider:${providerError(error)}`
    : !code
      ? "code_missing"
      : !expectedState
        ? "state_missing"
        : state !== expectedState
          ? "state_mismatch"
          : null;
  if (rejection || !code) {
    console.error(`[giris] google oauth rejected: ${rejection}`);
    redirect("/giris?error=google");
  }

  const headerStore = await headers();
  let destination: string;
  try {
    const { rawSessionToken, user } = await completeGoogleSignIn(getDatabase(), {
      code,
      redirectUri: googleRedirectUri(requireAppUrl()),
      ip: clientIp(headerStore),
      userAgent: headerStore.get("user-agent"),
    });
    await setSessionCookie(rawSessionToken);
    destination = postAuthRedirect(user, next);
  } catch (failure) {
    console.error(`[giris] google oauth failed: ${classifyGoogleFailure(failure)}`);
    redirect("/giris?error=google");
  }

  redirect(destination);
}
