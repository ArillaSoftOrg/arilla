import {
  appleConfigFromEnv,
  appleRedirectUri,
  buildAppleAuthorizeUrl,
  classifyAppleFailure,
  generateRawToken,
  hashNonce,
  requireAppUrl,
} from "@arilla/core";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { rememberAuthNext } from "../next-cookie.ts";
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

/**
 * Apple'a gidis. Yapilandirma (ozel anahtar dahil) eksik ya da gecersizse
 * kullanici Apple'a hic gonderilmez; log yalnizca kategori tasir
 * (`config_missing:APPLE_KEY_ID`, `config_invalid:APPLE_PRIVATE_KEY`).
 * `redirect_uri` callback'in token adimiyla ayni fonksiyondan gelir.
 */
export async function GET(request: Request) {
  let clientId: string;
  try {
    clientId = appleConfigFromEnv().clientId;
  } catch (error) {
    console.error(`[giris] apple sign-in not started: ${classifyAppleFailure(error)}`);
    redirect("/giris?error=apple");
  }

  const state = generateRawToken();
  const nonce = generateRawToken();
  const store = await cookies();
  store.set(STATE_COOKIE, state, COOKIE_OPTIONS);
  store.set(NONCE_COOKIE, nonce, COOKIE_OPTIONS);
  rememberAuthNext(store, new URL(request.url).searchParams.get("next"));

  redirect(
    buildAppleAuthorizeUrl({
      clientId,
      redirectUri: appleRedirectUri(requireAppUrl()),
      state,
      // id_token `nonce` claim'i bunun SHA-256'sini tasir; ham deger cerezde kalir.
      nonceHash: hashNonce(nonce),
    }),
  );
}
