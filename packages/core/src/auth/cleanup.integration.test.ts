/**
 * Suresi dolmus giris kayitlari temizligi - gercek Postgres. Temizlik
 * tablonun tamamina uygulanir; testler yalnizca kendi satirlarini denetler.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { cleanupExpiredAuthRecords } from "./cleanup.ts";

const suffix = Date.now();
const EMAIL = `cleanup-${suffix}@example.test`;
const PHONE = `+90555${String(suffix).slice(-7)}`;
const HOUR = 60 * 60 * 1000;

type Label = "old" | "recent" | "valid";
const AGE: Record<Label, number> = { old: -48 * HOUR, recent: -1 * HOUR, valid: 24 * HOUR };

let userId = 0;

async function remaining(table: string, column: string, value: string | number) {
  return withOwnerClient(async (client) => {
    const res = await client.query(
      `SELECT marker FROM (
        SELECT CASE WHEN expires_at < now() - interval '1 day' THEN 'old'
                    WHEN expires_at < now() THEN 'recent' ELSE 'valid' END AS marker
          FROM ${table} WHERE ${column} = $1) t ORDER BY marker`,
      [value],
    );
    return res.rows.map((row: { marker: string }) => row.marker);
  });
}

describe("cleanupExpiredAuthRecords - entegrasyon", () => {
  let db: Database;

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const user = await client.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
        EMAIL,
      ]);
      userId = Number(user.rows[0].id);
      for (const label of Object.keys(AGE) as Label[]) {
        const expiresAt = new Date(Date.now() + AGE[label]);
        await client.query(
          "INSERT INTO auth_token (email, token_hash, expires_at) VALUES ($1, $2, $3)",
          [EMAIL, `cleanup-${suffix}-${label}`, expiresAt],
        );
        await client.query(
          "INSERT INTO phone_login_code (phone, code_hash, expires_at) VALUES ($1, $2, $3)",
          [PHONE, `cleanup-${suffix}-${label}`, expiresAt],
        );
        await client.query(
          "INSERT INTO session (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
          [userId, `cleanup-${suffix}-session-${label}`, expiresAt],
        );
      }
      // Tuketilmis ama suresi cok once dolmus baglanti da silinmeli.
      await client.query(
        "INSERT INTO auth_token (email, token_hash, expires_at, consumed_at) VALUES ($1, $2, $3, $3)",
        [EMAIL, `cleanup-${suffix}-consumed`, new Date(Date.now() - 72 * HOUR)],
      );
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM auth_token WHERE email = $1", [EMAIL]);
      await client.query("DELETE FROM phone_login_code WHERE phone = $1", [PHONE]);
      await client.query("DELETE FROM app_user WHERE id = $1", [userId]);
    });
  });

  it("parti tavani asilinca truncated doner, kalanlar sonraki calistirmaya kalir", async () => {
    const result = await cleanupExpiredAuthRecords(db, { batchSize: 1, maxBatches: 1 });
    expect(result.truncated).toBe(true);
  });

  it("yalnizca bir gunden eski suresi dolmus kayitlari siler", async () => {
    const result = await cleanupExpiredAuthRecords(db);
    expect(result.truncated).toBe(false);

    expect(await remaining("auth_token", "email", EMAIL)).toEqual(["recent", "valid"]);
    expect(await remaining("phone_login_code", "phone", PHONE)).toEqual(["recent", "valid"]);
    expect(await remaining("session", "user_id", userId)).toEqual(["recent", "valid"]);
  });

  it("idempotent: ikinci calistirma hicbir sey silmez", async () => {
    const again = await cleanupExpiredAuthRecords(db);
    expect(again).toEqual({ authTokens: 0, phoneLoginCodes: 0, sessions: 0, truncated: false });
    expect(await remaining("auth_token", "email", EMAIL)).toEqual(["recent", "valid"]);
  });
});
