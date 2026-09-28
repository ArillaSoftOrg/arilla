/**
 * Esanli ilk giris yarisi - gercek Postgres. Ayni kimlik icin paralel ilk
 * girislerin hepsi basarili olmali ve tek bir kullanici olusmali.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { signInWithGoogle } from "./google-oauth.ts";
import { signInWithIdentity } from "./identity-sign-in.ts";
import { generateRawToken, hashToken } from "./token.ts";
import { verifyLoginToken } from "./verify-login-token.ts";

const suffix = Date.now();
const PARALLEL = 5;
const EMAIL = `race-email-${suffix}@example.test`;
const GOOGLE_EMAIL = `race-google-${suffix}@example.test`;
const GOOGLE_SUB = `race-google-sub-${suffix}`;
const APPLE_SUB = `race-apple-sub-${suffix}`;
const request = { ip: "203.0.113.50", userAgent: "vitest" };

async function usersFor(sql: string, params: unknown[]): Promise<number[]> {
  return withOwnerClient(async (client) => {
    const res = await client.query(sql, params);
    return res.rows.map((row: { id: string }) => Number(row.id));
  });
}

async function cleanup(): Promise<void> {
  await withOwnerClient(async (client) => {
    const ids = `SELECT user_id FROM user_identity
                  WHERE (provider = 'google' AND provider_subject = $1)
                     OR (provider = 'apple' AND provider_subject = $2)`;
    await client.query(`DELETE FROM app_user WHERE id IN (${ids})`, [GOOGLE_SUB, APPLE_SUB]);
    await client.query("DELETE FROM app_user WHERE email = ANY($1)", [[EMAIL, GOOGLE_EMAIL]]);
    await client.query("DELETE FROM auth_token WHERE email = $1", [EMAIL]);
  });
}

describe("esanli ilk giris - entegrasyon", () => {
  let db: Database;

  beforeAll(async () => {
    db = getTestDb();
    await cleanup();
  });

  afterAll(cleanup);

  it("e-posta: ayni adrese ait paralel baglantilar tek kullanici acar", async () => {
    const rawTokens = Array.from({ length: PARALLEL }, () => generateRawToken());
    await withOwnerClient(async (client) => {
      for (const raw of rawTokens) {
        await client.query(
          "INSERT INTO auth_token (email, token_hash, expires_at) VALUES ($1, $2, now() + interval '15 minutes')",
          [EMAIL, hashToken(raw)],
        );
      }
    });

    const results = await Promise.all(
      rawTokens.map((rawToken) => verifyLoginToken(db, { rawToken, ...request })),
    );

    const ids = new Set(results.map((result) => result.user.id));
    expect(ids.size).toBe(1);
    expect(results.filter((result) => result.isNewUser)).toHaveLength(1);
    expect(await usersFor("SELECT id FROM app_user WHERE email = $1", [EMAIL])).toHaveLength(1);
  });

  it("Google: ayni sub icin paralel ilk girisler tek kullanici ve tek kimlik olusturur", async () => {
    const profile = {
      sub: GOOGLE_SUB,
      email: GOOGLE_EMAIL,
      emailVerified: true,
      name: "Yaris Testi",
      picture: null,
    };
    const results = await Promise.all(
      Array.from({ length: PARALLEL }, () => signInWithGoogle(db, { profile, ...request })),
    );

    expect(new Set(results.map((result) => result.user.id)).size).toBe(1);
    expect(await usersFor("SELECT id FROM app_user WHERE email = $1", [GOOGLE_EMAIL])).toHaveLength(
      1,
    );
    expect(
      await usersFor(
        "SELECT id FROM user_identity WHERE provider = 'google' AND provider_subject = $1",
        [GOOGLE_SUB],
      ),
    ).toHaveLength(1);
  });

  it("Apple/telefon: e-postasiz kimlik icin paralel ilk girisler tek kullanici acar", async () => {
    const results = await Promise.all(
      Array.from({ length: PARALLEL }, () =>
        signInWithIdentity(db, {
          provider: "apple",
          subject: APPLE_SUB,
          email: null,
          emailVerified: false,
          displayName: null,
          ...request,
        }),
      ),
    );

    expect(new Set(results.map((result) => result.user.id)).size).toBe(1);
    expect(results.filter((result) => result.isNewUser)).toHaveLength(1);
    const identities = await usersFor(
      "SELECT user_id AS id FROM user_identity WHERE provider = 'apple' AND provider_subject = $1",
      [APPLE_SUB],
    );
    expect(identities).toHaveLength(1);
    // Kaybeden islemin actigi kullanici geri alindi: sahipsiz app_user kalmadi.
    const orphans = await usersFor(
      `SELECT u.id FROM app_user u
        WHERE u.created_at > now() - interval '1 minute' AND u.email IS NULL
          AND NOT EXISTS (SELECT 1 FROM user_identity i WHERE i.user_id = u.id)`,
      [],
    );
    expect(orphans).toEqual([]);
  });
});
