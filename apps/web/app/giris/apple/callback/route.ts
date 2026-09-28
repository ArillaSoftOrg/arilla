import {
  appleRedirectUri,
  classifyAppleFailure,
  completeAppleSignIn,
  postAuthRedirect,
  readAppUrl,
  requireAppUrl,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { clientIp } from "../../../lib/client-ip.ts";
import { setSessionCookie } from "../../../lib/session-cookie.ts";
import { takeAuthNext } from "../../next-cookie.ts";
import { APPLE_COOKIE_PATH, NONCE_COOKIE, STATE_COOKIE } from "../apple-cookies.ts";

/** POST'tan sonra GET'e: 303. (`redirect()` 307 verir, tarayici POST'u tekrarlar.) */
function seeOther(request: Request, path: string): NextResponse {
  return NextResponse.redirect(new URL(path, readAppUrl() ?? request.url), 303);
}

/** Apple'in forma koydugu `error` (`user_cancelled_authorize` gibi); guvenli degilse "other". */
function providerError(value: string): string {
  return /^[a-z_]{1,40}$/.test(value) ? value : "other";
}

/**
 * Apple `form_post` ile gelir. `state` cerezle eslesmeli; `id_token` token
 * ucundan alinip imza + iss + aud + exp + nonce ile dogrulanir
 * (`completeAppleSignIn`). Formdaki `user` JSON'u imzasizdir: yalnizca ad
 * icin, e-posta icin kullanilmaz.
 *
 * Kullanici her basarisizlikta ayni genel mesaja duser; log ayirt edilebilir
 * kategori tasir (`state_mismatch`, `provider:user_cancelled_authorize`,
 * `token:http_400:invalid_client`, `id_token:audience`, `db:...`). Token,
 * code, e-posta ya da `sub` loglanmaz.
 */
export async function POST(request: Request) {
  const form = await request.formData();
  const code = form.get("code");
  const state = form.get("state");
  const user = form.get("user");
  const error = form.get("error");

  const store = await cookies();
  const expectedState = store.get(STATE_COOKIE)?.value;
  const rawNonce = store.get(NONCE_COOKIE)?.value;
  store.delete({ name: STATE_COOKIE, path: APPLE_COOKIE_PATH });
  store.delete({ name: NONCE_COOKIE, path: APPLE_COOKIE_PATH });
  const next = takeAuthNext(store);

  const rejection =
    typeof error === "string" && error
      ? `provider:${providerError(error)}`
      : typeof code !== "string" || !code
        ? "code_missing"
        : !expectedState
          ? "state_missing"
          : !rawNonce
            ? "nonce_missing"
            : state !== expectedState
              ? "state_mismatch"
              : null;
  if (rejection || typeof code !== "string" || !rawNonce) {
    console.error(`[giris] apple sign-in rejected: ${rejection}`);
    return seeOther(request, "/giris?error=apple");
  }

  const headerStore = await headers();
  let destination: string;
  try {
    const { rawSessionToken, user: signedIn } = await completeAppleSignIn(getDatabase(), {
      code,
      rawNonce,
      userJson: typeof user === "string" ? user : null,
      redirectUri: appleRedirectUri(requireAppUrl()),
      ip: clientIp(headerStore),
      userAgent: headerStore.get("user-agent"),
    });
    await setSessionCookie(rawSessionToken);
    destination = postAuthRedirect(signedIn, next);
  } catch (failure) {
    console.error(`[giris] apple sign-in failed: ${classifyAppleFailure(failure)}`);
    return seeOther(request, "/giris?error=apple");
  }

  return seeOther(request, destination);
}

/** Apple'a GET ile donulmez; elle acilan adres giris sayfasina gider. */
export function GET(request: Request) {
  return seeOther(request, "/giris?error=apple");
}
