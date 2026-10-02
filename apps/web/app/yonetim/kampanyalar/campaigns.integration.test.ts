/**
 * `/yonetim/kampanyalar`, abonelik iptali ve kampanya cron ucu - web sınırı
 * (docs/decisions/0048). Gerçek YEREL Postgres ve YEREL Mailpit
 * (SMTP localhost:1025, API localhost:8025): ileti makineden çıkmaz. Uzak
 * veritabanı ya da uzak SMTP görülürse test durur. `next/*` taklit edilir;
 * yetki kodu gerçektir.
 *
 * - anonim/normal kullanıcı/moderatör sayfa ve action'lara erişemez
 * - yönetici taslak oluşturur, test gönderir (Mailpit'te görünür), taze
 *   girişle gönderimi başlatır; ikinci tık yeni gönderim yapmaz
 * - sayfada alıcı adresi yok; denetim kaydında adres/gövde yok
 * - iptal sayfası GET'te hiçbir şey değiştirmez, POST rızayı geri alır
 * - RFC 8058 tek tık ucu ve cron ucu
 */
import { generateRawToken, hashToken } from "@arilla/core";
import { createDatabase } from "@arilla/db";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ token: undefined as string | undefined }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "session" && state.token ? { name, value: state.token } : undefined,
  }),
  headers: async () => new Headers(),
}));

class RedirectSignal extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`);
  }
}
class NotFoundSignal extends Error {
  constructor() {
    super("notFound");
  }
}

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
  notFound: () => {
    throw new NotFoundSignal();
  },
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]"];

function assertLocal(name: string): string {
  const url = process.env[name];
  if (!url) throw new Error(`${name} tanımlı değil`);
  const host = new URL(url).hostname;
  if (!LOCAL_HOSTS.includes(host)) {
    throw new Error(`${name} yerel değil (${host}); bu test yalnızca yerel veritabanında çalışır.`);
  }
  return url;
}

function assertLocalSmtp(): void {
  const host = process.env.SMTP_HOST ?? "";
  if (!LOCAL_HOSTS.includes(host) && host !== "mailpit") {
    throw new Error("SMTP_HOST yerel Mailpit değil; bu test gerçek e-posta göndermez.");
  }
}

type OwnerClient = ReturnType<typeof createDatabase>["$client"];
let ownerPool: OwnerClient | undefined;
async function owner<T>(fn: (client: OwnerClient) => Promise<T>): Promise<T> {
  ownerPool ??= createDatabase(assertLocal("DATABASE_URL_OWNER")).$client;
  return fn(ownerPool);
}

async function outcome(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "ok";
  } catch (error) {
    if (error instanceof RedirectSignal && error.to.startsWith("/yonetim/giris")) return "login";
    if (error instanceof NotFoundSignal) return "404";
    throw error;
  }
}

const TAG = `kmp${Date.now().toString(36)}`;
const tokens: Record<"admin" | "staleAdmin" | "moderator" | "user", string> = {
  admin: "",
  staleAdmin: "",
  moderator: "",
  user: "",
};
const ids: Record<string, number> = {};
const allUserIds: number[] = [];
const recipientEmail = `${TAG}-alici@test.local`;

async function createUser(key: string, email: string, role: string): Promise<number> {
  return owner(async (client) => {
    const res = await client.query(
      "INSERT INTO app_user (email, email_verified_at, role) VALUES ($1, now(), $2) RETURNING id",
      [email, role],
    );
    const id = Number(res.rows[0].id);
    ids[key] = id;
    allUserIds.push(id);
    return id;
  });
}

async function session(userId: number, createdAgo = "0 minutes"): Promise<string> {
  const raw = generateRawToken();
  await owner((client) =>
    client.query(
      `INSERT INTO session (user_id, token_hash, expires_at, created_at, last_used_at)
       VALUES ($1, $2, now() + interval '1 hour', now() - $3::interval, now())`,
      [userId, hashToken(raw), createdAgo],
    ),
  );
  return raw;
}

async function mailpitMessages(
  query: string,
): Promise<{ To: { Address: string }[]; Subject: string }[]> {
  const url = `http://localhost:8025/api/v1/search?query=${encodeURIComponent(query)}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Mailpit API ${response.status}`);
  const body = (await response.json()) as {
    messages: { To: { Address: string }[]; Subject: string }[];
  };
  return body.messages;
}

let campaignPublicId = "";

beforeAll(async () => {
  assertLocal("DATABASE_URL");
  assertLocalSmtp();
  tokens.admin = await session(await createUser("admin", `${TAG}-admin@test.local`, "admin"));
  tokens.staleAdmin = await session(ids.admin as number, "2 hours");
  tokens.moderator = await session(
    await createUser("moderator", `${TAG}-mod@test.local`, "moderator"),
  );
  tokens.user = await session(await createUser("user", `${TAG}-user@test.local`, "user"));
  const recipient = await createUser("recipient", recipientEmail, "user");
  await owner((client) =>
    client.query(
      "INSERT INTO user_consent (user_id, kind, granted) VALUES ($1, 'marketing_email', true)",
      [recipient],
    ),
  );
});

beforeEach(() => {
  state.token = tokens.admin;
});

afterAll(async () => {
  await owner(async (client) => {
    await client.query("DELETE FROM admin_audit_event WHERE actor_user_id = ANY($1)", [allUserIds]);
    await client.query("DELETE FROM marketing_campaign WHERE title LIKE $1", [`${TAG}%`]);
    await client.query("DELETE FROM app_user WHERE id = ANY($1)", [allUserIds]);
  });
  await ownerPool?.end();
});

describe("yetki", () => {
  it("anonim girişe, normal kullanıcı ve moderatör 404'e gider; action'lar da", async () => {
    const page = (await import("./page.tsx")).default;
    const actions = await import("./actions.ts");
    const calls: Record<string, () => Promise<unknown>> = {
      list: () => page({ searchParams: Promise.resolve({}) }),
      create: () => actions.createCampaignAction({ title: `${TAG} x`, subject: "x", body: "x" }),
      test: () =>
        actions.sendTestAction({
          publicId: "00000000-0000-4000-8000-000000000000",
          expectedContentVersion: 1,
          recipient: "a@test.local",
        }),
      start: () =>
        actions.startSendAction({
          publicId: "00000000-0000-4000-8000-000000000000",
          expectedContentVersion: 1,
          confirmed: true,
        }),
      process: () => actions.processNextBatchAction("00000000-0000-4000-8000-000000000000"),
      cancel: () => actions.cancelCampaignAction("00000000-0000-4000-8000-000000000000"),
    };
    for (const [role, token, want] of [
      ["anonymous", undefined, "login"],
      ["user", tokens.user, "404"],
      ["moderator", tokens.moderator, "404"],
    ] as const) {
      state.token = token;
      for (const [name, call] of Object.entries(calls)) {
        expect(await outcome(call), `${role} ${name}`).toBe(want);
      }
    }
    const created = await owner((client) =>
      client.query("SELECT count(*)::int AS n FROM marketing_campaign WHERE title LIKE $1", [
        `${TAG}%`,
      ]),
    );
    expect(created.rows[0].n).toBe(0);
  });
});

describe("yönetici akışı", () => {
  it("taslak → test (Mailpit) → taze girişle gönderim; ikinci tık yeni gönderim yapmaz", async () => {
    const actions = await import("./actions.ts");
    const created = await actions.createCampaignAction({
      title: `${TAG} duyuru`,
      subject: `${TAG} yeni özellik`,
      body: "Merhaba.\n\nAyrıntılar: https://manicepte.test/kesfet",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    campaignPublicId = created.publicId;

    const detail = (await import("./[publicId]/page.tsx")).default;
    let html = renderToStaticMarkup(
      await detail({ params: Promise.resolve({ publicId: created.publicId }) }),
    );
    expect(html).toContain("Uygun");
    expect(html).toContain("srcDoc");
    expect(html).toContain("henüz test edilmedi");
    // Alıcı listesi gösterilmez; yalnızca sayılar.
    expect(html).not.toContain(recipientEmail);

    // Test gönderilmeden gerçek gönderim reddedilir.
    const early = await actions.startSendAction({
      publicId: created.publicId,
      expectedContentVersion: 1,
      confirmed: true,
    });
    expect(early).toMatchObject({ ok: false });

    const testResult = await actions.sendTestAction({
      publicId: created.publicId,
      expectedContentVersion: 1,
      recipient: `${TAG}-test@test.local`,
    });
    expect(testResult).toEqual({ ok: true });
    const testMails = await mailpitMessages(`subject:"Test: ${TAG} yeni özellik"`);
    expect(testMails.map((m) => m.To[0]?.Address)).toEqual([`${TAG}-test@test.local`]);

    // Eski giriş: gönderim yapılmaz, yeniden giriş bağlantısı döner.
    state.token = tokens.staleAdmin;
    const stale = await actions.startSendAction({
      publicId: created.publicId,
      expectedContentVersion: 1,
      confirmed: true,
    });
    expect(stale).toMatchObject({ ok: false });
    expect(stale.ok ? null : stale.reauthHref).toContain("/yonetim/giris");

    state.token = tokens.admin;
    const [first, second] = await Promise.all([
      actions.startSendAction({
        publicId: created.publicId,
        expectedContentVersion: 1,
        confirmed: true,
      }),
      actions.startSendAction({
        publicId: created.publicId,
        expectedContentVersion: 1,
        confirmed: true,
      }),
    ]);
    const results = [first, second];
    expect(results.filter((r) => r.ok && !r.alreadyStarted)).toHaveLength(1);
    expect(results.filter((r) => r.ok && r.alreadyStarted)).toHaveLength(1);

    const deliveries = await owner((client) =>
      client.query(
        `SELECT d.state FROM marketing_campaign_delivery d
           JOIN marketing_campaign c ON c.id = d.campaign_id
          WHERE c.public_id = $1 AND d.user_id = $2`,
        [created.publicId, ids.recipient],
      ),
    );
    expect(deliveries.rows).toEqual([{ state: "sent" }]);
    const realMails = await mailpitMessages(`subject:"${TAG} yeni özellik" to:${recipientEmail}`);
    expect(realMails).toHaveLength(1);

    html = renderToStaticMarkup(
      await detail({ params: Promise.resolve({ publicId: created.publicId }) }),
    );
    expect(html).toContain("Sağlayıcıya verildi");
    expect(html).not.toContain("Taslağı kaydet");
    expect(html).not.toContain(recipientEmail);

    const audit = await owner((client) =>
      client.query(
        "SELECT action, after::text AS after FROM admin_audit_event WHERE actor_user_id = $1 ORDER BY id",
        [ids.admin],
      ),
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      "marketing.campaign_create",
      "marketing.test_send",
      "marketing.send_start",
    ]);
    expect(JSON.stringify(audit.rows)).not.toContain("@");
    expect(JSON.stringify(audit.rows)).not.toContain(TAG);
  });
});

describe("abonelik iptali", () => {
  async function tokenFor(userId: number): Promise<string> {
    // Gönderimde üretilen ham token yalnızca e-postada; Mailpit'ten okunur.
    const list = await mailpitMessages(`to:${recipientEmail}`);
    const id = (list[0] as unknown as { ID: string } | undefined)?.ID;
    if (!id) throw new Error(`ileti yok (${userId})`);
    const headers = (await (
      await fetch(`http://localhost:8025/api/v1/message/${id}/headers`)
    ).json()) as Record<string, string[]>;
    const header = headers["List-Unsubscribe"]?.[0] ?? "";
    const token = /[?&]t=([^>&]+)/.exec(header)?.[1];
    if (!token) throw new Error("List-Unsubscribe yok");
    return decodeURIComponent(token);
  }

  const consent = () =>
    owner(async (client) => {
      const res = await client.query(
        `SELECT granted, count(*) OVER ()::int AS n FROM user_consent
          WHERE user_id = $1 AND kind = 'marketing_email' ORDER BY granted_at DESC, id DESC LIMIT 1`,
        [ids.recipient],
      );
      return res.rows[0] as { granted: boolean; n: number };
    });

  it("GET değiştirmez; onay POST'u rızayı bir kez geri alır; geçersiz token hiçbir şey yazmaz", async () => {
    state.token = undefined;
    const token = await tokenFor(ids.recipient as number);
    const page = (await import("../../abonelik-iptali/page.tsx")).default;
    const html = renderToStaticMarkup(await page({ searchParams: Promise.resolve({ t: token }) }));
    expect(html).toContain("Abonelikten çık");
    expect(await consent()).toMatchObject({ granted: true, n: 1 });

    const { unsubscribeAction } = await import("../../abonelik-iptali/actions.ts");
    const bad = new FormData();
    bad.set("t", `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`);
    await expect(unsubscribeAction(bad)).rejects.toMatchObject({
      to: "/abonelik-iptali?durum=gecersiz",
    });
    expect(await consent()).toMatchObject({ granted: true, n: 1 });

    const form = new FormData();
    form.set("t", token);
    await expect(unsubscribeAction(form)).rejects.toMatchObject({
      to: "/abonelik-iptali?durum=tamam",
    });
    expect(await consent()).toMatchObject({ granted: false, n: 2 });

    // RFC 8058 tek tık: tekrar güvenli, yeni satır yok.
    const { POST, GET } = await import("../../api/email/unsubscribe/route.ts");
    const oneClick = await POST(
      new Request(`http://localhost/api/email/unsubscribe?t=${encodeURIComponent(token)}`, {
        method: "POST",
        body: "List-Unsubscribe=One-Click",
      }),
    );
    expect(oneClick.status).toBe(200);
    expect(await consent()).toMatchObject({ granted: false, n: 2 });
    const invalid = await POST(
      new Request("http://localhost/api/email/unsubscribe?t=bozuk", { method: "POST" }),
    );
    expect(invalid.status).toBe(400);
    const get = GET(new Request(`http://localhost/api/email/unsubscribe?t=${token}`));
    expect(get.status).toBe(303);
    expect(get.headers.get("location")).toBe(`http://localhost/abonelik-iptali?t=${token}`);
  });
});

describe("cron ucu", () => {
  it("CRON_SECRET olmadan çalışmaz", async () => {
    const { GET } = await import("../../api/cron/marketing-campaigns/route.ts");
    expect(
      (await GET(new Request("http://localhost/api/cron/marketing-campaigns"))).status,
    ).toBeGreaterThanOrEqual(401);
    const wrong = await GET(
      new Request("http://localhost/api/cron/marketing-campaigns", {
        headers: { authorization: "Bearer yanlis-deger-yanlis-deger-yanlis" },
      }),
    );
    expect([401, 500]).toContain(wrong.status);
    expect(campaignPublicId).not.toBe("");
  });
});
