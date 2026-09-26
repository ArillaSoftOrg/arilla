import { generateKeyPairSync, sign, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  APPLE_ISSUER,
  AppleIdTokenError,
  type AppleJwk,
  createAppleClientSecret,
  displayNameFromAppleUser,
  hashNonce,
  verifyAppleIdToken,
} from "./apple-oauth.ts";

const CLIENT_ID = "com.arilla.test.web";
const NOW = new Date("2026-09-26T12:00:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);
const RAW_NONCE = "ham-nonce";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KEY: AppleJwk = { ...publicKey.export({ format: "jwk" }), kid: "test-kid", alg: "RS256" };

function b64(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function makeToken(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = { alg: "RS256", kid: "test-kid" },
  signer = privateKey,
): string {
  const payload = {
    iss: APPLE_ISSUER,
    aud: CLIENT_ID,
    sub: "001234.apple-sub.0001",
    iat: NOW_S - 10,
    exp: NOW_S + 600,
    nonce: hashNonce(RAW_NONCE),
    email: "abc@privaterelay.appleid.com",
    email_verified: "true",
    is_private_email: "true",
    ...claims,
  };
  const input = `${b64(header)}.${b64(payload)}`;
  return `${input}.${sign("sha256", Buffer.from(input), signer).toString("base64url")}`;
}

function check(token: string) {
  return verifyAppleIdToken(token, {
    clientId: CLIENT_ID,
    expectedNonce: hashNonce(RAW_NONCE),
    keys: [KEY],
    now: NOW,
  });
}

function reason(token: string): string {
  try {
    check(token);
  } catch (error) {
    if (error instanceof AppleIdTokenError) return error.reason;
    throw error;
  }
  return "gecerli";
}

describe("verifyAppleIdToken", () => {
  it("accepts a correctly signed token and returns the Apple subject", () => {
    expect(check(makeToken())).toEqual({
      sub: "001234.apple-sub.0001",
      email: "abc@privaterelay.appleid.com",
      emailVerified: true,
      isPrivateEmail: true,
    });
  });

  it("works when Apple returns no email (later sign-ins)", () => {
    const claims = check(makeToken({ email: undefined, email_verified: undefined }));
    expect(claims.sub).toBe("001234.apple-sub.0001");
    expect(claims.email).toBeNull();
    expect(claims.emailVerified).toBe(false);
  });

  it.each([
    ["iss", { iss: "https://evil.example" }],
    ["aud", { aud: "com.someone.else" }],
    ["exp", { exp: NOW_S - 3600 }],
    ["iat", { iat: NOW_S + 3600 }],
    ["nonce", { nonce: hashNonce("baska-nonce") }],
    ["sub", { sub: "" }],
  ])("rejects a bad %s claim", (expected, claims) => {
    expect(reason(makeToken(claims))).toBe(expected);
  });

  it("rejects a token signed with another key", () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    expect(reason(makeToken({}, undefined, other))).toBe("imza");
  });

  it("rejects a tampered payload", () => {
    const [header, , signature] = makeToken().split(".");
    const forged = `${header}.${b64({ iss: APPLE_ISSUER, aud: CLIENT_ID, sub: "saldirgan", exp: NOW_S + 600, nonce: hashNonce(RAW_NONCE) })}.${signature}`;
    expect(reason(forged)).toBe("imza");
  });

  it("does not let the token choose its algorithm", () => {
    expect(reason(makeToken({}, { alg: "none", kid: "test-kid" }))).toBe("alg/kid");
    expect(reason(makeToken({}, { alg: "HS256", kid: "test-kid" }))).toBe("alg/kid");
  });

  it("rejects an unknown key id", () => {
    expect(reason(makeToken({}, { alg: "RS256", kid: "baska" }))).toBe("bilinmeyen kid");
  });

  it("accepts an audience array that contains the client id", () => {
    expect(check(makeToken({ aud: ["x", CLIENT_ID] })).sub).toBe("001234.apple-sub.0001");
  });
});

describe("createAppleClientSecret", () => {
  it("produces an ES256 JWT Apple can verify with the key's public half", () => {
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pem = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const jwt = createAppleClientSecret(
      { clientId: CLIENT_ID, teamId: "TEAM123456", keyId: "KEY1234567", privateKey: pem },
      NOW,
    );
    const [header = "", payload = "", signature = ""] = jwt.split(".");

    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "ES256",
      kid: "KEY1234567",
    });
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toMatchObject({
      iss: "TEAM123456",
      sub: CLIENT_ID,
      aud: APPLE_ISSUER,
      iat: NOW_S,
    });
    const ok = verify(
      "sha256",
      Buffer.from(`${header}.${payload}`),
      { key: pair.publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"),
    );
    expect(ok).toBe(true);
  });
});

describe("displayNameFromAppleUser", () => {
  it("reads the first-login name and ignores anything malformed", () => {
    expect(displayNameFromAppleUser('{"name":{"firstName":"Ayşe","lastName":"Yılmaz"}}')).toBe(
      "Ayşe Yılmaz",
    );
    expect(displayNameFromAppleUser("{bozuk")).toBeNull();
    expect(displayNameFromAppleUser(null)).toBeNull();
  });
});
