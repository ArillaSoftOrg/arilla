import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { getConsents, setConsent } from "./consent.ts";

describe("consent - entegrasyon (gerçek Postgres)", () => {
  let db: Database;
  const suffix = Date.now();
  let userId = 0;

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const user = await client.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
        `e3-consent-${suffix}@example.test`,
      ]);
      userId = Number(user.rows[0].id);
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM user_consent WHERE user_id = $1", [userId]);
      await client.query("DELETE FROM app_user WHERE id = $1", [userId]);
    });
  });

  it("hiç kayıt yokken tüm izinler false döner", async () => {
    const consents = await getConsents(db, userId);
    expect(consents).toEqual({
      browsing_history: false,
      marketing_email: false,
      personalization: false,
      public_discovery: false,
    });
  });

  it("setConsent yeni satır ekler, getConsents en son satırı döner", async () => {
    await setConsent(db, { userId, kind: "personalization", granted: true, ip: "127.0.0.1" });
    expect((await getConsents(db, userId)).personalization).toBe(true);

    // Ayni kind icin ikinci kez cagirmak GUNCELLEMEZ, yeni satir ekler (audit trail).
    await setConsent(db, { userId, kind: "personalization", granted: false, ip: null });
    expect((await getConsents(db, userId)).personalization).toBe(false);

    const rows = await withOwnerClient((client) =>
      client.query(
        "SELECT granted FROM user_consent WHERE user_id = $1 AND kind = 'personalization' ORDER BY granted_at",
        [userId],
      ),
    );
    expect(rows.rows).toHaveLength(2);
  });

  it("marketing_email genel yoldan yazılamaz (kaynak ve metin sürümü zorunlu, 0046)", async () => {
    await expect(
      setConsent(db, {
        userId,
        kind: "marketing_email" as "personalization",
        granted: true,
        ip: null,
      }),
    ).rejects.toThrow(/recordMarketingEmailConsent/);
    expect((await getConsents(db, userId)).marketing_email).toBe(false);
  });
});
