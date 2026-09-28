/**
 * Apple ile giris uctan uca (code -> id_token -> dogrulama -> kullanici ->
 * kimlik -> oturum -> erken erisim) - gercek Postgres, sahte Apple.
 * Gercek Apple'a hic istek gitmez.
 */
import type { Database } from "@arilla/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import {
  AppleIdTokenError,
  classifyAppleFailure,
  completeAppleSignIn,
  hashNonce,
} from "./apple-oauth.ts";
import { createFakeApple, testAppleConfig } from "./apple-test-kit.ts";
import { verifySessionToken } from "./session.ts";

const suffix = Date.now();
const config = testAppleConfig();
const apple = createFakeApple();
const RAW_NONCE = "raw-nonce-for-test";
const redirectUri = "http://localhost:3000/giris/apple/callback";
const request = { ip: "203.0.113.120", userAgent: "vitest" };
const sub = (label: string) => `apple-${label}-${suffix}`;
const email = (label: string) => `apple-${label}-${suffix}@privaterelay.example.test`;

function signIn(
  db: Database,
  claims: Record<string, unknown>,
  options: {
    rawNonce?: string;
    userJson?: string | null;
    tokenStatus?: number;
    tokenBody?: unknown;
  } = {},
  getKeys = async () => [apple.jwk],
) {
  const token = apple.idToken({ nonce: hashNonce(RAW_NONCE), ...claims });
  const { impl, calls } = apple.fetchReturning({
    status: options.tokenStatus,
    body: options.tokenBody ?? { id_token: token },
  });
  const result = completeAppleSignIn(
    db,
    {
      code: "fake-code",
      rawNonce: options.rawNonce ?? RAW_NONCE,
      userJson: options.userJson ?? null,
      redirectUri,
      ...request,
    },
    { config, fetchImpl: impl, getKeys },
  );
  return { result, calls };
}

async function count(sql: string, params: unknown[]): Promise<number> {
  return withOwnerClient(async (client) =>
    Number((await client.query(sql, params)).rows[0]?.n ?? 0),
  );
}

describe("Apple ile giris - entegrasyon", () => {
  let db: Database;

  beforeAll(() => {
    db = getTestDb();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query(
        `DELETE FROM app_user WHERE id IN (SELECT user_id FROM user_identity
           WHERE provider = 'apple' AND provider_subject LIKE $1)`,
        [`apple-%-${suffix}`],
      );
      await client.query("DELETE FROM app_user WHERE email LIKE $1", [`apple-%-${suffix}@%`]);
    });
  });

  it("ilk giris: kullanici, kimlik, oturum, erken erisim; ad yalnizca formdan", async () => {
    vi.stubEnv("PRODUCT_ACCESS", "");
    const { result, calls } = signIn(
      db,
      { sub: sub("first"), email: email("first"), email_verified: "true" },
      { userJson: JSON.stringify({ name: { firstName: "Ayşe", lastName: "Y." } }) },
    );
    const signedIn = await result;
    expect(signedIn.isNewUser).toBe(true);
    expect(signedIn.user.email).toBe(email("first"));
    expect(new URLSearchParams(calls[0]?.body).get("redirect_uri")).toBe(redirectUri);
    expect((await verifySessionToken(db, signedIn.rawSessionToken))?.id).toBe(signedIn.user.id);
    expect(
      await count("SELECT count(*)::int n FROM early_access WHERE user_id = $1", [
        signedIn.user.id,
      ]),
    ).toBe(1);
  });

  it("sonraki giris e-postasiz: ayni kullanici, kayitli e-posta korunur", async () => {
    const { result } = signIn(db, { sub: sub("first") });
    const again = await result;
    expect(again.isNewUser).toBe(false);
    expect(again.user.email).toBe(email("first"));
    const stored = await withOwnerClient((c) =>
      c.query(
        "SELECT email FROM user_identity WHERE provider = 'apple' AND provider_subject = $1",
        [sub("first")],
      ),
    );
    expect(stored.rows[0]?.email).toBe(email("first"));
  });

  it("dogrulanmis Apple e-postasi mevcut hesaba baglanir; dogrulanmamis baglanmaz", async () => {
    const existingId = await withOwnerClient(async (c) =>
      Number(
        (
          await c.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
            email("existing"),
          ])
        ).rows[0].id,
      ),
    );
    const linked = await signIn(db, {
      sub: sub("existing"),
      email: email("existing"),
      email_verified: true,
    }).result;
    expect(linked.user.id).toBe(existingId);

    const unverified = await signIn(db, {
      sub: sub("unverified"),
      email: email("existing"),
      email_verified: "false",
    }).result;
    expect(unverified.user.id).not.toBe(existingId);
    expect(unverified.user.email).toBeNull();
  });

  it.each([
    ["yanlis nonce", {}, { rawNonce: "baska-nonce" }, "id_token:nonce"],
    ["yanlis issuer", { iss: "https://evil.example" }, {}, "id_token:issuer"],
    ["yanlis audience", { aud: "com.baska.uygulama" }, {}, "id_token:audience"],
    ["suresi dolmus", { exp: Math.floor(Date.now() / 1000) - 3600 }, {}, "id_token:expired"],
  ])("%s: oturum acilmaz, kategori %s", async (_label, claims, options, category) => {
    const { result } = signIn(db, { sub: sub("bad"), email: email("bad"), ...claims }, options);
    const error = await result.catch((e) => e);
    expect(error).toBeInstanceOf(AppleIdTokenError);
    expect(classifyAppleFailure(error)).toBe(category);
    expect(
      await count(
        "SELECT count(*)::int n FROM user_identity WHERE provider = 'apple' AND provider_subject = $1",
        [sub("bad")],
      ),
    ).toBe(0);
  });

  it("baska anahtarla imzalanmis token reddedilir", async () => {
    const other = createFakeApple(apple.jwk.kid);
    const token = other.idToken({ sub: sub("forged"), nonce: hashNonce(RAW_NONCE) });
    const { impl } = apple.fetchReturning({ body: { id_token: token } });
    const error = await completeAppleSignIn(
      db,
      { code: "c", rawNonce: RAW_NONCE, userJson: null, redirectUri, ...request },
      { config, fetchImpl: impl, getKeys: async () => [apple.jwk] },
    ).catch((e) => e);
    expect(classifyAppleFailure(error)).toBe("id_token:signature");
  });

  it("anahtar donmusse (kid yok) liste bir kez yenilenir", async () => {
    const forced: boolean[] = [];
    const { result } = signIn(db, { sub: sub("rotated") }, {}, async (force = false) => {
      forced.push(force);
      return force ? [apple.jwk] : [];
    });
    expect((await result).isNewUser).toBe(true);
    expect(forced).toEqual([false, true]);
  });

  it("token ucu reddederse veritabanina dokunulmaz", async () => {
    const { result } = signIn(
      db,
      { sub: sub("tokenfail") },
      { tokenStatus: 400, tokenBody: { error: "invalid_client" } },
    );
    expect(classifyAppleFailure(await result.catch((e) => e))).toBe(
      "token:http_400:invalid_client",
    );
    expect(
      await count(
        "SELECT count(*)::int n FROM user_identity WHERE provider = 'apple' AND provider_subject = $1",
        [sub("tokenfail")],
      ),
    ).toBe(0);
  });

  it("esanli ilk girisler tek kullanici ve tek erken erisim kaydi", async () => {
    vi.stubEnv("PRODUCT_ACCESS", "");
    const results = await Promise.all(
      Array.from({ length: 5 }, () => signIn(db, { sub: sub("race") }).result),
    );
    const ids = new Set(results.map((r) => r.user.id));
    expect(ids.size).toBe(1);
    expect(
      await count("SELECT count(*)::int n FROM early_access WHERE user_id = $1", [[...ids][0]]),
    ).toBe(1);
  });
});
