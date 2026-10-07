import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSessionForUser } from "../auth/session.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { getConsents, setConsent } from "./consent.ts";
import { completeOnboarding, needsOnboarding } from "./onboarding.ts";

describe("onboarding ve yeni hesap rıza varsayılanları - entegrasyon (gerçek Postgres)", () => {
  let db: Database;
  const suffix = Date.now();
  const ids: number[] = [];

  async function createUser(label: string, onboarded = false): Promise<number> {
    return withOwnerClient(async (client) => {
      const row = await client.query(
        "INSERT INTO app_user (email, onboarded_at) VALUES ($1, $2) RETURNING id",
        [`onb-${label}-${suffix}@example.test`, onboarded ? new Date() : null],
      );
      const id = Number(row.rows[0].id);
      ids.push(id);
      return id;
    });
  }

  function signIn(userId: number, isNewUser: boolean) {
    return createSessionForUser(db, {
      userId,
      role: "user",
      ip: null,
      userAgent: null,
      provider: "email",
      isNewUser,
    });
  }

  beforeAll(() => {
    db = getTestDb();
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM user_consent WHERE user_id = ANY($1)", [ids]);
      await client.query("DELETE FROM app_user WHERE id = ANY($1)", [ids]);
    });
  });

  it("yeni hesap: kişiselleştirme ve anonim keşif AÇIK, haftalık özet KAPALI", async () => {
    const userId = await createUser("new");
    await signIn(userId, true);
    expect(await getConsents(db, userId)).toEqual({
      browsing_history: true,
      personalization: true,
      public_discovery: true,
      marketing_email: false,
    });
  });

  it("mevcut hesabın açık tercihi tekrar girişte ezilmez ve varsayılan yazılmaz", async () => {
    const userId = await createUser("existing", true);
    await setConsent(db, { userId, kind: "personalization", granted: false, ip: null });
    await signIn(userId, false);
    const consents = await getConsents(db, userId);
    expect(consents.personalization).toBe(false);
    expect(consents.public_discovery).toBe(false);
    expect(consents.browsing_history).toBe(false);
  });

  it("needsOnboarding: yeni hesap true, tamamlanmış hesap false", async () => {
    expect(await needsOnboarding(db, await createUser("fresh"))).toBe(true);
    expect(await needsOnboarding(db, await createUser("done", true))).toBe(false);
  });

  it("bülten açıkça açılırsa true yazılır ve karşılama kapanır", async () => {
    const userId = await createUser("optin");
    expect(await completeOnboarding(db, { userId, newsletter: true, ip: null })).toBe(true);
    expect((await getConsents(db, userId)).marketing_email).toBe(true);
    expect(await needsOnboarding(db, userId)).toBe(false);
  });

  it("devam/atla (newsletter=false) bülteni false bırakır ve karşılama kapanır", async () => {
    const userId = await createUser("optout");
    expect(await completeOnboarding(db, { userId, newsletter: false, ip: null })).toBe(true);
    expect((await getConsents(db, userId)).marketing_email).toBe(false);
    expect(await needsOnboarding(db, userId)).toBe(false);
  });

  it("tamamlanmış karşılama tekrar yazmaz: sonradan gelen karar ezilmez", async () => {
    const userId = await createUser("replay");
    await completeOnboarding(db, { userId, newsletter: false, ip: null });
    expect(await completeOnboarding(db, { userId, newsletter: true, ip: null })).toBe(false);
    expect((await getConsents(db, userId)).marketing_email).toBe(false);
  });
});
