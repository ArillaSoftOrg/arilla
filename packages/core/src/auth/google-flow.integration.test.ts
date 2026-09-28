/**
 * Google ile giris uctan uca (code -> token -> profil -> kullanici ->
 * erken erisim -> oturum) - gercek Postgres, sahte Google (fetch enjekte).
 * Gercek Google'a hic istek gitmez.
 */
import type { Database } from "@arilla/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { classifyGoogleFailure, completeGoogleSignIn, GoogleOAuthError } from "./google-flow.ts";
import { GoogleEmailNotVerifiedError } from "./google-oauth.ts";
import { verifySessionToken } from "./session.ts";

const suffix = Date.now();
const config = { clientId: "123-abc.apps.googleusercontent.com", clientSecret: "test-secret" };
const redirectUri = "http://localhost:3000/giris/google/callback";
const request = { ip: "203.0.113.90", userAgent: "vitest" };

interface Profile {
  sub: string;
  email: string;
  email_verified?: boolean;
}

function google(profile: Profile, token: { status?: number; body?: unknown } = {}) {
  const calls: string[] = [];
  const impl = (async (url: string | URL | Request) => {
    calls.push(String(url));
    if (String(url).includes("/token")) {
      return Response.json(token.body ?? { access_token: "fake-access" }, {
        status: token.status ?? 200,
      });
    }
    return Response.json({ email_verified: true, ...profile });
  }) as typeof fetch;
  return { impl, calls };
}

function signIn(db: Database, impl: typeof fetch) {
  return completeGoogleSignIn(
    db,
    { code: "fake-code", redirectUri, ...request },
    { config, fetchImpl: impl },
  );
}

async function count(sql: string, params: unknown[]): Promise<number> {
  return withOwnerClient(async (client) =>
    Number((await client.query(sql, params)).rows[0]?.n ?? 0),
  );
}

const email = (label: string) => `g-${label}-${suffix}@example.test`;
const sub = (label: string) => `g-sub-${label}-${suffix}`;

describe("Google ile giris - entegrasyon", () => {
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
           WHERE provider = 'google' AND provider_subject LIKE $1)`,
        [`g-sub-%-${suffix}`],
      );
      await client.query("DELETE FROM app_user WHERE email LIKE $1", [
        `g-%-${suffix}@example.test`,
      ]);
    });
  });

  it("ilk giris: kullanici, kimlik, oturum ve erken erisim kaydi olusur", async () => {
    vi.stubEnv("PRODUCT_ACCESS", "");
    const { impl, calls } = google({ sub: sub("first"), email: email("first") });
    const result = await signIn(db, impl);

    expect(result.isNewUser).toBe(true);
    expect(calls).toHaveLength(2);
    expect((await verifySessionToken(db, result.rawSessionToken))?.id).toBe(result.user.id);
    expect(
      await count(
        "SELECT count(*)::int AS n FROM user_identity WHERE provider = 'google' AND provider_subject = $1",
        [sub("first")],
      ),
    ).toBe(1);
    expect(
      await count("SELECT count(*)::int AS n FROM early_access WHERE user_id = $1", [
        result.user.id,
      ]),
    ).toBe(1);
  });

  it("mevcut Google kimligi: ayni kullanici, yeni kayit yok", async () => {
    const { impl } = google({ sub: sub("first"), email: email("first") });
    const again = await signIn(db, impl);
    expect(again.isNewUser).toBe(false);
    expect(
      await count("SELECT count(*)::int AS n FROM early_access WHERE user_id = $1", [
        again.user.id,
      ]),
    ).toBe(1);
  });

  it("mevcut e-posta hesabi dogrulanmis Google e-postasiyla baglanir", async () => {
    const existingId = await withOwnerClient(async (client) =>
      Number(
        (
          await client.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
            email("existing"),
          ])
        ).rows[0].id,
      ),
    );
    // Google e-postayi buyuk harfle dondurse de ayni hesaba baglanir.
    const { impl } = google({ sub: sub("existing"), email: email("existing").toUpperCase() });
    const result = await signIn(db, impl);
    expect(result.user.id).toBe(existingId);
    expect(result.isNewUser).toBe(false);
  });

  it("dogrulanmamis e-posta: hesap acilmaz, baglanmaz", async () => {
    const { impl } = google({
      sub: sub("unverified"),
      email: email("unverified"),
      email_verified: false,
    });
    const error = await signIn(db, impl).catch((e) => e);
    expect(error).toBeInstanceOf(GoogleEmailNotVerifiedError);
    expect(classifyGoogleFailure(error)).toBe("email_unverified");
    expect(
      await count("SELECT count(*)::int AS n FROM app_user WHERE email = $1", [
        email("unverified"),
      ]),
    ).toBe(0);
  });

  it("token degisimi basarisiz: veritabanina dokunulmaz, kategori loglanabilir", async () => {
    const { impl, calls } = google(
      { sub: sub("tokenfail"), email: email("tokenfail") },
      { status: 401, body: { error: "invalid_client" } },
    );
    const error = await signIn(db, impl).catch((e) => e);
    expect(error).toBeInstanceOf(GoogleOAuthError);
    expect(classifyGoogleFailure(error)).toBe("token:http_401:invalid_client");
    expect(calls).toHaveLength(1);
    expect(
      await count("SELECT count(*)::int AS n FROM app_user WHERE email = $1", [email("tokenfail")]),
    ).toBe(0);
  });

  it("esanli ilk girisler tek kullanici ve tek erken erisim kaydi", async () => {
    vi.stubEnv("PRODUCT_ACCESS", "");
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        signIn(db, google({ sub: sub("race"), email: email("race") }).impl),
      ),
    );
    const ids = new Set(results.map((r) => r.user.id));
    expect(ids.size).toBe(1);
    const [id] = [...ids];
    expect(
      await count("SELECT count(*)::int AS n FROM app_user WHERE email = $1", [email("race")]),
    ).toBe(1);
    expect(
      await count("SELECT count(*)::int AS n FROM early_access WHERE user_id = $1", [id]),
    ).toBe(1);
  });
});
