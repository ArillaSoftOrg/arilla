/**
 * Apple ile giris (Sign in with Apple). Yeni bir auth cercevesi yok: Apple
 * kimligi dogrulanir, `signInWithIdentity` mevcut `app_user` + `session`
 * modeline baglar. OAuth access/refresh token'lari saklanmaz.
 *
 * Akis (`apps/web/app/giris/apple/*`):
 *   1. `/giris/apple`: `state` + `nonce` cerezi, Apple authorize'a yonlendirme.
 *   2. Apple `response_mode=form_post` ile callback'e POST eder (`code`,
 *      `state`, ilk giriste `user` JSON'u).
 *   3. `code`, ES256 imzali `client_secret` ile token ucunda degistirilir;
 *      donen `id_token` BURADA dogrulanir: imza (Apple JWKS, RS256), `iss`,
 *      `aud`, `exp`, `iat`, `nonce`.
 *
 * Kimlik `sub`'dir. E-posta yalnizca ilk giriste gelir; sonraki girislerde
 * kullanici `sub` ile bulunur.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  type JsonWebKey,
  sign,
  verify,
} from "node:crypto";
import type { Database } from "@arilla/db";
import { type SignInWithIdentityResult, signInWithIdentity } from "./identity-sign-in.ts";

export const APPLE_ISSUER = "https://appleid.apple.com";
export const APPLE_AUTHORIZE_URL = "https://appleid.apple.com/auth/authorize";
const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
const APPLE_KEYS_URL = "https://appleid.apple.com/auth/keys";

/** Saat kaymasi toleransi. */
const CLOCK_SKEW_SECONDS = 60;
/** client_secret en fazla 6 ay gecerli olabilir; her istekte kisa omurlu uretilir. */
const CLIENT_SECRET_TTL_SECONDS = 5 * 60;

export class AppleConfigError extends Error {
  constructor(name: string) {
    super(`${name} tanimli degil. .env.example dosyasina bakin.`);
    this.name = "AppleConfigError";
  }
}

export class AppleIdTokenError extends Error {
  constructor(readonly reason: string) {
    super(`apple id_token gecersiz: ${reason}`);
    this.name = "AppleIdTokenError";
  }
}

export interface AppleConfig {
  clientId: string;
  teamId: string;
  keyId: string;
  /** PKCS#8 PEM (.p8). `.env`'de tek satir icin `\n` kacislari kabul edilir. */
  privateKey: string;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new AppleConfigError(name);
  return value;
}

export function appleConfigFromEnv(): AppleConfig {
  return {
    clientId: requireEnv("APPLE_CLIENT_ID"),
    teamId: requireEnv("APPLE_TEAM_ID"),
    keyId: requireEnv("APPLE_KEY_ID"),
    privateKey: requireEnv("APPLE_PRIVATE_KEY").replace(/\\n/g, "\n"),
  };
}

/** Authorize isteginde duz `nonce` degil, SHA-256'si gonderilir; id_token onu tasir. */
export function hashNonce(rawNonce: string): string {
  return createHash("sha256").update(rawNonce).digest("hex");
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Apple token ucunun istedigi `client_secret`: ES256 imzali JWT
 * (iss = Team ID, sub = Services ID, aud = Apple). `dsaEncoding: ieee-p1363`
 * JWS'nin istedigi r||s bicimi (DER degil).
 */
export function createAppleClientSecret(config: AppleConfig, now: Date = new Date()): string {
  const iat = Math.floor(now.getTime() / 1000);
  const header = { alg: "ES256", kid: config.keyId };
  const payload = {
    iss: config.teamId,
    iat,
    exp: iat + CLIENT_SECRET_TTL_SECONDS,
    aud: APPLE_ISSUER,
    sub: config.clientId,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: createPrivateKey(config.privateKey),
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${base64url(signature)}`;
}

export interface AppleJwk extends JsonWebKey {
  kid: string;
  alg?: string;
}

export interface AppleIdTokenClaims {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  isPrivateEmail: boolean;
}

function decodeSegment(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    throw new AppleIdTokenError("ayristirilamadi");
  }
}

/** Apple `"true"`/`true` karisik dondurur. */
function claimBool(value: unknown): boolean {
  return value === true || value === "true";
}

/**
 * Saf dogrulama - ag yok. Anahtarlar ve saat disaridan gelir ki test edilebilsin.
 * Herhangi bir kosul tutmazsa `AppleIdTokenError`.
 */
export function verifyAppleIdToken(
  idToken: string,
  options: {
    clientId: string;
    /** Authorize isteginde gonderilen `hashNonce(rawNonce)`. */
    expectedNonce: string;
    keys: readonly AppleJwk[];
    now?: Date;
  },
): AppleIdTokenClaims {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new AppleIdTokenError("bicim");
  const [headerSegment = "", payloadSegment = "", signatureSegment = ""] = parts;

  const header = decodeSegment(headerSegment) as { alg?: unknown; kid?: unknown };
  // `alg` saldirgan tarafindan secilemez: yalnizca RS256.
  if (header.alg !== "RS256" || typeof header.kid !== "string") {
    throw new AppleIdTokenError("alg/kid");
  }
  const jwk = options.keys.find((key) => key.kid === header.kid);
  if (!jwk) throw new AppleIdTokenError("bilinmeyen kid");

  const valid = verify(
    "sha256",
    Buffer.from(`${headerSegment}.${payloadSegment}`),
    createPublicKey({ key: jwk, format: "jwk" }),
    Buffer.from(signatureSegment, "base64url"),
  );
  if (!valid) throw new AppleIdTokenError("imza");

  const claims = decodeSegment(payloadSegment) as Record<string, unknown>;
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);

  if (claims.iss !== APPLE_ISSUER) throw new AppleIdTokenError("iss");
  const audience = claims.aud;
  const audienceOk = Array.isArray(audience)
    ? audience.includes(options.clientId)
    : audience === options.clientId;
  if (!audienceOk) throw new AppleIdTokenError("aud");
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SECONDS < nowSeconds) {
    throw new AppleIdTokenError("exp");
  }
  if (typeof claims.iat === "number" && claims.iat - CLOCK_SKEW_SECONDS > nowSeconds) {
    throw new AppleIdTokenError("iat");
  }
  if (claims.nonce !== options.expectedNonce) throw new AppleIdTokenError("nonce");
  if (typeof claims.sub !== "string" || claims.sub.length === 0) {
    throw new AppleIdTokenError("sub");
  }

  return {
    sub: claims.sub,
    email: typeof claims.email === "string" && claims.email ? claims.email : null,
    emailVerified: claimBool(claims.email_verified),
    isPrivateEmail: claimBool(claims.is_private_email),
  };
}

let cachedKeys: { keys: AppleJwk[]; fetchedAt: number } | null = null;
const KEYS_TTL_MS = 60 * 60 * 1000;

/** Apple'in genel anahtarlari; bir saat onbellekte. `kid` bulunamazsa cagiran yeniler. */
export async function fetchAppleJwks(options: { force?: boolean } = {}): Promise<AppleJwk[]> {
  if (!options.force && cachedKeys && Date.now() - cachedKeys.fetchedAt < KEYS_TTL_MS) {
    return cachedKeys.keys;
  }
  const response = await fetch(APPLE_KEYS_URL);
  if (!response.ok) throw new Error("Apple JWKS alinamadi");
  const payload = (await response.json()) as { keys?: unknown };
  if (!Array.isArray(payload.keys)) throw new Error("Apple JWKS bicimi beklenmedik");
  const keys = payload.keys.filter(
    (key): key is AppleJwk => typeof key === "object" && key !== null && "kid" in key,
  );
  cachedKeys = { keys, fetchedAt: Date.now() };
  return keys;
}

/** `code` -> `id_token`. Access/refresh token'lar okunmaz, saklanmaz. */
export async function exchangeAppleCode(
  config: AppleConfig,
  input: { code: string; redirectUri: string },
): Promise<string> {
  const response = await fetch(APPLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: createAppleClientSecret(config),
      code: input.code,
      grant_type: "authorization_code",
      redirect_uri: input.redirectUri,
    }),
  });
  if (!response.ok) throw new Error("Apple token exchange failed");
  const payload = (await response.json()) as { id_token?: unknown };
  if (typeof payload.id_token !== "string" || !payload.id_token) {
    throw new Error("Apple token response missing id_token");
  }
  return payload.id_token;
}

/** Apple yalnizca ILK giriste `user` alanini (ad) form ile gonderir. Guvenilir kaynak degil. */
export function displayNameFromAppleUser(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { name?: { firstName?: unknown; lastName?: unknown } };
    const parts = [parsed.name?.firstName, parsed.name?.lastName].filter(
      (part): part is string => typeof part === "string" && part.trim().length > 0,
    );
    return parts.length > 0 ? parts.join(" ").slice(0, 120) : null;
  } catch {
    return null;
  }
}

export interface SignInWithAppleInput {
  claims: AppleIdTokenClaims;
  displayName: string | null;
  ip: string | null;
  userAgent: string | null;
}

/**
 * E-posta YALNIZCA dogrulanmis id_token'dan alinir; form alanindaki `user`
 * JSON'u imzasizdir ve e-posta icin kullanilmaz (yalnizca ad).
 */
export function signInWithApple(
  db: Database,
  input: SignInWithAppleInput,
): Promise<SignInWithIdentityResult> {
  return signInWithIdentity(db, {
    provider: "apple",
    subject: input.claims.sub,
    email: input.claims.email,
    emailVerified: input.claims.email !== null && input.claims.emailVerified,
    displayName: input.displayName,
    ip: input.ip,
    userAgent: input.userAgent,
  });
}
