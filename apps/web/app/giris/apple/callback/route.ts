import {
  AppleIdTokenError,
  appleConfigFromEnv,
  displayNameFromAppleUser,
  exchangeAppleCode,
  fetchAppleJwks,
  hashNonce,
  readAppUrl,
  requireAppUrl,
  signInWithApple,
  verifyAppleIdToken,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { clientIp } from "../../../lib/client-ip.ts";
import { setSessionCookie } from "../../../lib/session-cookie.ts";
import { APPLE_COOKIE_PATH, NONCE_COOKIE, STATE_COOKIE } from "../apple-cookies.ts";

/** POST'tan sonra GET'e: 303. (`redirect()` 307 verir, tarayici POST'u tekrarlar.) */
function seeOther(request: Request, path: string): NextResponse {
  return NextResponse.redirect(new URL(path, readAppUrl() ?? request.url), 303);
}

/**
 * Apple `form_post` ile gelir. `state` cerezle eslesmeli; `id_token` token
 * ucundan alinip imza + iss + aud + exp + nonce ile dogrulanir. Formdaki
 * `user` JSON'u imzasizdir: yalnizca ad icin, e-posta icin kullanilmaz.
 */
export async function POST(request: Request) {
  const form = await request.formData();
  const code = form.get("code");
  const state = form.get("state");
  const user = form.get("user");

  const store = await cookies();
  const expectedState = store.get(STATE_COOKIE)?.value;
  const rawNonce = store.get(NONCE_COOKIE)?.value;
  store.delete({ name: STATE_COOKIE, path: APPLE_COOKIE_PATH });
  store.delete({ name: NONCE_COOKIE, path: APPLE_COOKIE_PATH });

  if (
    form.get("error") ||
    typeof code !== "string" ||
    !code ||
    typeof state !== "string" ||
    !expectedState ||
    !rawNonce ||
    state !== expectedState
  ) {
    return seeOther(request, "/giris?error=apple");
  }

  const headerStore = await headers();
  const ip = clientIp(headerStore.get("x-forwarded-for"));
  const userAgent = headerStore.get("user-agent");

  try {
    const config = appleConfigFromEnv();
    const idToken = await exchangeAppleCode(config, {
      code,
      redirectUri: `${requireAppUrl()}/giris/apple/callback`,
    });
    const verifyWith = (keys: Awaited<ReturnType<typeof fetchAppleJwks>>) =>
      verifyAppleIdToken(idToken, {
        clientId: config.clientId,
        expectedNonce: hashNonce(rawNonce),
        keys,
      });

    let claims: ReturnType<typeof verifyAppleIdToken>;
    try {
      claims = verifyWith(await fetchAppleJwks());
    } catch (error) {
      // Apple anahtar dondurmus olabilir: onbellekteki listede `kid` yoksa bir kez yenile.
      if (!(error instanceof AppleIdTokenError) || error.reason !== "bilinmeyen kid") throw error;
      claims = verifyWith(await fetchAppleJwks({ force: true }));
    }

    const { rawSessionToken } = await signInWithApple(getDatabase(), {
      claims,
      displayName: displayNameFromAppleUser(typeof user === "string" ? user : null),
      ip,
      userAgent,
    });
    await setSessionCookie(rawSessionToken);
  } catch (error) {
    // Yalnizca hata turu; token, e-posta ya da sub loglanmaz.
    console.error(
      `[giris] apple sign-in failed: ${error instanceof Error ? error.name : "unknown"}`,
    );
    return seeOther(request, "/giris?error=apple");
  }

  return seeOther(request, "/");
}

/** Apple'a GET ile donulmez; elle acilan adres giris sayfasina gider. */
export function GET(request: Request) {
  return seeOther(request, "/giris?error=apple");
}
