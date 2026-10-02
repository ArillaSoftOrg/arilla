/**
 * Yönetim kullanıcı listesi, ayrıntı sekmeleri ve tıkla-göster (karar 0049)
 * — gerçek yerel Postgres. Test hesaplarının `created_at`'i ve özet
 * `last_active_at`'i bu koşuya özgü geçmiş bir güne çekilir; liste
 * filtreleri böylece yalnızca bu hesapları görür.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { type AdminActor, AdminForbiddenError } from "./capabilities.ts";
import {
  FreshAuthRequiredError,
  getUserActivity,
  getUserAffiliate,
  getUserAudit,
  getUserConsents,
  getUserProfile,
  getUserSearches,
  getUserSessions,
  revealUserContact,
} from "./users-detail.ts";
import { listUsers, type UserListFilters, type UserListSort } from "./users-list.ts";

const suffix = Date.now().toString(36);
const TAG = `uli${suffix}`;
// Bu koşuya özgü gün (2002–2091): başka satırla çakışmaz.
const YEAR = 2002 + (Date.now() % 90);
const DAY = `${YEAR}-05-10`;
const RANGE: UserListFilters = { createdFrom: DAY, createdTo: DAY };
const ACTIVE_RANGE: UserListFilters = { lastActiveFrom: DAY, lastActiveTo: DAY };

const ips = { consent: "203.0.113.77", session: "198.51.100.23" };
const userAgent = `GizliAjan/9.9 ${TAG}`;
const phone = `+90555${String(Date.now()).slice(-7)}`;

let db: Database;
let admin: AdminActor;
const moderator: AdminActor = { userId: 1, role: "moderator" };
const normalUser: AdminActor = { userId: 1, role: "user" };
const ids: Record<string, number> = {};
const publicIds: Record<string, string> = {};
const emails: Record<string, string> = {};
let offerId: number | null = null;

beforeAll(async () => {
  db = getTestDb();
  await withOwnerClient(async (client) => {
    const insertUser = async (key: string, role = "user", at = `${DAY} 10:00:00.000100+00`) => {
      emails[key] = `${key}.${TAG}@test.local`;
      const res = await client.query(
        `INSERT INTO app_user (email, role, created_at, display_name)
         VALUES ($1, $2, $3, $4) RETURNING id, public_id`,
        [emails[key], role, at, `Test ${key}`],
      );
      ids[key] = Number(res.rows[0].id);
      publicIds[key] = res.rows[0].public_id;
    };
    await insertUser("admin", "admin", "2026-01-01 00:00:00+00");
    admin = { userId: ids.admin as number, role: "admin" };

    // Liste: 4 hesap aynı an (eşitlik bozucu id), 2 hesap aynı milisaniyede
    // farklı mikrosaniye, diğerleri farklı saatler.
    for (let i = 0; i < 4; i++) await insertUser(`same${i}`);
    await insertUser("micro1", "user", `${DAY} 11:00:00.000101+00`);
    await insertUser("micro2", "user", `${DAY} 11:00:00.000102+00`);
    await insertUser("google", "user", `${DAY} 12:00:00+00`);
    await insertUser("apple", "creator", `${DAY} 13:00:00+00`);
    await insertUser("phone", "user", `${DAY} 14:00:00+00`);
    await insertUser("legacy", "user", `${DAY} 15:00:00+00`);
    await insertUser("rich", "user", `${DAY} 16:00:00+00`);
    await insertUser("revoked", "user", `${DAY} 17:00:00+00`);

    const q = (text: string, values: unknown[]) => client.query(text, values);
    // Kimlikler: google önce, apple sonra (kayıt yöntemi en eski).
    await q(
      `INSERT INTO user_identity (user_id, provider, provider_subject, email_verified, created_at)
       VALUES ($1, 'google', $2, true, now() - interval '2 days'),
              ($1, 'apple', $3, true, now() - interval '1 day')`,
      [ids.google, `g-${TAG}`, `a1-${TAG}`],
    );
    await q(
      `INSERT INTO user_identity (user_id, provider, provider_subject, email_verified)
       VALUES ($1, 'apple', $2, true)`,
      [ids.apple, `a-${TAG}`],
    );
    await q(
      `INSERT INTO user_identity (user_id, provider, provider_subject, email_verified)
       VALUES ($1, 'phone', $2, false)`,
      [ids.phone, phone],
    );
    await q("INSERT INTO early_access (user_id) VALUES ($1), ($2)", [ids.google, ids.rich]);
    await q("UPDATE app_user SET last_seen_at = $2 WHERE id = $1", [
      ids.legacy,
      `${DAY} 18:30:00+00`,
    ]);

    // Özet: rich (analitik açık), google (yalnız hizmet), micro* (son aktif sıralaması).
    const summary = async (key: string, lastActive: string, analytics: boolean) => {
      await q(
        `INSERT INTO user_activity_summary
           (user_id, first_sign_in_at, last_sign_in_at, last_active_at, sign_in_count,
            service_counters_since, last_device_class, last_browser_family, last_country_code,
            search_count, product_view_count, merchant_exit_count, analytics_counters_since)
         SELECT id, created_at, $2, $2, 3, $3, 'mobile', 'safari', 'TR',
                ${analytics ? "5, 2, 1, $3" : "NULL, NULL, NULL, NULL"}
           FROM app_user WHERE id = $1`,
        [ids[key], lastActive, `${DAY} 09:00:00+00`],
      );
    };
    await summary("rich", `${DAY} 20:00:00+00`, true);
    await summary("google", `${DAY} 19:00:00+00`, false);
    await summary("micro1", `${DAY} 19:00:00+00`, false);
    await summary("micro2", `${DAY} 20:30:00.000001+00`, false);
    await summary("same0", `${DAY} 19:00:00+00`, false);

    // Rızalar: rich analitik kabul (sürümlü), revoked kabul → geri alma,
    // rich'in eski (sürümsüz, IP'li) pazarlama satırı.
    await q(
      `INSERT INTO user_consent (user_id, kind, granted, granted_at, source, text_version)
       VALUES ($1, 'cookie_analytics', true, now() - interval '1 hour', 'cookie_banner', 'cookie-v1'),
              ($1, 'privacy_notice', true, now() - interval '1 hour', 'sign_in', '2020-01-01')`,
      [ids.rich],
    );
    await q(
      `INSERT INTO user_consent (user_id, kind, granted, granted_at, ip)
       VALUES ($1, 'marketing_email', true, now() - interval '2 days', $2)`,
      [ids.rich, ips.consent],
    );
    // Aynı an iki satır: eşitlikte `id DESC` kazanır (son satır false).
    await q(
      `INSERT INTO user_consent (user_id, kind, granted, granted_at, source, text_version)
       VALUES ($1, 'cookie_analytics', true, $2, 'cookie_banner', 'cookie-v1'),
              ($1, 'cookie_analytics', false, $2, 'cookie_banner', 'cookie-v1')`,
      [ids.revoked, "2026-09-01 10:00:00+00"],
    );

    // Oturum (IP ve user agent ile — asla dönmemeli) ve giriş geçmişi.
    await q(
      `INSERT INTO session (user_id, token_hash, expires_at, ip, user_agent, device_class,
                            browser_family, country_code)
       VALUES ($1, $2, now() + interval '1 day', $3, $4, 'mobile', 'safari', 'TR')`,
      [ids.rich, `hash-${TAG}`, ips.session, userAgent],
    );
    await q(
      `INSERT INTO auth_event (user_id, kind, provider, device_class, browser_family, country_code)
       VALUES ($1, 'sign_up', 'google', 'mobile', 'safari', 'TR'),
              ($1, 'sign_in', 'google', 'desktop', 'chrome', 'DE'),
              ($1, 'sign_out', NULL, NULL, NULL, NULL)`,
      [ids.rich],
    );

    // Rızalı analitik olayı + hak kaydı (iki ayrı sınıf).
    await q(
      `INSERT INTO user_activity_event (user_id, kind, search_mode, query_norm, result_count)
       VALUES ($1, 'search_submitted', 'text', $2, 7)`,
      [ids.rich, `kirmizi elbise ${TAG}`],
    );
    const today = "(now() AT TIME ZONE 'Europe/Istanbul')::date";
    await q(
      `INSERT INTO ai_search_charge
         (user_id, operation, request_key, cost, day, from_daily, from_bonus, state, finalized_at)
       VALUES ($1, 'visual_search', $2, 1, ${today}, 1, 0, 'settled', now())`,
      [ids.rich, `req-${TAG}`],
    );

    // Attribution: mevcut bir teklif varsa iki tıklama.
    const offer = await q("SELECT id FROM offer ORDER BY id LIMIT 1", []);
    offerId = offer.rows[0] ? Number(offer.rows[0].id) : null;
    if (offerId) {
      await q(
        `INSERT INTO click (user_id, session_id, offer_id, channel, surface, price_at_click, created_at)
         VALUES ($1, $2, $3, 'web', 'search', 129990, now() - interval '1 hour'),
                ($1, $2, $3, 'web', 'compare', 99990, now())`,
        [ids.rich, `s-${TAG}`, offerId],
      );
    }
  });
});

afterAll(async () => {
  const all = Object.values(ids);
  await withOwnerClient(async (client) => {
    await client.query("DELETE FROM admin_audit_event WHERE actor_user_id = ANY($1)", [all]);
    await client.query("DELETE FROM click WHERE user_id = ANY($1)", [all]);
    await client.query("DELETE FROM app_user WHERE id = ANY($1)", [all]);
  });
});

async function walk(sort: UserListSort, filters: UserListFilters, pageSize: number) {
  const pages: string[][] = [];
  let cursor: string | null = null;
  let prevCursor: string | null = null;
  for (let i = 0; i < 50; i++) {
    const page = await listUsers(db, admin, { sort, filters, pageSize, cursor });
    pages.push(page.rows.map((row) => row.publicId));
    if (i > 0) expect(page.prevCursor).not.toBeNull();
    prevCursor = page.prevCursor;
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return { pages, lastPrev: prevCursor };
}

async function expectedOrder(sort: UserListSort): Promise<string[]> {
  return withOwnerClient(async (client) => {
    const res =
      sort === "created"
        ? await client.query(
            `SELECT public_id FROM app_user WHERE created_at >= $1::date AND created_at < $1::date + 2
              ORDER BY created_at DESC, id DESC`,
            [DAY],
          )
        : await client.query(
            `SELECT u.public_id FROM user_activity_summary s JOIN app_user u ON u.id = s.user_id
              WHERE s.last_active_at >= $1::date AND s.last_active_at < $1::date + 2
              ORDER BY s.last_active_at DESC, s.user_id DESC`,
            [DAY],
          );
    return res.rows.map((row) => row.public_id as string);
  });
}

describe("yetki: moderatör ve normal kullanıcı hiçbir yeni fonksiyonu çağıramaz", () => {
  const calls: [string, (actor: AdminActor) => Promise<unknown>][] = [
    ["listUsers", (actor) => listUsers(db, actor, {})],
    ["getUserProfile", (actor) => getUserProfile(db, actor, publicIds.rich ?? "")],
    ["getUserConsents", (actor) => getUserConsents(db, actor, publicIds.rich ?? "")],
    ["getUserActivity", (actor) => getUserActivity(db, actor, publicIds.rich ?? "")],
    ["getUserSessions", (actor) => getUserSessions(db, actor, publicIds.rich ?? "")],
    ["getUserSearches", (actor) => getUserSearches(db, actor, publicIds.rich ?? "")],
    ["getUserAffiliate", (actor) => getUserAffiliate(db, actor, publicIds.rich ?? "")],
    ["getUserAudit", (actor) => getUserAudit(db, actor, publicIds.rich ?? "")],
    [
      "revealUserContact",
      (actor) => revealUserContact(db, actor, publicIds.rich ?? "", "email", { fresh: true }),
    ],
  ];

  it.each(calls)("%s", async (_name, call) => {
    await expect(call(moderator)).rejects.toBeInstanceOf(AdminForbiddenError);
    await expect(call(normalUser)).rejects.toBeInstanceOf(AdminForbiddenError);
    await expect(call(admin)).resolves.not.toBeNull();
  });

  it("geçersiz ya da bilinmeyen hesap kimliği null döner", async () => {
    expect(await getUserActivity(db, admin, "not-a-uuid")).toBeNull();
    expect(await getUserConsents(db, admin, "0f8fad5b-d9cb-469f-a165-70867728950e")).toBeNull();
  });
});

describe("özet liste", () => {
  it("kayıt tarihi: keyset sayfalar tekrar ve atlama olmadan, geri dönüş aynı sayfaları verir", async () => {
    const expected = await expectedOrder("created");
    expect(expected).toHaveLength(12);
    const { pages } = await walk("created", RANGE, 5);
    expect(pages.map((page) => page.length)).toEqual([5, 5, 2]);
    expect(pages.flat()).toEqual(expected);

    // Son sayfadan geriye: önceki imleç ikinci sayfayı aynen verir.
    const p1 = await listUsers(db, admin, { filters: RANGE, pageSize: 5 });
    const p2 = await listUsers(db, admin, { filters: RANGE, pageSize: 5, cursor: p1.nextCursor });
    const p3 = await listUsers(db, admin, { filters: RANGE, pageSize: 5, cursor: p2.nextCursor });
    const back2 = await listUsers(db, admin, {
      filters: RANGE,
      pageSize: 5,
      cursor: p3.prevCursor,
    });
    expect(back2.rows.map((row) => row.publicId)).toEqual(p2.rows.map((row) => row.publicId));
    const back1 = await listUsers(db, admin, {
      filters: RANGE,
      pageSize: 5,
      cursor: back2.prevCursor,
    });
    expect(back1.rows.map((row) => row.publicId)).toEqual(p1.rows.map((row) => row.publicId));
    expect(back1.prevCursor).toBeNull();
    expect(p1.prevCursor).toBeNull();
  });

  it("aynı milisaniyedeki mikrosaniye farkı ve eşit zaman: sayfa sınırında kayıp yok", async () => {
    const expected = await expectedOrder("created");
    const { pages } = await walk("created", RANGE, 1);
    expect(pages.flat()).toEqual(expected);
  });

  it("son aktif sıralaması: yalnızca son aktifi olanlar, keyset tutarlı", async () => {
    const expected = await expectedOrder("last_active");
    expect(expected).toEqual([
      publicIds.micro2,
      publicIds.rich,
      ...[publicIds.google, publicIds.micro1, publicIds.same0].sort(
        (a, b) =>
          (ids[Object.keys(publicIds).find((k) => publicIds[k] === b) ?? ""] ?? 0) -
          (ids[Object.keys(publicIds).find((k) => publicIds[k] === a) ?? ""] ?? 0),
      ),
    ]);
    const { pages } = await walk("last_active", ACTIVE_RANGE, 2);
    expect(pages.flat()).toEqual(expected);
  });

  it("geçersiz imleç ilk sayfaya döner", async () => {
    const first = await listUsers(db, admin, { filters: RANGE, pageSize: 3 });
    const bogus = await listUsers(db, admin, {
      filters: RANGE,
      pageSize: 3,
      cursor: "c.bozuk-imlec",
    });
    expect(bogus.rows.map((row) => row.publicId)).toEqual(first.rows.map((row) => row.publicId));
  });

  it("filtreler: kayıt yöntemi, rol, erken erişim, analitik rızası", async () => {
    const keysOf = async (filters: UserListFilters) =>
      (await listUsers(db, admin, { filters: { ...RANGE, ...filters } })).rows
        .map((row) => Object.keys(publicIds).find((key) => publicIds[key] === row.publicId))
        .sort();
    expect(await keysOf({ provider: "google" })).toEqual(["google"]);
    expect(await keysOf({ provider: "apple" })).toEqual(["apple"]);
    expect(await keysOf({ provider: "phone" })).toEqual(["phone"]);
    expect((await keysOf({ provider: "email" })).length).toBe(9);
    expect(await keysOf({ role: "creator" })).toEqual(["apple"]);
    expect(await keysOf({ earlyAccess: "yes" })).toEqual(["google", "rich"]);
    expect((await keysOf({ earlyAccess: "no" })).length).toBe(10);
    expect(await keysOf({ analytics: "accepted" })).toEqual(["rich"]);
    expect(await keysOf({ analytics: "declined" })).toEqual(["revoked"]);
    expect((await keysOf({ analytics: "none" })).length).toBe(10);
    expect(await keysOf({ lastActiveFrom: DAY, lastActiveTo: DAY, earlyAccess: "yes" })).toEqual([
      "google",
      "rich",
    ]);
  });

  it("satırlar: maskeli e-posta, eski hesapta bilinmiyor + türetilmiş son giriş", async () => {
    const page = await listUsers(db, admin, { filters: RANGE });
    const dump = JSON.stringify(page);
    for (const email of Object.values(emails)) expect(dump).not.toContain(email);
    expect(dump).not.toContain(phone);
    const byKey = (key: string) => page.rows.find((row) => row.publicId === publicIds[key]);

    const legacy = byKey("legacy");
    expect(legacy?.emailMasked).toBe(`l***@test.local`);
    expect(legacy?.signupProvider).toBe("email");
    expect(legacy?.signInCount).toBeNull();
    expect(legacy?.searchCount).toBeNull();
    expect(legacy?.lastActiveAt).toBeNull();
    expect(legacy?.lastSignInDerived).toBe(true);
    expect(legacy?.lastSignInAt?.toISOString()).toBe(`${DAY}T18:30:00.000Z`);

    const rich = byKey("rich");
    expect(rich?.signInCount).toBe(3);
    expect(rich?.searchCount).toBe(5);
    expect(rich?.analyticsConsent).toBe("accepted");
    expect(rich?.lastSignInDerived).toBe(false);
    // Hizmet özeti var ama analitik yok → analitik sayaçları bilinmiyor.
    expect(byKey("google")?.searchCount).toBeNull();
    expect(byKey("google")?.signInCount).toBe(3);
    expect(byKey("google")?.signupProvider).toBe("google");
  });

  it("users.list denetimi: filtre adları var, filtre değerleri yok", async () => {
    await listUsers(db, admin, { filters: { ...RANGE, role: "creator" }, sort: "created" });
    const row = await withOwnerClient(async (client) => {
      const res = await client.query(
        `SELECT after::text AS a FROM admin_audit_event
          WHERE actor_user_id = $1 AND action = 'users.list' ORDER BY id DESC LIMIT 1`,
        [admin.userId],
      );
      return res.rows[0]?.a as string;
    });
    expect(row).toContain("createdFrom");
    expect(row).toContain("role");
    expect(row).not.toContain(DAY);
    expect(row).not.toContain("creator");
  });
});

describe("tıkla-göster", () => {
  it("taze giriş yoksa core da reddeder", async () => {
    await expect(
      revealUserContact(db, admin, publicIds.rich ?? "", "email", { fresh: false }),
    ).rejects.toBeInstanceOf(FreshAuthRequiredError);
  });

  it("tam değeri döner; denetimde alan adı var, değer yok", async () => {
    const email = await revealUserContact(db, admin, publicIds.rich ?? "", "email", {
      fresh: true,
    });
    expect(email).toEqual({ field: "email", value: emails.rich });
    const tel = await revealUserContact(db, admin, publicIds.phone ?? "", "phone", {
      fresh: true,
    });
    expect(tel).toEqual({ field: "phone", value: phone });
    const none = await revealUserContact(db, admin, publicIds.rich ?? "", "phone", {
      fresh: true,
    });
    expect(none?.value).toBeNull();

    const rows = await withOwnerClient(async (client) => {
      const res = await client.query(
        `SELECT action, target_id, before::text AS b, after::text AS a, reason
           FROM admin_audit_event WHERE actor_user_id = $1`,
        [admin.userId],
      );
      return res.rows as { action: string; target_id: string; a: string | null }[];
    });
    const reveals = rows.filter((row) => row.action === "users.reveal_contact");
    expect(reveals.map((row) => row.a)).toEqual(
      expect.arrayContaining(['{"field": "email"}', '{"field": "phone"}']),
    );
    expect(reveals.some((row) => row.target_id === String(ids.rich))).toBe(true);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(emails.rich);
    expect(dump).not.toContain(phone);
  });
});

describe("ayrıntı sekmeleri", () => {
  const tabAudits = async (userId: number) =>
    withOwnerClient(async (client) => {
      const res = await client.query(
        `SELECT action, after->>'tab' AS tab FROM admin_audit_event
          WHERE actor_user_id = $1 AND target_type = 'app_user' AND target_id = $2
          ORDER BY id`,
        [admin.userId, String(userId)],
      );
      return res.rows as { action: string; tab: string | null }[];
    });

  it("profil: hizmet özeti; eski hesapta türetilmiş son giriş ve bilinmeyen sayaç", async () => {
    const rich = await getUserProfile(db, admin, publicIds.rich ?? "");
    expect(rich?.service).toMatchObject({ hasSummary: true, signInCount: 3 });
    const legacy = await getUserProfile(db, admin, publicIds.legacy ?? "");
    expect(legacy?.service).toMatchObject({
      hasSummary: false,
      signInCount: null,
      lastSignInDerived: true,
      lastActiveAt: null,
    });
    expect(legacy?.service.firstSignInAt.toISOString()).toBe(`${DAY}T15:00:00.000Z`);
    expect(JSON.stringify(rich)).not.toContain(emails.rich);
  });

  it("izinler: durum türetme, eşitlikte id, sürümsüz kayıt etiketi, IP yok", async () => {
    const view = await getUserConsents(db, admin, publicIds.rich ?? "");
    expect(view).not.toBeNull();
    if (!view) return;
    const cookie = Object.fromEntries(view.cookies.map((s) => [s.kind, s.status]));
    expect(cookie).toEqual({
      cookie_functional: "unknown",
      cookie_analytics: "accepted",
      cookie_marketing: "unknown",
    });
    const marketing = view.account.find((s) => s.kind === "marketing_email");
    expect(marketing).toMatchObject({ status: "accepted", versionless: true });
    expect(view.privacyNotice).toMatchObject({ textVersion: "2020-01-01", isCurrent: false });
    expect(view.history.map((row) => row.kind)).toContain("privacy_notice");
    expect(view.history.find((row) => row.kind === "marketing_email")?.versionless).toBe(true);
    const dump = JSON.stringify(view);
    expect(dump).not.toContain(ips.consent);
    expect(dump).not.toMatch(/"ip"/);

    const revoked = await getUserConsents(db, admin, publicIds.revoked ?? "");
    expect(revoked?.cookies.find((s) => s.kind === "cookie_analytics")?.status).toBe("revoked");
  });

  it("izinler geçmişi sayfalanır", async () => {
    const first = await getUserConsents(db, admin, publicIds.rich ?? "", { pageSize: 2 });
    expect(first?.history).toHaveLength(2);
    expect(first?.nextCursor).not.toBeNull();
    const second = await getUserConsents(db, admin, publicIds.rich ?? "", {
      pageSize: 2,
      cursor: first?.nextCursor,
    });
    expect(second?.history).toHaveLength(1);
    expect(second?.nextCursor).toBeNull();
  });

  it("aktivite: sayaçlar ve olaylar; users.view + users.view_tab yazılır", async () => {
    const view = await getUserActivity(db, admin, publicIds.rich ?? "");
    expect(view?.counters).toMatchObject({ searchCount: 5, productViewCount: 2 });
    expect(view?.events[0]).toMatchObject({
      kind: "search_submitted",
      queryNorm: `kirmizi elbise ${TAG}`,
      resultCount: 7,
      product: null,
    });
    const audits = await tabAudits(ids.rich as number);
    expect(audits).toEqual(
      expect.arrayContaining([
        { action: "users.view", tab: "activity" },
        { action: "users.view_tab", tab: "activity" },
      ]),
    );
    // İzinler hassas sekme değil: view_tab yok.
    expect(
      audits.filter((row) => row.action === "users.view_tab" && row.tab === "consents"),
    ).toEqual([]);
  });

  it("aktivite: rıza olmayan eski hesapta sayaçlar bilinmiyor", async () => {
    const view = await getUserActivity(db, admin, publicIds.legacy ?? "");
    expect(view?.counters).toEqual({
      searchCount: null,
      productViewCount: null,
      merchantExitCount: null,
      lastSearchAt: null,
      analyticsCountersSince: null,
    });
    expect(view?.events).toEqual([]);
  });

  it("oturumlar: kaba bağlam var; IP, user agent, token özeti yok", async () => {
    const view = await getUserSessions(db, admin, publicIds.rich ?? "");
    expect(view?.activeSessions).toHaveLength(1);
    expect(view?.activeSessions[0]).toMatchObject({
      deviceClass: "mobile",
      browserFamily: "safari",
      countryCode: "TR",
    });
    expect(Object.keys(view?.activeSessions[0] ?? {}).sort()).toEqual([
      "browserFamily",
      "countryCode",
      "createdAt",
      "deviceClass",
      "expiresAt",
      "lastUsedAt",
    ]);
    expect(view?.authEvents.map((row) => row.kind).sort()).toEqual([
      "sign_in",
      "sign_out",
      "sign_up",
    ]);
    const dump = JSON.stringify(view);
    expect(dump).not.toContain(ips.session);
    expect(dump).not.toContain(userAgent);
    expect(dump).not.toContain(`hash-${TAG}`);
    expect(dump).not.toMatch(/"(ip|userAgent|user_agent|tokenHash|sessionId)"/);
  });

  it("aramalar: hak kaydı ve rızalı metin aramaları ayrı listeler", async () => {
    const view = await getUserSearches(db, admin, publicIds.rich ?? "");
    expect(view?.charges.map((row) => row.operation)).toEqual(["visual_search"]);
    expect(view?.textSearches.map((row) => row.queryNorm)).toEqual([`kirmizi elbise ${TAG}`]);
    expect(view?.textSearchCount).toBe(5);
  });

  it("affiliate: attribution kayıtları, sayı ve sayfalama", async () => {
    const view = await getUserAffiliate(db, admin, publicIds.rich ?? "", { pageSize: 1 });
    if (!offerId) {
      expect(view?.clickCount).toBe(0);
      return;
    }
    expect(view?.clickCount).toBe(2);
    expect(view?.clicks[0]).toMatchObject({ surface: "compare", priceAtClick: 99990 });
    const next = await getUserAffiliate(db, admin, publicIds.rich ?? "", {
      pageSize: 1,
      cursor: view?.nextCursor,
    });
    expect(next?.clicks[0]).toMatchObject({ surface: "search", priceAtClick: 129990 });
    expect(next?.nextCursor).toBeNull();
    const audits = await tabAudits(ids.rich as number);
    expect(audits).toContainEqual({ action: "users.view_tab", tab: "affiliate" });
  });

  it("denetim sekmesi: bu hesabı hedef alan kayıtlar", async () => {
    const view = await getUserAudit(db, admin, publicIds.rich ?? "");
    expect(view?.events.rows.length).toBeGreaterThan(0);
    expect(view?.events.rows.every((row) => row.targetId === String(ids.rich))).toBe(true);
  });
});
