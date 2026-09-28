import {
  buildGoogleAuthorizeUrl,
  classifyGoogleFailure,
  generateRawToken,
  googleConfigFromEnv,
  googleRedirectUri,
  requireAppUrl,
} from "@arilla/core";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { rememberAuthNext } from "../next-cookie.ts";
import { GOOGLE_STATE_COOKIE } from "./google-cookies.ts";

/**
 * Google'a gidis. `redirect_uri` callback'in token adimiyla AYNI
 * fonksiyondan (`googleRedirectUri`) uretilir. Yapilandirma eksikse kullanici
 * Google'a hic gonderilmez; log yalnizca eksik degiskenin ADINI tasir.
 */
export async function GET(request: Request) {
  let clientId: string;
  try {
    clientId = googleConfigFromEnv().clientId;
  } catch (error) {
    console.error(`[giris] google oauth not started: ${classifyGoogleFailure(error)}`);
    redirect("/giris?error=google");
  }

  const appUrl = requireAppUrl();
  const state = generateRawToken();
  const store = await cookies();
  rememberAuthNext(store, new URL(request.url).searchParams.get("next"));

  store.set(GOOGLE_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 10 * 60,
  });

  redirect(buildGoogleAuthorizeUrl({ clientId, redirectUri: googleRedirectUri(appUrl), state }));
}
