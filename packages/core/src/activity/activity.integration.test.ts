/**
 * docs/decisions/0049 - giriş/çıkış geçmişi, kullanıcı özeti, rıza kapısı,
 * geri alma, saklama süreleri, silme ve veri indirme. Gerçek Postgres
 * (yerel); test edilen kod `arilla_app` rolüyle bağlanır.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InvalidConsentInputError, setConsent } from "../account/consent.ts";
import { deleteAccount } from "../account/delete-account.ts";
import { exportUserData } from "../account/export-user-data.ts";
import { recordClick } from "../attribution/record-click.ts";
import { signInWithGoogle } from "../auth/google-oauth.ts";
import { signInWithIdentity } from "../auth/identity-sign-in.ts";
import { deleteSession, verifySessionToken } from "../auth/session.ts";
import {
  getLatestConsents,
  PRIVACY_NOTICE_VERSION,
  recordCookieDecision,
  syncConsentOnSignIn,
} from "../consent/account-consent.ts";
import {
  acceptAll,
  type CookieConsent,
  fromSelection,
  rejectAll,
} from "../consent/cookie-consent.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { recordActivity } from "./record.ts";
import { purgeExpiredActivity } from "./retention.ts";

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const MOBILE_CONTEXT = {
  deviceClass: "mobile",
  browserFamily: "chrome",
  countryCode: "TR",
} as const;

let db: Database;
let productId = 0;
let offerId = 0;
const createdUsers: number[] = [];

async function phoneSignIn(subject: string) {
  const result = await signInWithIdentity(db, {
    provider: "phone",
    subject,
    email: null,
    emailVerified: false,
    displayName: null,
    ip: "203.0.113.10",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Version/17.5 Safari/604.1",
    context: MOBILE_CONTEXT,
  });
  if (!createdUsers.includes(result.user.id)) createdUsers.push(result.user.id);
  return result;
}

async function rows<T>(query: string, params: unknown[]): Promise<T[]> {
  return withOwnerClient(async (client) => (await client.query(query, params)).rows as T[]);
}

function consentAt(analytics: boolean, at: Date): CookieConsent {
  return fromSelection({ functional: false, analytics, marketing: false }, at);
}

beforeAll(async () => {
  db = getTestDb();
  const offers = await rows<{ id: string; product_id: string }>(
    `SELECT o.id, o.product_id FROM offer o
       JOIN merchant m ON m.id = o.merchant_id
      WHERE o.product_id IS NOT NULL
      ORDER BY o.id LIMIT 1`,
    [],
  );
  const offer = offers[0];
  if (!offer) throw new Error("seed'li offer yok - once `pnpm seed`");
  offerId = Number(offer.id);
  productId = Number(offer.product_id);
});

afterAll(async () => {
  if (createdUsers.length > 0) {
    await withOwnerClient(async (client) => {
      await client.query("UPDATE click SET user_id = NULL WHERE user_id = ANY($1)", [createdUsers]);
      await client.query("DELETE FROM app_user WHERE id = ANY($1)", [createdUsers]);
    });
  }
});

describe("giriş/çıkış geçmişi ve özet", () => {
  it("ilk giriş sign_up + sign_in yazar; tekrar giriş yalnızca sign_in; IP/UA yeni tablolarda yok", async () => {
    const subject = `+90555${suffix.slice(-7)}1`;
    const first = await phoneSignIn(subject);
    expect(first.isNewUser).toBe(true);
    const second = await phoneSignIn(subject);
    expect(second.isNewUser).toBe(false);
    const userId = first.user.id;

    const events = await rows<{
      kind: string;
      provider: string;
      device_class: string;
      country_code: string;
    }>(
      "SELECT kind, provider, device_class, country_code FROM auth_event WHERE user_id = $1 ORDER BY id",
      [userId],
    );
    expect(events.map((e) => e.kind)).toEqual(["sign_up", "sign_in", "sign_in"]);
    expect(events.every((e) => e.provider === "phone")).toBe(true);
    expect(events[0]?.device_class).toBe("mobile");
    expect(events[0]?.country_code).toBe("TR");

    const [summary] = await rows<{
      sign_in_count: number;
      first_sign_in_at: Date;
      created_at_user: Date;
      last_country_code: string;
      search_count: number | null;
    }>(
      `SELECT s.sign_in_count, s.first_sign_in_at, u.created_at AS created_at_user,
              s.last_country_code, s.search_count
         FROM user_activity_summary s JOIN app_user u ON u.id = s.user_id WHERE s.user_id = $1`,
      [userId],
    );
    expect(summary?.sign_in_count).toBe(2);
    expect(summary?.first_sign_in_at.getTime()).toBe(summary?.created_at_user.getTime());
    expect(summary?.last_country_code).toBe("TR");
    // Analitik sayacı rıza olmadan NULL (bilinmiyor), 0 değil.
    expect(summary?.search_count).toBeNull();

    const sessions = await rows<{ device_class: string; browser_family: string }>(
      "SELECT device_class, browser_family FROM session WHERE user_id = $1",
      [userId],
    );
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.browser_family).toBe("chrome");
  });

  it("eşzamanlı ilk giriş tek sign_up üretir", async () => {
    const profile = {
      sub: `uac-race-${suffix}`,
      email: `uac-race-${suffix}@example.test`,
      emailVerified: true,
      name: null,
      picture: null,
    };
    const results = await Promise.all(
      [0, 1, 2].map(() => signInWithGoogle(db, { profile, ip: null, userAgent: null })),
    );
    const userId = results[0]?.user.id ?? 0;
    createdUsers.push(userId);
    expect(new Set(results.map((r) => r.user.id)).size).toBe(1);
    const [count] = await rows<{ sign_ups: string; sign_ins: string }>(
      `SELECT count(*) FILTER (WHERE kind = 'sign_up') AS sign_ups,
              count(*) FILTER (WHERE kind = 'sign_in') AS sign_ins
         FROM auth_event WHERE user_id = $1`,
      [userId],
    );
    expect(Number(count?.sign_ups)).toBe(1);
    expect(Number(count?.sign_ins)).toBe(3);
  });

  it("çıkış sign_out, sunucu sonlandırması session_revoked yazar", async () => {
    const a = await phoneSignIn(`+90555${suffix.slice(-7)}2`);
    const b = await phoneSignIn(`+90555${suffix.slice(-7)}2`);
    await deleteSession(db, a.rawSessionToken);
    await deleteSession(db, b.rawSessionToken, "session_revoked");
    await deleteSession(db, b.rawSessionToken, "session_revoked"); // zaten yok: olay yazılmaz
    const kinds = await rows<{ kind: string }>(
      "SELECT kind FROM auth_event WHERE user_id = $1 AND kind IN ('sign_out','session_revoked') ORDER BY id",
      [a.user.id],
    );
    expect(kinds.map((k) => k.kind)).toEqual(["sign_out", "session_revoked"]);
  });

  it("son aktif eşikle yazılır ve geriye gitmez", async () => {
    const signed = await phoneSignIn(`+90555${suffix.slice(-7)}3`);
    const userId = signed.user.id;
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await withOwnerClient(async (client) => {
      await client.query("UPDATE session SET last_used_at = $2 WHERE user_id = $1", [userId, old]);
      await client.query(
        "UPDATE user_activity_summary SET last_active_at = $2 WHERE user_id = $1",
        [userId, old],
      );
    });
    const user = await verifySessionToken(db, signed.rawSessionToken);
    expect(user?.id).toBe(userId);
    const [after] = await rows<{ last_active_at: Date }>(
      "SELECT last_active_at FROM user_activity_summary WHERE user_id = $1",
      [userId],
    );
    expect(after?.last_active_at.getTime()).toBeGreaterThan(old.getTime());
    // Hemen ikinci doğrulama: oturumun önceki kullanımı yeni → yazılmaz.
    await verifySessionToken(db, signed.rawSessionToken);
    const [again] = await rows<{ last_active_at: Date }>(
      "SELECT last_active_at FROM user_activity_summary WHERE user_id = $1",
      [userId],
    );
    expect(again?.last_active_at.getTime()).toBe(after?.last_active_at.getTime());
  });
});

describe("rıza kapısı ve analitik", () => {
  it("anonim ya da rızasız istek hiçbir şey yazmaz", async () => {
    const signed = await phoneSignIn(`+90555${suffix.slice(-7)}4`);
    expect(
      await recordActivity(db, {
        userId: null,
        cookieConsent: acceptAll(),
        event: { kind: "product_viewed", productId },
      }),
    ).toBe("no_user");
    expect(
      await recordActivity(db, {
        userId: signed.user.id,
        cookieConsent: null,
        event: { kind: "product_viewed", productId },
      }),
    ).toBe("no_consent");
    expect(
      await recordActivity(db, {
        userId: signed.user.id,
        cookieConsent: rejectAll(),
        event: { kind: "search_submitted", query: "kırmızı elbise", resultCount: 3 },
      }),
    ).toBe("no_consent");
    const [count] = await rows<{ n: string }>(
      "SELECT count(*) AS n FROM user_activity_event WHERE user_id = $1",
      [signed.user.id],
    );
    expect(Number(count?.n)).toBe(0);
    const [summary] = await rows<{
      search_count: number | null;
      product_view_count: number | null;
    }>("SELECT search_count, product_view_count FROM user_activity_summary WHERE user_id = $1", [
      signed.user.id,
    ]);
    expect(summary?.search_count).toBeNull();
    expect(summary?.product_view_count).toBeNull();
  });

  it("rızayla yazar, sayaçları artırır, tekrarı bastırır; tıklama ayrı kalır", async () => {
    const signed = await phoneSignIn(`+90555${suffix.slice(-7)}5`);
    const userId = signed.user.id;
    const consent = acceptAll();
    await recordCookieDecision(db, { userId, consent, source: "cookie_banner" });

    const search = {
      kind: "search_submitted" as const,
      query: "  Siyah  ELBİSE ",
      resultCount: 12,
    };
    expect(await recordActivity(db, { userId, cookieConsent: consent, event: search })).toBe(
      "recorded",
    );
    expect(await recordActivity(db, { userId, cookieConsent: consent, event: search })).toBe(
      "duplicate",
    );
    const view = { kind: "product_viewed" as const, productId };
    expect(await recordActivity(db, { userId, cookieConsent: consent, event: view })).toBe(
      "recorded",
    );
    expect(await recordActivity(db, { userId, cookieConsent: consent, event: view })).toBe(
      "duplicate",
    );

    const { clickId } = await recordClick(db, {
      offerId,
      sessionId: `uac-${suffix}`,
      channel: "web",
      surface: "evil<script>",
      userId,
    });
    expect(
      await recordActivity(db, {
        userId,
        cookieConsent: consent,
        event: { kind: "merchant_exit", offerId, clickId },
      }),
    ).toBe("recorded");

    const events = await rows<{ kind: string; query_norm: string | null }>(
      "SELECT kind, query_norm FROM user_activity_event WHERE user_id = $1 ORDER BY id",
      [userId],
    );
    expect(events.map((e) => e.kind)).toEqual([
      "search_submitted",
      "product_viewed",
      "merchant_exit",
    ]);
    expect(events[0]?.query_norm).toBe("siyah elbise");

    const [summary] = await rows<{
      search_count: number;
      product_view_count: number;
      merchant_exit_count: number;
      last_search_at: Date | null;
    }>(
      "SELECT search_count, product_view_count, merchant_exit_count, last_search_at FROM user_activity_summary WHERE user_id = $1",
      [userId],
    );
    expect(summary).toMatchObject({
      search_count: 1,
      product_view_count: 1,
      merchant_exit_count: 1,
    });
    expect(summary?.last_search_at).not.toBeNull();

    const [clickRow] = await rows<{ user_id: string; surface: string | null }>(
      "SELECT user_id, surface FROM click WHERE id = $1",
      [clickId],
    );
    expect(Number(clickRow?.user_id)).toBe(userId);
    expect(clickRow?.surface).toBeNull(); // izinli olmayan yüzey yazılmaz
  });

  it("başka cihazdan daha yeni geri alma, eski çerez izin verse de yazmayı durdurur", async () => {
    const signed = await phoneSignIn(`+90555${suffix.slice(-7)}6`);
    const userId = signed.user.id;
    const oldCookie = consentAt(true, new Date(Date.now() - 60_000));
    await recordCookieDecision(db, { userId, consent: oldCookie, source: "cookie_banner" });
    await recordCookieDecision(db, {
      userId,
      consent: consentAt(false, new Date()),
      source: "cookie_banner",
    });
    expect(
      await recordActivity(db, {
        userId,
        cookieConsent: oldCookie,
        event: { kind: "product_viewed", productId },
      }),
    ).toBe("no_consent");
  });

  it("geri alma: analitik olayları silinir, sayaçlar NULL olur, giriş geçmişi kalır", async () => {
    const signed = await phoneSignIn(`+90555${suffix.slice(-7)}7`);
    const userId = signed.user.id;
    const yes = consentAt(true, new Date(Date.now() - 5_000));
    await recordCookieDecision(db, { userId, consent: yes, source: "cookie_banner" });
    await recordActivity(db, {
      userId,
      cookieConsent: yes,
      event: { kind: "product_viewed", productId },
    });

    const result = await recordCookieDecision(db, {
      userId,
      consent: consentAt(false, new Date()),
      source: "cookie_banner",
    });
    expect(result.analyticsRevoked).toBe(true);
    expect(result.eventsDeleted).toBe(1);

    const [events] = await rows<{ n: string }>(
      "SELECT count(*) AS n FROM user_activity_event WHERE user_id = $1",
      [userId],
    );
    expect(Number(events?.n)).toBe(0);
    const [summary] = await rows<{
      product_view_count: number | null;
      analytics_counters_since: Date | null;
      sign_in_count: number;
    }>(
      "SELECT product_view_count, analytics_counters_since, sign_in_count FROM user_activity_summary WHERE user_id = $1",
      [userId],
    );
    expect(summary?.product_view_count).toBeNull();
    expect(summary?.analytics_counters_since).toBeNull();
    expect(summary?.sign_in_count).toBe(1);
    const [auth] = await rows<{ n: string }>(
      "SELECT count(*) AS n FROM auth_event WHERE user_id = $1",
      [userId],
    );
    expect(Number(auth?.n)).toBeGreaterThan(0);
  });

  it("çerez bandı: kaynak ve sürüm yazılır, değişmeyen karar satır üretmez, IP yazılmaz", async () => {
    const signed = await phoneSignIn(`+90555${suffix.slice(-7)}8`);
    const userId = signed.user.id;
    const first = await recordCookieDecision(db, {
      userId,
      consent: acceptAll(),
      source: "cookie_banner",
    });
    expect(first.written.sort()).toEqual(["analytics", "functional", "marketing"]);
    const again = await recordCookieDecision(db, {
      userId,
      consent: acceptAll(),
      source: "cookie_banner",
    });
    expect(again.written).toEqual([]);
    const consents = await rows<{ source: string; text_version: string; ip: string | null }>(
      "SELECT source, text_version, ip FROM user_consent WHERE user_id = $1 AND kind LIKE 'cookie_%'",
      [userId],
    );
    expect(consents).toHaveLength(3);
    expect(
      consents.every((c) => c.source === "cookie_banner" && c.text_version === "cookie-v1"),
    ).toBe(true);
    expect(consents.every((c) => c.ip === null)).toBe(true);
  });

  it("girişte senkron: hesapta daha yeni karar varsa eski çerez onu ezmez; aydınlatma sürümü bir kez yazılır", async () => {
    const signed = await phoneSignIn(`+90555${suffix.slice(-7)}9`);
    const userId = signed.user.id;
    await recordCookieDecision(db, {
      userId,
      consent: consentAt(false, new Date()),
      source: "cookie_banner",
    });
    await syncConsentOnSignIn(db, {
      userId,
      cookie: consentAt(true, new Date(Date.now() - 86_400_000)),
    });
    await syncConsentOnSignIn(db, { userId, cookie: null });
    const latest = await getLatestConsents(db, userId, ["cookie_analytics", "privacy_notice"]);
    expect(latest.get("cookie_analytics")?.granted).toBe(false);
    expect(latest.get("privacy_notice")?.textVersion).toBe(PRIVACY_NOTICE_VERSION);
    const notices = await rows<{ n: string }>(
      "SELECT count(*) AS n FROM user_consent WHERE user_id = $1 AND kind = 'privacy_notice'",
      [userId],
    );
    expect(Number(notices[0]?.n)).toBe(1);
  });

  it("eski (sürümsüz) rıza satırları geçerli kalır; hesap izinleri yalnızca dört tür yazar", async () => {
    const signed = await phoneSignIn(`+90555${suffix.slice(-7)}0`);
    const userId = signed.user.id;
    await withOwnerClient((client) =>
      client.query(
        "INSERT INTO user_consent (user_id, kind, granted) VALUES ($1, 'marketing_email', true)",
        [userId],
      ),
    );
    const latest = await getLatestConsents(db, userId, ["marketing_email"]);
    expect(latest.get("marketing_email")?.granted).toBe(true);
    expect(latest.get("marketing_email")?.textVersion).toBeNull();
    await expect(
      setConsent(db, {
        userId,
        // biome-ignore lint/suspicious/noExplicitAny: çalışma zamanı doğrulamasını sınar
        kind: "privacy_notice" as any,
        granted: true,
        ip: null,
      }),
    ).rejects.toBeInstanceOf(InvalidConsentInputError);
  });
});

describe("saklama süreleri, silme, veri indirme, şema güvenliği", () => {
  it("süresi dolan olaylar silinir, sorgu metni ve eski IP NULL olur; yeniler kalır", async () => {
    const signed = await phoneSignIn(`+90555${suffix.slice(-6)}11`);
    const userId = signed.user.id;
    const day = 86_400_000;
    await withOwnerClient(async (client) => {
      await client.query(
        `INSERT INTO user_activity_event (user_id, kind, search_mode, query_norm, created_at) VALUES
           ($1, 'search_submitted', 'text', 'çok eski', now() - interval '200 days'),
           ($1, 'search_submitted', 'text', 'orta eski', now() - interval '100 days'),
           ($1, 'search_submitted', 'text', 'yeni', now())`,
        [userId],
      );
      await client.query(
        "INSERT INTO auth_event (user_id, kind, created_at) VALUES ($1, 'sign_out', now() - interval '400 days')",
        [userId],
      );
      await client.query(
        "INSERT INTO user_consent (user_id, kind, granted, granted_at, ip) VALUES ($1, 'personalization', true, now() - interval '400 days', '203.0.113.5')",
        [userId],
      );
    });
    const result = await purgeExpiredActivity(db, {
      now: new Date(Date.now() + 1000),
      batchSize: 2,
    });
    expect(result.activityEventsDeleted).toBeGreaterThanOrEqual(1);
    expect(result.queryNormsCleared).toBeGreaterThanOrEqual(1);
    expect(result.authEventsDeleted).toBeGreaterThanOrEqual(1);
    expect(result.consentIpsCleared).toBeGreaterThanOrEqual(1);
    const remaining = await rows<{ query_norm: string | null }>(
      "SELECT query_norm FROM user_activity_event WHERE user_id = $1 ORDER BY created_at",
      [userId],
    );
    expect(remaining.map((r) => r.query_norm)).toEqual([null, "yeni"]);
    const ips = await rows<{ ip: string | null }>(
      "SELECT ip FROM user_consent WHERE user_id = $1 AND kind = 'personalization'",
      [userId],
    );
    expect(ips[0]?.ip).toBeNull();
    void day;
  });

  it("veri indirme yeni alanları içerir, IP/oturum/tıklama kimliği içermez", async () => {
    const signed = await phoneSignIn(`+90555${suffix.slice(-6)}12`);
    const userId = signed.user.id;
    await recordCookieDecision(db, { userId, consent: acceptAll(), source: "cookie_banner" });
    await recordActivity(db, {
      userId,
      cookieConsent: acceptAll(),
      event: { kind: "product_viewed", productId },
    });
    const data = await exportUserData(db, userId);
    expect(data.authHistory.map((e) => e.kind)).toContain("sign_up");
    expect(data.activitySummary?.signInCount).toBe(1);
    expect(data.activityEvents).toHaveLength(1);
    expect(data.consents.some((c) => c.source === "cookie_banner")).toBe(true);
    const json = JSON.stringify(data);
    expect(json).not.toContain("203.0.113.10");
    expect(json).not.toContain("sessionId");
    expect(json).not.toContain("clickId");
  });

  it("hesap silme yeni tablolardaki satırları siler, tıklamayı kimliksizleştirir", async () => {
    const signed = await phoneSignIn(`+90555${suffix.slice(-6)}13`);
    const userId = signed.user.id;
    const consent = acceptAll();
    await recordCookieDecision(db, { userId, consent, source: "cookie_banner" });
    const { clickId } = await recordClick(db, {
      offerId,
      sessionId: `uac-del-${suffix}`,
      channel: "web",
      userId,
    });
    await recordActivity(db, {
      userId,
      cookieConsent: consent,
      event: { kind: "merchant_exit", offerId, clickId },
    });
    await deleteAccount(db, userId);
    for (const table of [
      "auth_event",
      "user_activity_event",
      "user_activity_summary",
      "user_consent",
    ]) {
      const [count] = await rows<{ n: string }>(
        `SELECT count(*) AS n FROM ${table} WHERE user_id = $1`,
        [userId],
      );
      expect(Number(count?.n), table).toBe(0);
    }
    const [clickRow] = await rows<{ user_id: string | null }>(
      "SELECT user_id FROM click WHERE id = $1",
      [clickId],
    );
    expect(clickRow?.user_id).toBeNull();
  });

  it("yeni tablolarda IP, ham user agent, token, başlık ya da gövde kolonu yok", async () => {
    const columns = await rows<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('auth_event','user_activity_event','user_activity_summary')`,
      [],
    );
    expect(columns.length).toBeGreaterThan(20);
    for (const column of columns) {
      expect(column.data_type, `${column.table_name}.${column.column_name}`).not.toMatch(
        /inet|json/,
      );
      expect(column.column_name, column.table_name).not.toMatch(
        /(^|_)(ip|user_agent|token|header|headers|body|payload|metadata|secret|email|phone)($|_)/,
      );
    }
  });
});
