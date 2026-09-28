/**
 * Google ile giris akisinin HTTP adimlari ve hata siniflandirmasi. Oturum ve
 * kullanici mantigi `google-oauth.ts` `signInWithGoogle`'da kalir; bu dosya
 * yalnizca Google'a giden istekleri ve "neden basarisiz oldu" sorusunu
 * cevaplar. `apps/web/app/giris/google/*` ince istemcidir.
 *
 * Neden ayri: onceki callback her hatayi tek bir `catch`'te yutuyor ve
 * yalnizca "google oauth failed" logluyordu. Uretimde gercek sebep (eksik
 * migration, yanlis client secret, redirect_uri uyusmazligi) ayirt
 * edilemiyordu. Burada her basarisizlik guvenli bir KATEGORIYE cevrilir:
 * kategori token, code, secret, e-posta ya da `sub` ICERMEZ; yalnizca adim,
 * HTTP durumu, Google'in hata kodu (`invalid_client` gibi) ve Postgres hata
 * kodu/tablo adi.
 */
import type { Database } from "@arilla/db";
import { databaseFailureCategory, unexpectedFailureCategory } from "./failure-category.ts";
import {
  GoogleEmailNotVerifiedError,
  type GoogleProfile,
  type SignInWithGoogleResult,
  signInWithGoogle,
} from "./google-oauth.ts";

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const REQUEST_TIMEOUT_MS = 10_000;

/** Kullaniciya gosterilmez; yalnizca sunucu loguna guvenli kategori olarak yazilir. */
export class GoogleOAuthError extends Error {
  constructor(readonly category: string) {
    super(`google oauth: ${category}`);
    this.name = "GoogleOAuthError";
  }
}

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
}

export function googleConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): GoogleConfig {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId) throw new GoogleOAuthError("config_missing:GOOGLE_CLIENT_ID");
  if (!clientSecret) throw new GoogleOAuthError("config_missing:GOOGLE_CLIENT_SECRET");
  return { clientId, clientSecret };
}

/**
 * Authorize ve token adimlarinin AYNI `redirect_uri`'yi kullanmasi zorunlu;
 * ikisi de bu tek fonksiyondan gecer.
 */
export function googleRedirectUri(appUrl: string): string {
  return `${appUrl.replace(/\/+$/, "")}/giris/google/callback`;
}

export function buildGoogleAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", input.state);
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

/** Google'in `error` alani (`invalid_client`, `invalid_grant`, ...) guvenli ise. */
function safeCode(value: unknown): string {
  return typeof value === "string" && /^[a-z_]{1,40}$/.test(value) ? value : "unknown";
}

async function request(
  fetchImpl: typeof fetch,
  step: "token" | "userinfo",
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new GoogleOAuthError(`${step}:${timedOut ? "timeout" : "network"}`);
  }
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const value = (await response.json()) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** `code` -> access token. Token saklanmaz, loglanmaz. */
export async function exchangeGoogleCode(
  config: GoogleConfig,
  input: { code: string; redirectUri: string },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await request(fetchImpl, "token", GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code: input.code,
      grant_type: "authorization_code",
      redirect_uri: input.redirectUri,
    }),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    // Ornek: token:http_401:invalid_client (secret/client eslesmiyor),
    // token:http_400:redirect_uri_mismatch, token:http_400:invalid_grant.
    throw new GoogleOAuthError(`token:http_${response.status}:${safeCode(payload?.error)}`);
  }
  const accessToken = payload?.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new GoogleOAuthError("token:missing_access_token");
  }
  return accessToken;
}

export async function fetchGoogleProfile(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GoogleProfile> {
  const response = await request(fetchImpl, "userinfo", GOOGLE_USERINFO_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new GoogleOAuthError(`userinfo:http_${response.status}`);
  }
  const payload = await readJson(response);
  if (typeof payload?.sub !== "string" || typeof payload.email !== "string") {
    throw new GoogleOAuthError("userinfo:missing_identity");
  }
  return {
    sub: payload.sub,
    email: payload.email,
    // Google `true` (boolean) dondurur; eski uclar "true" dizesi de verebilir.
    emailVerified: payload.email_verified === true || payload.email_verified === "true",
    name: typeof payload.name === "string" ? payload.name : null,
    picture: typeof payload.picture === "string" ? payload.picture : null,
  };
}

/** Callback'in tamami: code -> token -> profil -> kullanici + oturum (+ erken erisim). */
export async function completeGoogleSignIn(
  db: Database,
  input: { code: string; redirectUri: string; ip: string | null; userAgent: string | null },
  deps: { config?: GoogleConfig; fetchImpl?: typeof fetch } = {},
): Promise<SignInWithGoogleResult> {
  const config = deps.config ?? googleConfigFromEnv();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const accessToken = await exchangeGoogleCode(
    config,
    { code: input.code, redirectUri: input.redirectUri },
    fetchImpl,
  );
  const profile = await fetchGoogleProfile(accessToken, fetchImpl);
  return signInWithGoogle(db, { profile, ip: input.ip, userAgent: input.userAgent });
}

/**
 * Herhangi bir hatayi loglanabilir kategoriye cevirir. Postgres hatalarinda
 * yalnizca SQLSTATE ve (42P01'de) tablo adi: ornek `db:42P01:user_identity`
 * = migration uygulanmamis.
 */
export function classifyGoogleFailure(error: unknown): string {
  if (error instanceof GoogleOAuthError) return error.category;
  if (error instanceof GoogleEmailNotVerifiedError) return "email_unverified";
  return databaseFailureCategory(error) ?? unexpectedFailureCategory(error);
}
