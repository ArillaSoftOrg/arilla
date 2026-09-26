import {
  APPLE_AUTHORIZE_URL,
  AppleConfigError,
  appleConfigFromEnv,
  generateRawToken,
  hashNonce,
  requireAppUrl,
} from "@arilla/core";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { APPLE_COOKIE_PATH, NONCE_COOKIE, STATE_COOKIE } from "./apple-cookies.ts";

/**
 * Apple `response_mode=form_post` ile callback'e siteler arasi POST yapar;
 * `SameSite=Lax` cerez o istekte GONDERILMEZ. Bu iki kisa omurlu cerez bu
 * yuzden `SameSite=None; Secure` (localhost'ta da Secure kabul edilir).
 */
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "none",
  path: APPLE_COOKIE_PATH,
  maxAge: 10 * 60,
} as const;

export async function GET() {
  let clientId: string;
  try {
    clientId = appleConfigFromEnv().clientId;
  } catch (error) {
    if (!(error instanceof AppleConfigError)) throw error;
    console.error("[giris] apple not configured");
    redirect("/giris?error=apple");
  }

  const appUrl = requireAppUrl();
  const state = generateRawToken();
  const nonce = generateRawToken();
  const store = await cookies();
  store.set(STATE_COOKIE, state, COOKIE_OPTIONS);
  store.set(NONCE_COOKIE, nonce, COOKIE_OPTIONS);

  const url = new URL(APPLE_AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", `${appUrl}/giris/apple/callback`);
  url.searchParams.set("response_type", "code");
  // `name email` istendiginde Apple yalnizca form_post kabul eder.
  url.searchParams.set("response_mode", "form_post");
  url.searchParams.set("scope", "name email");
  url.searchParams.set("state", state);
  // id_token `nonce` claim'i bunun SHA-256'sini tasir; ham deger cerezde kalir.
  url.searchParams.set("nonce", hashNonce(nonce));

  redirect(url.toString());
}
