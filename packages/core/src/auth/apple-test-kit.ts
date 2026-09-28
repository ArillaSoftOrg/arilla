/**
 * YALNIZCA testler icin (index'ten disa acilmaz): sahte Apple kimlik
 * saglayicisi. RSA anahtariyla id_token imzalar, JWKS dondurur, token
 * ucunu taklit eden `fetch` uretir; client_secret icin gecerli bir P-256
 * anahtari saglar. Gercek Apple'a hic istek gitmez.
 */
import { generateKeyPairSync, sign } from "node:crypto";
import { APPLE_ISSUER, type AppleConfig, type AppleJwk, hashNonce } from "./apple-oauth.ts";

export const TEST_APPLE_CLIENT_ID = "com.manicepte.test.web";

export function testAppleConfig(): AppleConfig {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    clientId: TEST_APPLE_CLIENT_ID,
    teamId: "TEAMID1234",
    keyId: "KEYID12345",
    privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
}

export function createFakeApple(kid = `kid-${Date.now()}`) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk: AppleJwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256" };
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

  function idToken(claims: Record<string, unknown>, options: { kid?: string } = {}): string {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", kid: options.kid ?? kid };
    const payload = {
      iss: APPLE_ISSUER,
      aud: TEST_APPLE_CLIENT_ID,
      iat: now - 5,
      exp: now + 600,
      ...claims,
    };
    const input = `${b64(header)}.${b64(payload)}`;
    return `${input}.${sign("sha256", Buffer.from(input), privateKey).toString("base64url")}`;
  }

  /** Token ucunu (ve istenirse JWKS'i) taklit eden fetch; cagrilari kaydeder. */
  function fetchReturning(token: { status?: number; body: unknown }) {
    const calls: { url: string; body: string }[] = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      if (String(url).endsWith("/auth/keys")) return Response.json({ keys: [jwk] });
      return Response.json(token.body, { status: token.status ?? 200 });
    }) as typeof fetch;
    return { impl, calls };
  }

  return { jwk, idToken, fetchReturning, nonceClaim: (raw: string) => hashNonce(raw) };
}
