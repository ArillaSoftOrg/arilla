import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { RateLimitExceededError } from "./rate-limit.ts";
import { requestLoginLink } from "./request-login-link.ts";

/** Gerçek Redis (oran sınırı) ve gerçek SMTP (Mailpit) gerektirir - `docker compose up -d`. */
describe("requestLoginLink() - entegrasyon (gerçek Postgres + Redis + Mailpit)", () => {
  let db: Database;
  const suffix = Date.now();
  const email = `e1-test-request-${suffix}@example.test`;

  beforeAll(() => {
    db = getTestDb();
  });

  afterAll(async () => {
    await withOwnerClient((client) =>
      client.query("DELETE FROM auth_token WHERE email = $1", [email]),
    );
  });

  it("bir auth_token satırı yazar ve app_user'a dokunmaz", async () => {
    const result = await requestLoginLink(db, { email, ip: "203.0.113.1" });
    expect(result.authTokenId).toBeGreaterThan(0);

    const rows = await withOwnerClient((client) =>
      client.query("SELECT email, consumed_at, expires_at FROM auth_token WHERE id = $1", [
        result.authTokenId,
      ]),
    );
    expect(rows.rows[0].email).toBe(email);
    expect(rows.rows[0].consumed_at).toBeNull();

    const userRows = await withOwnerClient((client) =>
      client.query("SELECT id FROM app_user WHERE email = $1", [email]),
    );
    expect(userRows.rows).toHaveLength(0);
  });

  it("aynı e-posta için ardışık istekte RateLimitExceededError fırlatır", async () => {
    const rateLimitedEmail = `e1-test-ratelimit-${suffix}@example.test`;
    try {
      await requestLoginLink(db, { email: rateLimitedEmail, ip: "203.0.113.2" });
      await expect(
        requestLoginLink(db, { email: rateLimitedEmail, ip: "203.0.113.2" }),
      ).rejects.toThrow(RateLimitExceededError);
    } finally {
      await withOwnerClient((client) =>
        client.query("DELETE FROM auth_token WHERE email = $1", [rateLimitedEmail]),
      );
    }
  });
});
