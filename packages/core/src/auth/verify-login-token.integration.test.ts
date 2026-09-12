import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { hashToken } from "./token.ts";
import {
  TokenAlreadyUsedError,
  TokenExpiredError,
  TokenNotFoundError,
  verifyLoginToken,
} from "./verify-login-token.ts";

describe("verifyLoginToken() - entegrasyon (gerçek seed Postgres)", () => {
  let db: Database;
  const suffix = Date.now();
  const newUserEmail = `e1-test-new-${suffix}@example.test`;
  const existingUserEmail = `e1-test-existing-${suffix}@example.test`;
  let existingAppUserId = 0;

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const result = await client.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
        existingUserEmail,
      ]);
      existingAppUserId = Number(result.rows[0].id);
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query(
        "DELETE FROM session WHERE user_id IN (SELECT id FROM app_user WHERE email = ANY($1))",
        [[newUserEmail, existingUserEmail]],
      );
      await client.query("DELETE FROM auth_token WHERE email = ANY($1)", [
        [newUserEmail, existingUserEmail],
      ]);
      await client.query("DELETE FROM app_user WHERE email = ANY($1)", [
        [newUserEmail, existingUserEmail],
      ]);
    });
  });

  async function insertAuthToken(
    email: string,
    rawToken: string,
    overrides: { expiresAt?: Date; consumedAt?: Date } = {},
  ) {
    const expiresAt = overrides.expiresAt ?? new Date(Date.now() + 15 * 60 * 1000);
    await withOwnerClient(async (client) => {
      await client.query(
        "INSERT INTO auth_token (email, token_hash, expires_at, consumed_at) VALUES ($1, $2, $3, $4)",
        [email, hashToken(rawToken), expiresAt, overrides.consumedAt ?? null],
      );
    });
  }

  it("bilinmeyen bir e-posta için yeni app_user açar ve isNewUser=true döner", async () => {
    const rawToken = `raw-${suffix}-new-user`;
    await insertAuthToken(newUserEmail, rawToken);

    const result = await verifyLoginToken(db, { rawToken, ip: null, userAgent: "vitest" });

    expect(result.isNewUser).toBe(true);
    expect(result.user.email).toBe(newUserEmail);
    expect(result.rawSessionToken).toBeTruthy();

    const sessionRows = await withOwnerClient((client) =>
      client.query("SELECT token_hash FROM session WHERE user_id = $1", [result.user.id]),
    );
    expect(sessionRows.rows).toHaveLength(1);
    expect(sessionRows.rows[0].token_hash).toBe(hashToken(result.rawSessionToken));
  });

  it("var olan bir app_user için isNewUser=false döner ve email_verified_at'i günceller", async () => {
    const rawToken = `raw-${suffix}-existing-user`;
    await insertAuthToken(existingUserEmail, rawToken);

    const result = await verifyLoginToken(db, { rawToken, ip: "127.0.0.1", userAgent: null });

    expect(result.isNewUser).toBe(false);
    expect(result.user.id).toBe(existingAppUserId);

    const rows = await withOwnerClient((client) =>
      client.query("SELECT email_verified_at FROM app_user WHERE id = $1", [existingAppUserId]),
    );
    expect(rows.rows[0].email_verified_at).not.toBeNull();
  });

  it("aynı token ikinci kez kullanılınca TokenAlreadyUsedError fırlatır", async () => {
    const rawToken = `raw-${suffix}-reuse`;
    await insertAuthToken(newUserEmail, rawToken);

    await verifyLoginToken(db, { rawToken, ip: null, userAgent: null });
    await expect(verifyLoginToken(db, { rawToken, ip: null, userAgent: null })).rejects.toThrow(
      TokenAlreadyUsedError,
    );
  });

  it("süresi dolmuş bir token için TokenExpiredError fırlatır", async () => {
    const rawToken = `raw-${suffix}-expired`;
    await insertAuthToken(newUserEmail, rawToken, { expiresAt: new Date(Date.now() - 1000) });

    await expect(verifyLoginToken(db, { rawToken, ip: null, userAgent: null })).rejects.toThrow(
      TokenExpiredError,
    );
  });

  it("hiç var olmayan bir token için TokenNotFoundError fırlatır", async () => {
    await expect(
      verifyLoginToken(db, { rawToken: `raw-${suffix}-does-not-exist`, ip: null, userAgent: null }),
    ).rejects.toThrow(TokenNotFoundError);
  });
});
