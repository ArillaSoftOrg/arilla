import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { deleteSession, verifySessionToken } from "./session.ts";
import { hashToken } from "./token.ts";

describe("session - entegrasyon (gerçek seed Postgres)", () => {
  let db: Database;
  const suffix = Date.now();
  const email = `e1-test-session-${suffix}@example.test`;
  let userId = 0;

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const result = await client.query(
        "INSERT INTO app_user (email, role) VALUES ($1, 'moderator') RETURNING id",
        [email],
      );
      userId = Number(result.rows[0].id);
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM session WHERE user_id = $1", [userId]);
      await client.query("DELETE FROM app_user WHERE id = $1", [userId]);
    });
  });

  async function insertSession(rawToken: string, expiresAt: Date) {
    await withOwnerClient((client) =>
      client.query("INSERT INTO session (user_id, token_hash, expires_at) VALUES ($1, $2, $3)", [
        userId,
        hashToken(rawToken),
        expiresAt,
      ]),
    );
  }

  it("geçerli bir token için kullanıcıyı ve rolünü döner", async () => {
    const rawToken = `sess-${suffix}-valid`;
    await insertSession(rawToken, new Date(Date.now() + 60 * 60 * 1000));

    const result = await verifySessionToken(db, rawToken);

    expect(result).not.toBeNull();
    expect(result?.id).toBe(userId);
    expect(result?.role).toBe("moderator");
  });

  it("süresi dolmuş bir token için null döner", async () => {
    const rawToken = `sess-${suffix}-expired`;
    await insertSession(rawToken, new Date(Date.now() - 1000));

    expect(await verifySessionToken(db, rawToken)).toBeNull();
  });

  it("bilinmeyen bir token için null döner", async () => {
    expect(await verifySessionToken(db, `sess-${suffix}-unknown`)).toBeNull();
  });

  it("deleteSession sonrası token artık geçerli değildir", async () => {
    const rawToken = `sess-${suffix}-deleted`;
    await insertSession(rawToken, new Date(Date.now() + 60 * 60 * 1000));
    expect(await verifySessionToken(db, rawToken)).not.toBeNull();

    await deleteSession(db, rawToken);

    expect(await verifySessionToken(db, rawToken)).toBeNull();
  });
});
