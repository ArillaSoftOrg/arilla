/**
 * Pazarlama e-postası kampanyası uçtan uca (docs/decisions/0048). Gerçek
 * YEREL Postgres; e-posta HİÇ gönderilmez — sahte taşıyıcı iletiyi kaydeder.
 * Uzak veritabanı görülürse durur.
 *
 * Kampanya başlatma o an uygun TÜM hesaplar için teslim satırı açar; bu
 * yüzden doğrulamalar yalnızca bu dosyanın hesaplarıyla sınırlıdır ve
 * işlemci her zaman kampanya kimliğiyle sınırlanır.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getConsents, setConsent } from "../account/consent.ts";
import { AdminForbiddenError } from "../admin/capabilities.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import {
  CampaignValidationError,
  cancelCampaign,
  classifyRecipient,
  createCampaignDraft,
  getCampaign,
  getRecipientPreview,
  type MarketingTransport,
  processMarketingCampaigns,
  sendCampaignTest,
  startCampaignSend,
  TEST_RECIPIENT_NOT_ALLOWED,
  TEST_SENDS_PER_HOUR,
  unsubscribeByToken,
  updateCampaignDraft,
} from "./index.ts";

const db = getTestDb();
const TAG = `mk${Date.now().toString(36)}`;
const BRAND = "ManiCepte";
const ENV = {
  SMTP_HOST: "localhost",
  SMTP_PORT: "1025",
  EMAIL_FROM: "ManiCepte <bildirim@test.local>",
  APP_URL: "http://localhost:3000",
  // Karar 0050: test alıcısı yalnızca kendi adres ya da bu izin listesi.
  MARKETING_TEST_RECIPIENTS: "test-alici@test.local, a@test.local,HIZ@test.local",
};
const FAST = { sendIntervalMs: 0 };

function assertLocal(): void {
  for (const name of ["DATABASE_URL", "DATABASE_URL_OWNER"]) {
    const host = new URL(process.env[name] ?? "").hostname;
    if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
      throw new Error(`${name} yerel degil; bu test yalnizca yerel veritabaninda calisir.`);
    }
  }
}

interface Sent {
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
  messageId?: string;
}

/** Hiçbir ağ bağlantısı açmaz. `fail` adrese göre hata döndürebilir. */
function fakeTransport(fail?: (to: string, attempt: number) => Error | undefined) {
  const sent: Sent[] = [];
  const attempts = new Map<string, number>();
  const transport = {
    sendMail: async (message: Sent) => {
      const n = (attempts.get(message.to) ?? 0) + 1;
      attempts.set(message.to, n);
      const error = fail?.(message.to, n);
      if (error) throw error;
      sent.push(message);
      return { messageId: message.messageId };
    },
  } as unknown as MarketingTransport;
  return { transport, sent, attempts };
}

function smtpError(fields: Record<string, unknown>): Error {
  return Object.assign(new Error("smtp"), fields);
}

const ids: Record<string, number> = {};
const emails: Record<string, string> = {};
const allUserIds: number[] = [];

async function createUser(
  key: string,
  opts: { email?: string | null; verified?: boolean; role?: string; consent?: boolean[] },
): Promise<number> {
  const email = opts.email === undefined ? `${TAG}-${key}@test.local` : opts.email;
  const id = await withOwnerClient(async (client) => {
    const res = await client.query(
      `INSERT INTO app_user (email, email_verified_at, role)
       VALUES ($1, CASE WHEN $2 THEN now() END, $3) RETURNING id`,
      [email, opts.verified ?? true, opts.role ?? "user"],
    );
    return Number(res.rows[0].id);
  });
  ids[key] = id;
  if (email) emails[key] = email;
  else {
    // Gerçekte e-postasız hesap telefon/Apple kimliğiyle açılır (0025). Kimliksiz
    // bırakılırsa eşzamanlı `first-login-race` testinin yetim taraması onu görür.
    await withOwnerClient((client) =>
      client.query(
        "INSERT INTO user_identity (user_id, provider, provider_subject) VALUES ($1, 'phone', $2)",
        [id, `+90599${String(id).padStart(7, "0").slice(-7)}`],
      ),
    );
  }
  allUserIds.push(id);
  for (const granted of opts.consent ?? []) {
    await setConsent(db, { userId: id, kind: "marketing_email", granted, ip: null });
  }
  return id;
}

const admin = () => ({ userId: ids.admin as number, role: "admin" as const });
const admin2 = () => ({ userId: ids.admin2 as number, role: "admin" as const });

async function draft(label: string, body = "Merhaba.\n\nhttps://manicepte.test/kesfet") {
  return createCampaignDraft(db, admin(), {
    title: `${TAG} ${label}`,
    subject: `${TAG} ${label} konu`,
    body,
  });
}

async function testedDraft(label: string) {
  const { publicId } = await draft(label);
  const fake = fakeTransport();
  const result = await sendCampaignTest(
    db,
    admin(),
    { publicId, expectedContentVersion: 1, recipient: "test-alici@test.local" },
    { brand: BRAND, transport: fake.transport, env: ENV },
  );
  expect(result.status).toBe("sent");
  return publicId;
}

async function deliveryRows(publicId: string) {
  return withOwnerClient(async (client) => {
    const res = await client.query(
      `SELECT d.user_id::int AS user_id, d.state, d.attempt_count, d.failure_code, d.skip_reason,
              d.unsubscribe_token_hash, d.provider_message_id
         FROM marketing_campaign_delivery d JOIN marketing_campaign c ON c.id = d.campaign_id
        WHERE c.public_id = $1 AND d.user_id = ANY($2)`,
      [publicId, allUserIds],
    );
    return res.rows as {
      user_id: number;
      state: string;
      attempt_count: number;
      failure_code: string | null;
      skip_reason: string | null;
      unsubscribe_token_hash: string | null;
      provider_message_id: string | null;
    }[];
  });
}

async function campaignId(publicId: string): Promise<number> {
  const campaign = await getCampaign(db, admin(), publicId);
  if (!campaign) throw new Error("kampanya yok");
  return campaign.id;
}

async function runBatch(
  publicId: string,
  fake = fakeTransport(),
  env: Record<string, string> = ENV,
) {
  const result = await processMarketingCampaigns(db, {
    brand: BRAND,
    campaignId: await campaignId(publicId),
    transport: fake.transport,
    env,
    config: FAST,
  });
  return { result, fake };
}

function tokenFromHeaders(message: Sent): string {
  const header = message.headers?.["List-Unsubscribe"] ?? "";
  const token = /[?&]t=([^>&]+)/.exec(header)?.[1];
  if (!token) throw new Error("token yok");
  return decodeURIComponent(token);
}

beforeAll(async () => {
  assertLocal();
  await createUser("admin", { role: "admin" });
  await createUser("admin2", { role: "admin" });
  await createUser("moderator", { role: "moderator" });
  await createUser("plain", { role: "user" });
  await createUser("ok", { consent: [true] });
  await createUser("noConsent", {});
  await createUser("revoked", { consent: [true, false] });
  await createUser("noEmail", { email: null, consent: [true] });
  await createUser("badEmail", { email: `${TAG}-bozuk-adres`, consent: [true] });
  await createUser("unverified", { verified: false, consent: [true] });
  await createUser("regranted", { consent: [true, false, true] });
  await createUser("dupLow", { email: `${TAG}-dup@test.local`, consent: [true] });
  await createUser("dupHigh", { email: `${TAG}-DUP@test.local`, consent: [true] });
});

afterAll(async () => {
  await withOwnerClient(async (client) => {
    await client.query(`DELETE FROM admin_audit_event WHERE actor_user_id = ANY($1)`, [allUserIds]);
    await client.query(`DELETE FROM marketing_campaign WHERE title LIKE $1`, [`${TAG}%`]);
    await client.query(`DELETE FROM app_user WHERE id = ANY($1)`, [allUserIds]);
  });
});

describe("eligibility (single rule)", () => {
  it("classifies each account by the first failing condition", async () => {
    const expected: Record<string, string> = {
      ok: "eligible",
      noConsent: "no_consent",
      revoked: "consent_revoked",
      noEmail: "no_email",
      badEmail: "invalid_email",
      unverified: "unverified_email",
      regranted: "eligible",
      dupLow: "eligible",
      dupHigh: "duplicate_email",
    };
    for (const [key, reason] of Object.entries(expected)) {
      const result = await classifyRecipient(db, ids[key] as number);
      expect(result.reason, key).toBe(reason);
    }
    expect(await classifyRecipient(db, 2 ** 40)).toMatchObject({ reason: "no_user" });
  });

  it("duplicate resolution is deterministic: the lower id keeps the address", async () => {
    expect((ids.dupLow as number) < (ids.dupHigh as number)).toBe(true);
    // Düşük kimlik izni geri alırsa adres yüksek kimliğe geçer — yine tek alıcı.
    await setConsent(db, {
      userId: ids.dupLow as number,
      kind: "marketing_email",
      granted: false,
      ip: null,
    });
    expect((await classifyRecipient(db, ids.dupHigh as number)).reason).toBe("eligible");
    await setConsent(db, {
      userId: ids.dupLow as number,
      kind: "marketing_email",
      granted: true,
      ip: null,
    });
    expect((await classifyRecipient(db, ids.dupHigh as number)).reason).toBe("duplicate_email");
  });

  it("preview returns aggregate counts only and requires the capability", async () => {
    const preview = await getRecipientPreview(db, admin());
    expect(preview.eligible).toBeGreaterThanOrEqual(3);
    expect(preview.excluded.duplicate_email).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(preview)).not.toContain("@");
    await expect(
      getRecipientPreview(db, { userId: ids.plain as number, role: "user" }),
    ).rejects.toThrow(AdminForbiddenError);
    await expect(
      getRecipientPreview(db, { userId: ids.moderator as number, role: "moderator" }),
    ).rejects.toThrow(AdminForbiddenError);
  });
});

describe("campaign drafts", () => {
  it("creates, edits (bumping the version only on message change) and validates", async () => {
    const { publicId } = await draft("taslak");
    let campaign = await getCampaign(db, admin(), publicId);
    expect(campaign).toMatchObject({ status: "draft", contentVersion: 1, testedVersion: null });

    const titleOnly = await updateCampaignDraft(db, admin(), {
      publicId,
      expectedContentVersion: 1,
      title: `${TAG} taslak yeni ad`,
      subject: `${TAG} taslak konu`,
      body: "Merhaba.\n\nhttps://manicepte.test/kesfet",
    });
    expect(titleOnly).toEqual({ status: "updated", contentVersion: 1 });

    const edited = await updateCampaignDraft(db, admin(), {
      publicId,
      expectedContentVersion: 1,
      title: `${TAG} taslak yeni ad`,
      subject: `${TAG} taslak konu 2`,
      body: "Yeni içerik",
    });
    expect(edited).toEqual({ status: "updated", contentVersion: 2 });
    campaign = await getCampaign(db, admin(), publicId);
    expect(campaign).toMatchObject({ subject: `${TAG} taslak konu 2`, body: "Yeni içerik" });

    // Eski sürümle düzenleme (başka sekme) reddedilir.
    await expect(
      updateCampaignDraft(db, admin(), {
        publicId,
        expectedContentVersion: 1,
        title: "x",
        subject: "y",
        body: "z",
      }),
    ).rejects.toThrow(CampaignValidationError);
    await expect(
      createCampaignDraft(db, admin(), { title: `${TAG} bos`, subject: "", body: "x" }),
    ).rejects.toThrow(CampaignValidationError);
  });

  it("normal users and moderators cannot create, edit, test, start or cancel", async () => {
    const { publicId } = await draft("yetki");
    for (const actor of [
      { userId: ids.plain as number, role: "user" as const },
      { userId: ids.moderator as number, role: "moderator" as const },
    ]) {
      await expect(
        createCampaignDraft(db, actor, { title: `${TAG} x`, subject: "x", body: "x" }),
      ).rejects.toThrow(AdminForbiddenError);
      await expect(
        updateCampaignDraft(db, actor, {
          publicId,
          expectedContentVersion: 1,
          title: "x",
          subject: "x",
          body: "x",
        }),
      ).rejects.toThrow(AdminForbiddenError);
      await expect(
        sendCampaignTest(
          db,
          actor,
          { publicId, expectedContentVersion: 1, recipient: "a@test.local" },
          { brand: BRAND, transport: fakeTransport().transport, env: ENV },
        ),
      ).rejects.toThrow(AdminForbiddenError);
      await expect(
        startCampaignSend(
          db,
          actor,
          { publicId, expectedContentVersion: 1, confirmed: true },
          { env: ENV },
        ),
      ).rejects.toThrow(AdminForbiddenError);
      await expect(cancelCampaign(db, actor, publicId)).rejects.toThrow(AdminForbiddenError);
      await expect(getCampaign(db, actor, publicId)).rejects.toThrow(AdminForbiddenError);
    }
  });
});

describe("test send", () => {
  it("goes only to the given address, creates no delivery and is audited without the address", async () => {
    const { publicId } = await draft("test");
    const fake = fakeTransport();
    const result = await sendCampaignTest(
      db,
      admin(),
      { publicId, expectedContentVersion: 1, recipient: "  Test-Alici@Test.Local " },
      { brand: BRAND, transport: fake.transport, env: ENV },
    );
    expect(result).toEqual({ status: "sent", contentVersion: 1 });
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.to).toBe("test-alici@test.local");
    expect(fake.sent[0]?.subject).toBe(`Test: ${TAG} test konu`);
    expect(fake.sent[0]?.headers?.["List-Unsubscribe"]).toBeUndefined();

    const campaign = await getCampaign(db, admin(), publicId);
    expect(campaign?.testedVersion).toBe(1);
    expect(campaign?.counts.total).toBe(0);
    expect(campaign?.recipientCount).toBeNull();

    const audit = await withOwnerClient((client) =>
      client.query(
        `SELECT action, after::text AS after FROM admin_audit_event
          WHERE target_type = 'marketing_campaign' AND target_id = $1 ORDER BY id`,
        [String(campaign?.id)],
      ),
    );
    const testRow = audit.rows.find((row) => row.action === "marketing.test_send");
    expect(testRow).toBeDefined();
    expect(testRow.after).not.toContain("test-alici");
    expect(testRow.after).not.toContain("@");
  });

  it("rejects malformed addresses and rate-limits per admin", async () => {
    const { publicId } = await createCampaignDraft(db, admin2(), {
      title: `${TAG} hiz`,
      subject: "hiz",
      body: "hiz",
    });
    await expect(
      sendCampaignTest(
        db,
        admin2(),
        { publicId, expectedContentVersion: 1, recipient: "a@b.com, c@d.com" },
        { brand: BRAND, transport: fakeTransport().transport, env: ENV },
      ),
    ).rejects.toThrow(CampaignValidationError);

    const fake = fakeTransport();
    const results = [];
    for (let i = 0; i <= TEST_SENDS_PER_HOUR; i++) {
      results.push(
        await sendCampaignTest(
          db,
          admin2(),
          { publicId, expectedContentVersion: 1, recipient: "hiz@test.local" },
          { brand: BRAND, transport: fake.transport, env: ENV },
        ),
      );
    }
    expect(results.filter((r) => r.status === "sent")).toHaveLength(TEST_SENDS_PER_HOUR);
    expect(results.at(-1)).toEqual({ status: "rate_limited" });
    expect(fake.sent).toHaveLength(TEST_SENDS_PER_HOUR);
  });

  it("only the admin's own addresses or the allowlist may receive a test (karar 0050)", async () => {
    // Kendi yöneticisi: paylaşılan yöneticinin saatlik test hakkını tüketmesin.
    const policyAdminId = await createUser("policy-admin", { role: "admin" });
    const policyAdmin = { userId: policyAdminId, role: "admin" as const };
    const { publicId } = await createCampaignDraft(db, policyAdmin, {
      title: `${TAG} alici-politikasi`,
      subject: "politika",
      body: "politika",
    });
    const auditCount = async () =>
      withOwnerClient(async (client) => {
        const res = await client.query(
          `SELECT count(*)::int AS n FROM admin_audit_event
            WHERE action = 'marketing.test_send' AND actor_user_id = $1`,
          [policyAdminId],
        );
        return res.rows[0].n as number;
      });
    const send = (recipient: string, env: Record<string, string> = ENV) => {
      const fake = fakeTransport();
      return {
        fake,
        run: sendCampaignTest(
          db,
          policyAdmin,
          { publicId, expectedContentVersion: 1, recipient },
          { brand: BRAND, transport: fake.transport, env },
        ),
      };
    };

    // Rastgele adres: reddedilir, iletilmez, denetime/hız sınırına yazılmaz.
    const before = await auditCount();
    const stranger = send("yabanci@ornek.com");
    await expect(stranger.run).rejects.toThrow(TEST_RECIPIENT_NOT_ALLOWED);
    expect(stranger.fake.sent).toHaveLength(0);
    expect(await auditCount()).toBe(before);

    // Kendi hesap e-postası: izin listesi boş olsa da gider.
    const { APP_URL, SMTP_HOST, SMTP_PORT, EMAIL_FROM } = ENV;
    const noAllowlist = { APP_URL, SMTP_HOST, SMTP_PORT, EMAIL_FROM };
    const self = send((emails["policy-admin"] as string).toUpperCase(), noAllowlist);
    expect(await self.run).toMatchObject({ status: "sent" });
    expect(self.fake.sent[0]?.to).toBe((emails["policy-admin"] as string).toLowerCase());

    // Doğrulanmış giriş kimliği e-postası gider; doğrulanmamış gitmez.
    await withOwnerClient((client) =>
      client.query(
        `INSERT INTO user_identity (user_id, provider, provider_subject, email, email_verified)
         VALUES ($1, 'apple', $2, $3, true), ($1, 'google', $4, $5, false)`,
        [
          policyAdminId,
          `${TAG}-apple`,
          `${TAG}-apple-relay@test.local`,
          `${TAG}-google`,
          `${TAG}-unverified@test.local`,
        ],
      ),
    );
    expect(await send(`${TAG}-apple-relay@test.local`, noAllowlist).run).toMatchObject({
      status: "sent",
    });
    await expect(send(`${TAG}-unverified@test.local`, noAllowlist).run).rejects.toThrow(
      TEST_RECIPIENT_NOT_ALLOWED,
    );

    // İzin listesi harf duyarsız.
    expect(await send("hiz@TEST.local").run).toMatchObject({ status: "sent" });

    const kinds = await withOwnerClient(async (client) => {
      const res = await client.query(
        `SELECT after->>'recipientKind' AS kind, after::text AS raw FROM admin_audit_event
          WHERE action = 'marketing.test_send' AND actor_user_id = $1 ORDER BY id DESC LIMIT 3`,
        [policyAdminId],
      );
      return res.rows as { kind: string; raw: string }[];
    });
    expect(kinds.map((row) => row.kind)).toEqual(["allowlist", "self", "self"]);
    for (const row of kinds) expect(row.raw).not.toContain("@");
  });

  it("a failed test send does not mark the version as tested", async () => {
    const { publicId } = await draft("test-hata");
    const fake = fakeTransport(() => smtpError({ code: "ECONNECTION" }));
    const result = await sendCampaignTest(
      db,
      admin(),
      { publicId, expectedContentVersion: 1, recipient: "a@test.local" },
      { brand: BRAND, transport: fake.transport, env: ENV },
    );
    expect(result).toEqual({ status: "failed", code: "ECONNECTION" });
    expect((await getCampaign(db, admin(), publicId))?.testedVersion).toBeNull();
  });
});

describe("starting a real send", () => {
  it("requires confirmation, a tested current version and an open environment", async () => {
    const { publicId } = await draft("on-kosul");
    await expect(
      startCampaignSend(
        db,
        admin(),
        { publicId, expectedContentVersion: 1, confirmed: true },
        { env: ENV },
      ),
    ).rejects.toThrow("test");
    const tested = await testedDraft("on-kosul-2");
    await expect(
      startCampaignSend(
        db,
        admin(),
        { publicId: tested, expectedContentVersion: 1, confirmed: false },
        { env: ENV },
      ),
    ).rejects.toThrow(CampaignValidationError);
    await expect(
      startCampaignSend(
        db,
        admin(),
        { publicId: tested, expectedContentVersion: 2, confirmed: true },
        { env: ENV },
      ),
    ).rejects.toThrow("değişti");
    const remote = {
      ...ENV,
      SMTP_HOST: "smtp.resend.com",
      SMTP_PORT: "465",
      SMTP_USER: "resend",
      SMTP_PASS: "test-degeri",
    };
    await expect(
      startCampaignSend(
        db,
        admin(),
        { publicId: tested, expectedContentVersion: 1, confirmed: true },
        { env: remote },
      ),
    ).rejects.toThrow("kapalı");
    expect((await getCampaign(db, admin(), tested))?.status).toBe("draft");
  });

  it("concurrent start requests create exactly one set of deliveries", async () => {
    const publicId = await testedDraft("eszamanli");
    const input = { publicId, expectedContentVersion: 1, confirmed: true };
    const results = await Promise.all([
      startCampaignSend(db, admin(), input, { env: ENV }),
      startCampaignSend(db, admin2(), input, { env: ENV }),
      startCampaignSend(db, admin(), input, { env: ENV }),
    ]);
    expect(results.filter((r) => r.status === "started")).toHaveLength(1);
    expect(results.filter((r) => r.status === "already_started")).toHaveLength(2);

    const rows = await deliveryRows(publicId);
    const mine = new Map(rows.map((row) => [row.user_id, row]));
    for (const key of ["ok", "regranted", "dupLow"]) {
      expect(mine.has(ids[key] as number), key).toBe(true);
    }
    for (const key of [
      "noConsent",
      "revoked",
      "noEmail",
      "badEmail",
      "unverified",
      "dupHigh",
      "admin",
    ]) {
      expect(mine.has(ids[key] as number), key).toBe(false);
    }
    expect(new Set(rows.map((row) => row.user_id)).size).toBe(rows.length);

    // Motor kısıtı: aynı alıcıya ikinci satır açılamaz.
    const id = await campaignId(publicId);
    await expect(
      withOwnerClient((client) =>
        client.query(
          "INSERT INTO marketing_campaign_delivery (campaign_id, user_id) VALUES ($1, $2)",
          [id, ids.ok],
        ),
      ),
    ).rejects.toThrow(/marketing_campaign_delivery_once/);

    const audits = await withOwnerClient((client) =>
      client.query(
        `SELECT count(*)::int AS n FROM admin_audit_event
          WHERE action = 'marketing.send_start' AND target_id = $1`,
        [String(id)],
      ),
    );
    expect(audits.rows[0].n).toBe(1);

    // Başladıktan sonra içerik ve test kilitli.
    await expect(
      updateCampaignDraft(db, admin(), {
        publicId,
        expectedContentVersion: 1,
        title: "x",
        subject: "x",
        body: "x",
      }),
    ).rejects.toThrow(CampaignValidationError);
    await expect(
      sendCampaignTest(
        db,
        admin(),
        { publicId, expectedContentVersion: 1, recipient: "a@test.local" },
        { brand: BRAND, transport: fakeTransport().transport, env: ENV },
      ),
    ).rejects.toThrow(CampaignValidationError);
  });
});

describe("delivery processing", () => {
  it("rechecks consent at send time, isolates failures, retries only safely and never resends", async () => {
    const lateRevoke = await createUser("lateRevoke", { consent: [true] });
    const bounce = await createUser("bounce", { consent: [true] });
    const flaky = await createUser("flaky", { consent: [true] });
    const publicId = await testedDraft("isleme");
    const started = await startCampaignSend(
      db,
      admin(),
      { publicId, expectedContentVersion: 1, confirmed: true },
      { env: ENV },
    );
    expect(started.status).toBe("started");

    // Önizleme ve başlangıçtan SONRA izin geri alınır: ileti gitmemeli.
    await setConsent(db, { userId: lateRevoke, kind: "marketing_email", granted: false, ip: null });

    const fail = (to: string, attempt: number) => {
      if (to === emails.bounce)
        return smtpError({ code: "EENVELOPE", responseCode: 550, command: "RCPT TO" });
      if (to === emails.flaky && attempt === 1) return smtpError({ code: "ECONNECTION" });
      return undefined;
    };
    // Aynı sahte taşıyıcı: deneme sayısı çağrılar arasında korunur.
    const shared = fakeTransport(fail);
    const first = await runBatch(publicId, shared);
    const firstCount = shared.sent.length;
    const sentTo = first.fake.sent.map((m) => m.to);
    expect(sentTo).toContain(emails.ok);
    expect(sentTo).not.toContain(emails.lateRevoke);
    expect(sentTo).not.toContain(emails.bounce);
    expect(sentTo).not.toContain(emails.dupHigh);

    let rows = new Map((await deliveryRows(publicId)).map((row) => [row.user_id, row]));
    expect(rows.get(lateRevoke)).toMatchObject({ state: "skipped", skip_reason: "not_eligible" });
    expect(rows.get(bounce)).toMatchObject({ state: "failed", failure_code: "invalid_recipient" });
    expect(rows.get(flaky)).toMatchObject({
      state: "pending",
      attempt_count: 1,
      unsubscribe_token_hash: null,
    });
    expect(rows.get(ids.ok as number)).toMatchObject({ state: "sent", attempt_count: 1 });
    expect(rows.get(ids.ok as number)?.provider_message_id).toMatch(/^<mc-.+@test\.local>$/);
    // Bekleyen geçici hata varken kampanya bitmiş sayılmaz.
    expect((await getCampaign(db, admin(), publicId))?.status).toBe("sending");

    // Geri çekilme süresi dolmadan ikinci çağrı aynı teslimi denemez.
    const early = await runBatch(publicId, fakeTransport());
    expect(early.fake.sent.map((m) => m.to)).not.toContain(emails.flaky);

    await withOwnerClient((client) =>
      client.query(
        "UPDATE marketing_campaign_delivery SET next_attempt_at = now() - interval '1 minute' WHERE user_id = $1",
        [flaky],
      ),
    );
    await runBatch(publicId, shared);
    const secondTo = shared.sent.slice(firstCount).map((m) => m.to);
    expect(secondTo).toContain(emails.flaky);
    expect(secondTo).not.toContain(emails.ok);

    rows = new Map((await deliveryRows(publicId)).map((row) => [row.user_id, row]));
    expect(rows.get(flaky)).toMatchObject({ state: "sent", attempt_count: 2 });

    const campaign = await getCampaign(db, admin(), publicId);
    expect(campaign?.status).toBe("partially_failed");
    expect(campaign?.completedAt).not.toBeNull();
    expect(campaign?.problems.some((p) => p.recipientLabel?.includes("***"))).toBe(true);
    expect(JSON.stringify(campaign?.problems)).not.toContain(emails.bounce);

    // Bitmiş kampanya yeniden işlenince hiçbir ileti gitmez.
    const again = await runBatch(publicId, fakeTransport());
    expect(again.fake.sent).toHaveLength(0);
    expect(
      await startCampaignSend(
        db,
        admin(),
        { publicId, expectedContentVersion: 1, confirmed: true },
        { env: ENV },
      ),
    ).toMatchObject({ status: "already_started" });
  });

  it("closes a stuck in-flight delivery as unknown outcome instead of resending", async () => {
    const stuck = await createUser("stuck", { consent: [true] });
    const publicId = await testedDraft("askida");
    await startCampaignSend(
      db,
      admin(),
      { publicId, expectedContentVersion: 1, confirmed: true },
      { env: ENV },
    );
    await withOwnerClient((client) =>
      client.query(
        `UPDATE marketing_campaign_delivery
            SET state = 'sending', attempt_count = 1, claimed_at = now() - interval '1 hour'
          WHERE user_id = $1`,
        [stuck],
      ),
    );
    const { fake, result } = await runBatch(publicId);
    expect(result.recoveredStale).toBeGreaterThanOrEqual(1);
    expect(fake.sent.map((m) => m.to)).not.toContain(emails.stuck);
    const row = (await deliveryRows(publicId)).find((r) => r.user_id === stuck);
    expect(row).toMatchObject({ state: "failed", failure_code: "unknown_outcome" });
  });

  it("configuration problems consume no delivery and are surfaced on the campaign", async () => {
    const publicId = await testedDraft("yapilandirma");
    await startCampaignSend(
      db,
      admin(),
      { publicId, expectedContentVersion: 1, confirmed: true },
      { env: ENV },
    );

    const blocked = await runBatch(publicId, fakeTransport(), {
      ...ENV,
      SMTP_HOST: "smtp.resend.com",
      SMTP_PORT: "465",
      SMTP_USER: "resend",
      SMTP_PASS: "test-degeri",
    });
    expect(blocked.result.stoppedBy).toBe("bulk_send_disabled");
    expect(blocked.fake.sent).toHaveLength(0);

    const authFail = await runBatch(
      publicId,
      fakeTransport(() => smtpError({ code: "EAUTH", responseCode: 535 })),
    );
    expect(authFail.result.stoppedBy).toBe("configuration_error");
    const campaign = await getCampaign(db, admin(), publicId);
    expect(campaign?.lastErrorCode).toBe("configuration_error");
    for (const row of await deliveryRows(publicId)) {
      expect(row.state).toBe("pending");
      expect(row.attempt_count).toBe(0);
    }

    const ok = await runBatch(publicId);
    expect(ok.fake.sent.map((m) => m.to)).toContain(emails.ok);
    expect((await getCampaign(db, admin(), publicId))?.lastErrorCode).toBeNull();
  });

  it("cancel skips pending deliveries and nothing is sent afterwards", async () => {
    const publicId = await testedDraft("iptal");
    await startCampaignSend(
      db,
      admin(),
      { publicId, expectedContentVersion: 1, confirmed: true },
      { env: ENV },
    );
    expect(await cancelCampaign(db, admin(), publicId)).toMatchObject({ status: "cancelled" });
    const { fake } = await runBatch(publicId);
    expect(fake.sent).toHaveLength(0);
    for (const row of await deliveryRows(publicId)) {
      expect(row).toMatchObject({ state: "skipped", skip_reason: "cancelled" });
    }
    expect(await cancelCampaign(db, admin(), publicId)).toMatchObject({
      status: "not_cancellable",
    });
  });
});

describe("unsubscribe", () => {
  it("revokes the real marketing consent once, ignores tampering, and excludes the user afterwards", async () => {
    const reader = await createUser("reader", { consent: [true] });
    const publicId = await testedDraft("abonelik");
    await startCampaignSend(
      db,
      admin(),
      { publicId, expectedContentVersion: 1, confirmed: true },
      { env: ENV },
    );
    const { fake } = await runBatch(publicId);
    const message = fake.sent.find((m) => m.to === emails.reader);
    expect(message).toBeDefined();
    if (!message) return;
    expect(message.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const token = tokenFromHeaders(message);
    expect(message.html).toContain(`/abonelik-iptali?t=${token}`);
    // Bağlantıda hesap kimliği yok.
    expect(message.html).not.toContain(String(reader));

    const consentRows = async () =>
      withOwnerClient(async (client) => {
        const res = await client.query(
          "SELECT count(*)::int AS n FROM user_consent WHERE user_id = $1 AND kind = 'marketing_email'",
          [reader],
        );
        return res.rows[0].n as number;
      });
    const before = await consentRows();

    const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    for (const bad of [tampered, "kisa", null, `${token}x`]) {
      expect(await unsubscribeByToken(db, bad, { ip: null })).toEqual({ status: "invalid" });
    }
    expect(await consentRows()).toBe(before);
    expect((await getConsents(db, reader)).marketing_email).toBe(true);

    expect(await unsubscribeByToken(db, token, { ip: "127.0.0.1" })).toEqual({
      status: "unsubscribed",
      changed: true,
    });
    expect((await getConsents(db, reader)).marketing_email).toBe(false);
    const after = await consentRows();
    expect(after).toBe(before + 1);

    // Tekrar (tarayıcı + tek tık POST + çift tık) yeni satır yazmaz.
    const repeats = await Promise.all([
      unsubscribeByToken(db, token, { ip: null }),
      unsubscribeByToken(db, token, { ip: null }),
    ]);
    for (const result of repeats)
      expect(result).toEqual({ status: "unsubscribed", changed: false });
    expect(await consentRows()).toBe(after);

    // Sonraki kampanya bu kişiyi almaz.
    expect((await classifyRecipient(db, reader)).reason).toBe("consent_revoked");
    const next = await testedDraft("abonelik-sonrasi");
    await startCampaignSend(
      db,
      admin(),
      { publicId: next, expectedContentVersion: 1, confirmed: true },
      { env: ENV },
    );
    expect((await deliveryRows(next)).some((row) => row.user_id === reader)).toBe(false);
    const sent = await runBatch(next);
    expect(sent.fake.sent.map((m) => m.to)).not.toContain(emails.reader);
  });
});

describe("audit privacy", () => {
  it("never stores subject, body, recipient addresses or tokens", async () => {
    const result = await db.execute<{
      before: string | null;
      after: string | null;
      reason: string | null;
    }>(sql`
      SELECT before::text AS before, after::text AS after, reason FROM admin_audit_event
       WHERE target_type = 'marketing_campaign' AND actor_user_id IN ${allUserIds}
    `);
    expect(result.rows.length).toBeGreaterThan(5);
    const dump = JSON.stringify(result.rows);
    expect(dump).not.toContain(TAG);
    expect(dump).not.toContain("@");
    expect(dump).not.toContain("manicepte.test");
  });
});
