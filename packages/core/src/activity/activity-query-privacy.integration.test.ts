/**
 * Karar 0089 - kullanıcıya bağlı arama metni süzgeci, gerçek Postgres:
 * - süzgeçten geçmeyen aramada olay yazılır, `query_norm` NULL kalır
 * - sonuç sayısı, sayaçlar ve son arama zamanı çalışmaya devam eder
 * - NULL-güvenli tekrar bastırma; normal sorgu bastırması değişmez
 * - rıza reddi ve geri alma davranışı aynı; veri indirme biçimi aynı
 * - sağlayıcı çağrısı yok
 */
import type { Database } from "@arilla/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { exportUserData } from "../account/export-user-data.ts";
import { signInWithIdentity } from "../auth/identity-sign-in.ts";
import { recordCookieDecision } from "../consent/account-consent.ts";
import { acceptAll, fromSelection, rejectAll } from "../consent/cookie-consent.ts";
import { normalizeQueryText } from "../search/normalize.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import {
  ACTIVITY_BLOCKED_QUERIES,
  ACTIVITY_STORED_QUERIES,
} from "./activity-query-privacy-cases.ts";
import { recordActivity, SEARCH_DEDUPE_MS } from "./record.ts";

const suffix = `${Date.now()}`.slice(-7);
const MINUTE = 60_000;
let db: Database;
let phoneSeq = 0;
const createdUsers: number[] = [];

async function newConsentedUser(): Promise<number> {
  phoneSeq += 1;
  const result = await signInWithIdentity(db, {
    provider: "phone",
    subject: `+90554${suffix}${phoneSeq}`,
    email: null,
    emailVerified: false,
    displayName: null,
    ip: "203.0.113.10",
    userAgent: "Mozilla/5.0",
    context: { deviceClass: "mobile", browserFamily: "chrome", countryCode: "TR" },
  });
  createdUsers.push(result.user.id);
  return result.user.id;
}

async function rows<T>(query: string, params: unknown[]): Promise<T[]> {
  return withOwnerClient(async (client) => (await client.query(query, params)).rows as T[]);
}

interface SearchRow {
  query_norm: string | null;
  result_count: number | null;
  search_mode: string | null;
  created_at: Date;
}

const searchRows = (userId: number) =>
  rows<SearchRow>(
    `SELECT query_norm, result_count, search_mode, created_at FROM user_activity_event
      WHERE user_id = $1 AND kind = 'search_submitted' ORDER BY created_at, id`,
    [userId],
  );

const search = (query: string, resultCount: number | null = 4) => ({
  kind: "search_submitted" as const,
  query,
  resultCount,
});

beforeAll(() => {
  db = getTestDb();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (createdUsers.length > 0) {
    await withOwnerClient(async (client) => {
      await client.query("DELETE FROM app_user WHERE id = ANY($1)", [createdUsers]);
    });
  }
});

describe("kullanıcıya bağlı arama metni (karar 0089)", () => {
  it("süzgeçten geçmeyen arama olay yazar, metin NULL; sayaçlar ve sonuç sayısı çalışır", async () => {
    const userId = await newConsentedUser();
    const consent = acceptAll();
    await recordCookieDecision(db, { userId, consent, source: "cookie_banner" });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const [usageBefore] = await rows<{ n: number }>("SELECT count(*)::int AS n FROM api_usage", []);

    // Her arama tekrar penceresinin dışında: hepsi ayrı olay olmalı.
    const base = Date.now() - 12 * 60 * MINUTE;
    const all = [...ACTIVITY_BLOCKED_QUERIES.map(([, raw]) => raw), ...ACTIVITY_STORED_QUERIES];
    for (const [i, raw] of all.entries()) {
      const now = new Date(base + i * (SEARCH_DEDUPE_MS + MINUTE));
      expect(
        await recordActivity(db, { userId, cookieConsent: consent, event: search(raw, i), now }),
      ).toBe("recorded");
    }

    const events = await searchRows(userId);
    expect(events).toHaveLength(all.length);
    for (const [i, event] of events.entries()) {
      expect(event.search_mode).toBe("text");
      expect(event.result_count).toBe(i);
    }
    const blocked = events.slice(0, ACTIVITY_BLOCKED_QUERIES.length);
    expect(blocked.every((e) => e.query_norm === null)).toBe(true);
    expect(events.slice(ACTIVITY_BLOCKED_QUERIES.length).map((e) => e.query_norm)).toEqual(
      ACTIVITY_STORED_QUERIES.map(normalizeQueryText),
    );

    const [summary] = await rows<{ search_count: number; last_search_at: Date | null }>(
      "SELECT search_count, last_search_at FROM user_activity_summary WHERE user_id = $1",
      [userId],
    );
    expect(summary?.search_count).toBe(all.length);
    expect(summary?.last_search_at?.toISOString()).toBe(events.at(-1)?.created_at.toISOString());

    expect(fetchSpy).not.toHaveBeenCalled();
    const [usageAfter] = await rows<{ n: number }>("SELECT count(*)::int AS n FROM api_usage", []);
    expect(usageAfter?.n).toBe(usageBefore?.n);
  });

  it("tekrar bastırma: NULL metinli aramalar pencere içinde birleşir; normal sorgu değişmez", async () => {
    const userId = await newConsentedUser();
    const consent = acceptAll();
    await recordCookieDecision(db, { userId, consent, source: "cookie_banner" });
    const t0 = Date.now() - 60 * MINUTE;
    const at = (minutes: number) => new Date(t0 + minutes * MINUTE);
    const record = (query: string, minutes: number) =>
      recordActivity(db, {
        userId,
        cookieConsent: consent,
        event: search(query),
        now: at(minutes),
      });

    expect(await record("0532 123 45 67", 0)).toBe("recorded");
    // Farklı engelli arama, pencere içinde: bilinçli olarak tek olaya iner.
    expect(await record("hamileyim elbise önerisi", 1)).toBe("duplicate");
    // Normal sorgu NULL'la eşleşmez.
    expect(await record("Siyah Elbise", 2)).toBe("recorded");
    expect(await record("siyah  elbise", 3)).toBe("duplicate");
    // Pencere dolunca engelli arama yeniden sayılır.
    expect(await record("password=hunter2", 11)).toBe("recorded");

    expect((await searchRows(userId)).map((e) => e.query_norm)).toEqual([
      null,
      "siyah elbise",
      null,
    ]);
    const [summary] = await rows<{ search_count: number }>(
      "SELECT search_count FROM user_activity_summary WHERE user_id = $1",
      [userId],
    );
    expect(summary?.search_count).toBe(3);
  });

  it("rıza reddi: engelli ya da normal arama hiçbir şey yazmaz", async () => {
    const userId = await newConsentedUser();
    for (const query of ["0532 123 45 67", "siyah elbise"]) {
      expect(
        await recordActivity(db, { userId, cookieConsent: rejectAll(), event: search(query) }),
      ).toBe("no_consent");
      expect(await recordActivity(db, { userId, cookieConsent: null, event: search(query) })).toBe(
        "no_consent",
      );
    }
    expect(await searchRows(userId)).toHaveLength(0);
  });

  it("rıza geri alma: NULL metinli olaylar da silinir", async () => {
    const userId = await newConsentedUser();
    const yes = fromSelection(
      { functional: false, analytics: true, marketing: false },
      new Date(Date.now() - 5_000),
    );
    await recordCookieDecision(db, { userId, consent: yes, source: "cookie_banner" });
    const t0 = Date.now() - 60 * MINUTE;
    await recordActivity(db, {
      userId,
      cookieConsent: yes,
      event: search("chp rozeti"),
      now: new Date(t0),
    });
    await recordActivity(db, {
      userId,
      cookieConsent: yes,
      event: search("siyah elbise"),
      now: new Date(t0 + MINUTE),
    });

    const result = await recordCookieDecision(db, {
      userId,
      consent: fromSelection({ functional: false, analytics: false, marketing: false }, new Date()),
      source: "cookie_banner",
    });
    expect(result.analyticsRevoked).toBe(true);
    expect(result.eventsDeleted).toBe(2);
    expect(await searchRows(userId)).toHaveLength(0);
  });

  it("veri indirme biçimi aynı: engelli arama queryNorm null ile görünür", async () => {
    const userId = await newConsentedUser();
    const consent = acceptAll();
    await recordCookieDecision(db, { userId, consent, source: "cookie_banner" });
    await recordActivity(db, { userId, cookieConsent: consent, event: search("sabıka kaydı", 2) });

    const exported = await exportUserData(db, userId);
    const event = exported.activityEvents.find((e) => e.kind === "search_submitted");
    expect(event).toMatchObject({ kind: "search_submitted", queryNorm: null, resultCount: 2 });
    expect(Object.keys(event ?? {}).sort()).toEqual(
      ["createdAt", "kind", "offerId", "productId", "queryNorm", "resultCount"].sort(),
    );
  });
});
