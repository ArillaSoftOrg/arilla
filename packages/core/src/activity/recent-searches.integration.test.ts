/**
 * Ana sayfa "Alışverişe devam et" verisi: rızalı `search_submitted` olaylarının
 * kullanıcıya özel, tekilleştirilmiş, en yeni önce listesi. Gerçek Postgres
 * (yerel); test edilen kod `arilla_app` rolüyle bağlanır.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signInWithIdentity } from "../auth/identity-sign-in.ts";
import { recordCookieDecision } from "../consent/account-consent.ts";
import { acceptAll, rejectAll } from "../consent/cookie-consent.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { listRecentSearches } from "./recent-searches.ts";
import { recordActivity, SEARCH_DEDUPE_MS } from "./record.ts";

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const createdUsers: number[] = [];
let db: Database;

async function newUser(tag: string): Promise<number> {
  const result = await signInWithIdentity(db, {
    provider: "phone",
    subject: `+90555${suffix.slice(-7)}${tag}`,
    email: null,
    emailVerified: false,
    displayName: null,
    ip: "203.0.113.11",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0 Safari/537.36",
    context: { deviceClass: "desktop", browserFamily: "chrome", countryCode: "TR" },
  });
  createdUsers.push(result.user.id);
  return result.user.id;
}

async function search(userId: number, query: string, at: Date) {
  return recordActivity(db, {
    userId,
    cookieConsent: acceptAll(),
    event: { kind: "search_submitted", query, resultCount: 5 },
    now: at,
  });
}

const T0 = new Date("2026-03-01T10:00:00.000Z");
const later = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

beforeAll(() => {
  db = getTestDb();
});

afterAll(async () => {
  if (createdUsers.length === 0) return;
  await withOwnerClient(async (client) => {
    await client.query("DELETE FROM app_user WHERE id = ANY($1)", [createdUsers]);
  });
});

describe("listRecentSearches", () => {
  it("geçmiş yoksa boş döner", async () => {
    const userId = await newUser("1");
    expect(await listRecentSearches(db, userId)).toEqual([]);
  });

  it("en yeni önce; aynı sorgu tekilleşir ve en son zaman esas alınır", async () => {
    const userId = await newUser("2");
    await recordCookieDecision(db, { userId, consent: acceptAll(), source: "cookie_banner" });
    await search(userId, "beyaz sneaker", later(0));
    await search(userId, "bel çantası", later(60));
    // Tekrar bastırma penceresi geçtikten sonra aynı sorgu yeniden kaydedilir.
    expect(SEARCH_DEDUPE_MS).toBeLessThan(120 * 60_000);
    await search(userId, "  Beyaz   SNEAKER ", later(120));

    const recent = await listRecentSearches(db, userId);
    expect(recent.map((r) => r.queryNorm)).toEqual(["beyaz sneaker", "bel cantasi"]);
    expect(recent[0]?.searchedAt.getTime()).toBe(later(120).getTime());
  });

  it("başka kullanıcının aramaları görünmez", async () => {
    const a = await newUser("3");
    const b = await newUser("4");
    await recordCookieDecision(db, { userId: a, consent: acceptAll(), source: "cookie_banner" });
    await search(a, "masa lambasi", later(0));
    expect(await listRecentSearches(db, b)).toEqual([]);
    expect((await listRecentSearches(db, a)).map((r) => r.queryNorm)).toEqual(["masa lambasi"]);
  });

  it("analitik rızası yoksa hiçbir şey yazılmaz, liste boş kalır", async () => {
    const userId = await newUser("5");
    const outcome = await recordActivity(db, {
      userId,
      cookieConsent: rejectAll(),
      event: { kind: "search_submitted", query: "çalışma koltuğu", resultCount: 3 },
    });
    expect(outcome).toBe("no_consent");
    expect(await listRecentSearches(db, userId)).toEqual([]);
  });

  it("sorgusu silinmiş (NULL) satırlar ve ürün/çıkış olayları listelenmez", async () => {
    const userId = await newUser("6");
    await recordCookieDecision(db, { userId, consent: acceptAll(), source: "cookie_banner" });
    await search(userId, "oversize hoodie", later(0));
    await search(userId, "eski sorgu", later(30));
    await withOwnerClient(async (client) => {
      await client.query(
        "UPDATE user_activity_event SET query_norm = NULL WHERE user_id = $1 AND query_norm = 'eski sorgu'",
        [userId],
      );
    });
    expect((await listRecentSearches(db, userId)).map((r) => r.queryNorm)).toEqual([
      "oversize hoodie",
    ]);
  });

  it("limit uygulanır", async () => {
    const userId = await newUser("7");
    await recordCookieDecision(db, { userId, consent: acceptAll(), source: "cookie_banner" });
    for (let i = 0; i < 5; i++) await search(userId, `sorgu ${i}`, later(i * 60));
    const recent = await listRecentSearches(db, userId, 3);
    expect(recent.map((r) => r.queryNorm)).toEqual(["sorgu 4", "sorgu 3", "sorgu 2"]);
  });
});
