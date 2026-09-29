import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getConsents } from "../account/consent.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { getMarketingEmailPreference, recordMarketingEmailConsent } from "./consent.ts";
import { checkMarketingEligibility } from "./eligibility.ts";
import { listPendingConsentSync, recordConsentSyncResult } from "./external-sync.ts";
import type { MarketingPolicy } from "./policy.ts";
import { sendMarketingEmail } from "./send-marketing-email.ts";
import { unsubscribeByToken } from "./unsubscribe.ts";

const APP_URL = "https://example.test";
const CONTENT = { subject: "Yenilikler", text: "Merhaba.", html: "<p>Merhaba.</p>" };

describe("marketing email — entegrasyon (gerçek Postgres)", () => {
  let db: Database;
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const emails = {
    fresh: `mkt-fresh-${suffix}@example.test`,
    legacy: `mkt-legacy-${suffix}@example.test`,
    opted: `mkt-opted-${suffix}@example.test`,
    unverified: `mkt-unverified-${suffix}@example.test`,
  };
  const ids: Record<keyof typeof emails, number> = { fresh: 0, legacy: 0, opted: 0, unverified: 0 };

  const allowlist: MarketingPolicy = {
    mode: "allowlist",
    from: "ManiCepte <haber@example.test>",
    replyTo: "destek@example.test",
    allowlist: new Set(Object.values(emails)),
    requireExternalSync: false,
  };
  const live: MarketingPolicy = { ...allowlist, mode: "live", requireExternalSync: true };

  function transport() {
    return { sendMail: vi.fn().mockResolvedValue({}) };
  }

  async function lastToken(userId: number, sendMail: ReturnType<typeof vi.fn>): Promise<string> {
    const message = sendMail.mock.calls.at(-1)?.[0] as { headers: Record<string, string> };
    const match = /\?t=([A-Za-z0-9_-]{43})>$/.exec(message.headers["List-Unsubscribe"] ?? "");
    expect(match, `token for user ${userId}`).not.toBeNull();
    return match?.[1] as string;
  }

  async function countRows(sql: string, params: unknown[]): Promise<number> {
    return withOwnerClient(async (client) => Number((await client.query(sql, params)).rows[0].n));
  }

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      for (const key of Object.keys(emails) as (keyof typeof emails)[]) {
        const verified = key === "unverified" ? null : new Date();
        const row = await client.query(
          "INSERT INTO app_user (email, email_verified_at) VALUES ($1, $2) RETURNING id",
          [emails[key], verified],
        );
        ids[key] = Number(row.rows[0].id);
      }
      // 0033 öncesi kod yolunun yazdığı satır: sürümsüz, kaynaksız "izin".
      await client.query(
        "INSERT INTO user_consent (user_id, kind, granted) VALUES ($1, 'marketing_email', true)",
        [ids.legacy],
      );
      // Erken erişim listesindeki kullanıcı pazarlama abonesi sayılmaz.
      await client.query("INSERT INTO early_access (user_id) VALUES ($1)", [ids.fresh]);
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      const all = Object.values(ids);
      await client.query("DELETE FROM marketing_email_send WHERE user_id = ANY($1)", [all]);
      await client.query("DELETE FROM email_suppression WHERE user_id = ANY($1)", [all]);
      await client.query("DELETE FROM app_user WHERE id = ANY($1)", [all]);
    });
  });

  it("user without consent cannot receive marketing email (early access is not consent)", async () => {
    const sendMail = transport().sendMail;
    const result = await sendMarketingEmail(
      db,
      { userId: ids.fresh, campaignKey: `t-${suffix}`, content: CONTENT },
      { policy: allowlist, transport: { sendMail }, appUrl: APP_URL },
    );
    expect(result).toEqual({ status: "skipped", reason: "no_consent" });
    expect(sendMail).not.toHaveBeenCalled();
    expect((await getMarketingEmailPreference(db, ids.fresh)).optedIn).toBe(false);
  });

  it("existing users with legacy (unversioned) consent are not silently opted in", async () => {
    expect((await getConsents(db, ids.legacy)).marketing_email).toBe(false);
    expect(await checkMarketingEligibility(db, ids.legacy, allowlist)).toEqual({
      eligible: false,
      reason: "unverifiable_consent",
    });
  });

  it("unverified address cannot receive marketing even with consent", async () => {
    await recordMarketingEmailConsent(db, {
      userId: ids.unverified,
      granted: true,
      source: "account_settings",
      ip: null,
    });
    expect(await checkMarketingEligibility(db, ids.unverified, allowlist)).toMatchObject({
      reason: "email_unverified",
    });
  });

  it("opt-in records an auditable, versioned event; duplicate submissions are no-ops", async () => {
    const first = await recordMarketingEmailConsent(db, {
      userId: ids.opted,
      granted: true,
      source: "early_access",
      ip: "127.0.0.1",
    });
    const retry = await recordMarketingEmailConsent(db, {
      userId: ids.opted,
      granted: true,
      source: "early_access",
      ip: "127.0.0.1",
    });
    // Eşzamanlı çift tık: kilit altında tek olay.
    const concurrent = await Promise.all([
      recordMarketingEmailConsent(db, {
        userId: ids.opted,
        granted: true,
        source: "account_settings",
        ip: null,
      }),
      recordMarketingEmailConsent(db, {
        userId: ids.opted,
        granted: true,
        source: "account_settings",
        ip: null,
      }),
    ]);
    expect(first.changed).toBe(true);
    expect(retry.changed).toBe(false);
    expect(concurrent.map((r) => r.changed)).toEqual([false, false]);
    expect(first.preference.optedIn).toBe(true);

    const rows = await withOwnerClient(
      async (client) =>
        (
          await client.query(
            `SELECT source, text_version, email, granted FROM user_consent
           WHERE user_id = $1 AND kind = 'marketing_email'`,
            [ids.opted],
          )
        ).rows,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "early_access", email: emails.opted, granted: true });
    expect(rows[0].text_version).toMatch(/^marketing-email\./);

    const pending = await listPendingConsentSync(db, "iys", 1000);
    expect(pending.some((p) => p.email === emails.opted && p.granted)).toBe(true);
  });

  it("opted-in user is eligible and receives one email with unsubscribe headers/footer", async () => {
    const { sendMail } = transport();
    const campaignKey = `launch-${suffix}`;
    const result = await sendMarketingEmail(
      db,
      { userId: ids.opted, campaignKey, content: CONTENT },
      { policy: allowlist, transport: { sendMail }, appUrl: APP_URL },
    );
    expect(result).toEqual({ status: "sent" });
    expect(sendMail).toHaveBeenCalledTimes(1);
    const message = sendMail.mock.calls[0]?.[0];
    expect(message).toMatchObject({
      from: "ManiCepte <haber@example.test>",
      to: emails.opted,
      replyTo: "destek@example.test",
    });
    expect(message.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(message.text).toContain(`${APP_URL}/abonelik-iptali?t=`);
    expect(message.html).toContain("/abonelik-iptali?t=");

    // Yeniden deneme ikinci e-posta üretmez.
    const again = await sendMarketingEmail(
      db,
      { userId: ids.opted, campaignKey, content: CONTENT },
      { policy: allowlist, transport: { sendMail }, appUrl: APP_URL },
    );
    expect(again).toEqual({ status: "skipped", reason: "already_sent" });
    expect(sendMail).toHaveBeenCalledTimes(1);

    const stored = await withOwnerClient(
      async (client) =>
        (
          await client.query("SELECT * FROM marketing_email_send WHERE campaign_key = $1", [
            campaignKey,
          ])
        ).rows,
    );
    expect(stored).toHaveLength(1);
    expect(stored[0].status).toBe("sent");
    // Ham token ve adres saklanmaz.
    const raw = await lastToken(ids.opted, sendMail);
    expect(JSON.stringify(stored[0])).not.toContain(raw);
    expect(JSON.stringify(stored[0])).not.toContain(emails.opted);
  });

  it("provider failure is recorded safely and can be retried", async () => {
    const campaignKey = `flaky-${suffix}`;
    const failing = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error(`${emails.opted} refused`), { code: "ECONNECTION" }),
      );
    const failed = await sendMarketingEmail(
      db,
      { userId: ids.opted, campaignKey, content: CONTENT },
      { policy: allowlist, transport: { sendMail: failing }, appUrl: APP_URL },
    );
    expect(failed).toEqual({ status: "failed", code: "ECONNECTION" });
    const row = await withOwnerClient(
      async (client) =>
        (
          await client.query(
            "SELECT status, error_code FROM marketing_email_send WHERE campaign_key = $1",
            [campaignKey],
          )
        ).rows[0],
    );
    expect(row).toEqual({ status: "failed", error_code: "ECONNECTION" });

    const { sendMail } = transport();
    const retried = await sendMarketingEmail(
      db,
      { userId: ids.opted, campaignKey, content: CONTENT },
      { policy: allowlist, transport: { sendMail }, appUrl: APP_URL },
    );
    expect(retried).toEqual({ status: "sent" });
    expect(
      await countRows("SELECT count(*) AS n FROM marketing_email_send WHERE campaign_key = $1", [
        campaignKey,
      ]),
    ).toBe(1);
  });

  it("live mode refuses consent not synced to IYS, accepts it once synced", async () => {
    expect(await checkMarketingEligibility(db, ids.opted, live)).toMatchObject({
      reason: "external_sync_pending",
    });
    const pending = (await listPendingConsentSync(db, "iys", 1000)).filter(
      (p) => p.email === emails.opted && p.granted,
    );
    for (const item of pending) {
      await recordConsentSyncResult(db, item.consentId, "iys", { ok: true, externalRef: "ref-1" });
    }
    expect(await checkMarketingEligibility(db, ids.opted, live)).toMatchObject({ eligible: true });
  });

  it("unsubscribe via token is immediate, needs no session, and is idempotent", async () => {
    const { sendMail } = transport();
    await sendMarketingEmail(
      db,
      { userId: ids.opted, campaignKey: `unsub-${suffix}`, content: CONTENT },
      { policy: allowlist, transport: { sendMail }, appUrl: APP_URL },
    );
    const token = await lastToken(ids.opted, sendMail);

    const first = await unsubscribeByToken(db, token, { ip: "127.0.0.1" });
    expect(first).toEqual({ status: "unsubscribed", alreadyUnsubscribed: false });
    expect(await checkMarketingEligibility(db, ids.opted, allowlist)).toMatchObject({
      eligible: false,
    });
    expect((await getMarketingEmailPreference(db, ids.opted)).optedIn).toBe(false);

    const blocked = await sendMarketingEmail(
      db,
      { userId: ids.opted, campaignKey: `after-unsub-${suffix}`, content: CONTENT },
      { policy: allowlist, transport: { sendMail }, appUrl: APP_URL },
    );
    expect(blocked.status).toBe("skipped");
    expect(sendMail).toHaveBeenCalledTimes(1);

    const suppressionsBefore = await countRows(
      "SELECT count(*) AS n FROM email_suppression WHERE user_id = $1",
      [ids.opted],
    );
    const again = await unsubscribeByToken(db, token, { ip: null });
    const concurrent = await Promise.all([
      unsubscribeByToken(db, token, { ip: null }),
      unsubscribeByToken(db, token, { ip: null }),
    ]);
    expect(again).toEqual({ status: "unsubscribed", alreadyUnsubscribed: true });
    expect(concurrent).toEqual([again, again]);
    expect(
      await countRows("SELECT count(*) AS n FROM email_suppression WHERE user_id = $1", [
        ids.opted,
      ]),
    ).toBe(suppressionsBefore);

    // Ret olayı da İYS'ye gitmek üzere bekler; yerel bastırma bunu beklemedi.
    const pending = await listPendingConsentSync(db, "iys", 1000);
    expect(pending.some((p) => p.email === emails.opted && !p.granted)).toBe(true);

    expect(await unsubscribeByToken(db, "A".repeat(43), { ip: null })).toEqual({
      status: "invalid",
    });
  });

  it("unsubscribed user is not re-added by a back-dated import; a new consent re-enables", async () => {
    await recordMarketingEmailConsent(db, {
      userId: ids.opted,
      granted: true,
      source: "admin_import",
      ip: null,
      consentedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });
    expect((await getMarketingEmailPreference(db, ids.opted)).optedIn).toBe(false);
    expect(await checkMarketingEligibility(db, ids.opted, allowlist)).toMatchObject({
      eligible: false,
    });

    const renewed = await recordMarketingEmailConsent(db, {
      userId: ids.opted,
      granted: true,
      source: "account_settings",
      ip: null,
    });
    expect(renewed.changed).toBe(true);
    expect(renewed.preference.optedIn).toBe(true);
    expect(await checkMarketingEligibility(db, ids.opted, allowlist)).toMatchObject({
      eligible: true,
    });
  });

  it("opting out in account settings takes effect immediately", async () => {
    const result = await recordMarketingEmailConsent(db, {
      userId: ids.opted,
      granted: false,
      source: "account_settings",
      ip: null,
    });
    expect(result.preference.optedIn).toBe(false);
    expect(await checkMarketingEligibility(db, ids.opted, allowlist)).toMatchObject({
      reason: "opted_out",
    });
  });

  it("consent history is append-only for the application role", async () => {
    const error = await db
      .execute(sql`UPDATE user_consent SET granted = true WHERE user_id = ${ids.opted}`)
      .catch((caught: { code?: string; cause?: { code?: string } }) => caught);
    expect(
      (error as { cause?: { code?: string } }).cause?.code ?? (error as { code?: string }).code,
    ).toBe("42501");
  });

  it("rejects opt-in sources that are not consent-capturing and back-dating outside imports", async () => {
    await expect(
      recordMarketingEmailConsent(db, {
        userId: ids.fresh,
        granted: true,
        source: "unsubscribe_link" as "signup",
        ip: null,
      }),
    ).rejects.toMatchObject({ code: "invalid_source" });
    await expect(
      recordMarketingEmailConsent(db, {
        userId: ids.fresh,
        granted: true,
        source: "signup",
        ip: null,
        consentedAt: new Date(Date.now() - 1000),
      }),
    ).rejects.toMatchObject({ code: "invalid_time" });
  });
});
