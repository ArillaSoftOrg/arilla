/**
 * Migration 0061 / karar 0097: event_id + schema_version. Gercek yerel Postgres;
 * test edilen kod `arilla_app` rolu ile baglanir.
 */
import { randomUUID } from "node:crypto";
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordClick } from "../attribution/record-click.ts";
import { acceptAll, rejectAll } from "../consent/cookie-consent.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { merchantExitEventId, recordActivity } from "./record.ts";

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
let db: Database;
let userId = 0;
let otherUserId = 0;
let productId = 0;
let offerId = 0;
const clickIds: string[] = [];

async function rows<T>(query: string, params: unknown[]): Promise<T[]> {
  return withOwnerClient(async (client) => (await client.query(query, params)).rows as T[]);
}
const consent = () => acceptAll(new Date());

beforeAll(async () => {
  db = getTestDb();
  const offer = (
    await rows<{ id: string; product_id: string }>(
      "SELECT o.id, o.product_id FROM offer o WHERE o.product_id IS NOT NULL ORDER BY o.id LIMIT 1",
      [],
    )
  )[0];
  if (!offer) throw new Error("seed'li offer yok - once `pnpm seed`");
  offerId = Number(offer.id);
  productId = Number(offer.product_id);
  const ids: number[] = [];
  for (const tag of ["a", "b"]) {
    const r = await rows<{ id: string }>(
      "INSERT INTO app_user (email, email_verified_at) VALUES ($1, now()) RETURNING id",
      [`event-id-${tag}-${suffix}@example.test`],
    );
    ids.push(Number(r[0]?.id));
  }
  userId = ids[0] ?? 0;
  otherUserId = ids[1] ?? 0;
});

afterAll(async () => {
  await withOwnerClient(async (client) => {
    await client.query("UPDATE click SET user_id = NULL WHERE user_id = ANY($1)", [
      [userId, otherUserId],
    ]);
    await client.query("DELETE FROM click WHERE id = ANY($1)", [clickIds]);
    await client.query("DELETE FROM app_user WHERE id = ANY($1)", [[userId, otherUserId]]);
  });
});

const events = (uid: number) =>
  rows<{ kind: string; event_id: string | null; schema_version: number }>(
    "SELECT kind, event_id, schema_version FROM user_activity_event WHERE user_id = $1 ORDER BY id",
    [uid],
  );

describe("event_id / schema_version", () => {
  it("new events carry schema_version 2 and a generated event_id", async () => {
    const out = await recordActivity(db, {
      userId,
      cookieConsent: consent(),
      event: { kind: "product_viewed", productId },
    });
    expect(out).toBe("recorded");
    const [row] = await events(userId);
    expect(row?.schema_version).toBe(2);
    expect(row?.event_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("the same caller-supplied event_id is written once, counters not incremented twice", async () => {
    const eventId = randomUUID();
    const first = await recordActivity(db, {
      userId,
      cookieConsent: consent(),
      eventId,
      event: { kind: "search_submitted", query: "kablosuz kulaklik", resultCount: 3 },
    });
    // Farkli sorgu: pencere dedupe'una degil event_id'ye takilmali. (Rakam iceren
    // sorgular kimlik benzeri sayilip query_norm'u NULL yapar; pencere dedupe'u karisir.)
    const second = await recordActivity(db, {
      userId,
      cookieConsent: consent(),
      eventId,
      event: { kind: "search_submitted", query: "baska sorgu", resultCount: 1 },
    });
    expect([first, second]).toEqual(["recorded", "duplicate"]);
    expect((await events(userId)).filter((e) => e.event_id === eventId)).toHaveLength(1);
    const [summary] = await rows<{ search_count: number }>(
      "SELECT search_count FROM user_activity_summary WHERE user_id = $1",
      [userId],
    );
    expect(summary?.search_count).toBe(1);
  });

  it("concurrent writes of the same event_id produce one row", async () => {
    const eventId = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        recordActivity(db, {
          userId,
          cookieConsent: consent(),
          eventId,
          event: { kind: "search_submitted", query: "es zamanli sorgu", resultCount: 1 },
        }),
      ),
    );
    expect(results.filter((r) => r === "recorded")).toHaveLength(1);
    expect((await events(userId)).filter((e) => e.event_id === eventId)).toHaveLength(1);
  });

  it("the same event_id for a different user is independent", async () => {
    const eventId = randomUUID();
    const event = {
      kind: "search_submitted",
      query: "ortak kimlik sorgusu",
      resultCount: 1,
    } as const;
    const a = await recordActivity(db, { userId, cookieConsent: consent(), eventId, event });
    const b = await recordActivity(db, {
      userId: otherUserId,
      cookieConsent: consent(),
      eventId,
      event,
    });
    expect([a, b]).toEqual(["recorded", "recorded"]);
  });

  it("merchant_exit is idempotent per click via a derived event_id", async () => {
    const click = await recordClick(db, {
      offerId,
      sessionId: `event-id-${suffix}`,
      channel: "web",
      userId,
    });
    clickIds.push(click.clickId);
    const input = {
      userId,
      cookieConsent: consent(),
      event: { kind: "merchant_exit", offerId, clickId: click.clickId },
    } as const;
    expect(await recordActivity(db, input)).toBe("recorded");
    expect(await recordActivity(db, input)).toBe("duplicate");
    const derived = merchantExitEventId(click.clickId);
    expect((await events(userId)).filter((e) => e.event_id === derived)).toHaveLength(1);
  });

  it("a malformed event_id is rejected before touching the database", async () => {
    const out = await recordActivity(db, {
      userId,
      cookieConsent: consent(),
      eventId: "not-a-uuid",
      event: { kind: "product_viewed", productId },
    });
    expect(out).toBe("invalid");
  });

  it("consent gates are unchanged: no consent writes nothing, with or without event_id", async () => {
    const before = (await events(userId)).length;
    const out = await recordActivity(db, {
      userId,
      cookieConsent: rejectAll(new Date()),
      eventId: randomUUID(),
      event: { kind: "product_viewed", productId },
    });
    expect(out).toBe("no_consent");
    expect((await events(userId)).length).toBe(before);
  });

  it("legacy rows (version 1, no event_id) stay valid; version 2 without event_id is rejected", async () => {
    await withOwnerClient(async (client) => {
      const insert =
        "INSERT INTO user_activity_event (user_id, kind, product_id) VALUES ($1, 'product_viewed', $2)";
      await client.query(insert, [otherUserId, productId]);
      await client.query(insert, [otherUserId, productId]);
      await expect(
        client.query(
          "INSERT INTO user_activity_event (user_id, kind, product_id, schema_version) VALUES ($1, 'product_viewed', $2, 2)",
          [otherUserId, productId],
        ),
      ).rejects.toThrow(/event_id_required/);
    });
    const legacy = (await events(otherUserId)).filter((e) => e.schema_version === 1);
    expect(legacy.length).toBeGreaterThanOrEqual(2);
    expect(legacy.every((e) => e.event_id === null)).toBe(true);
  });
});
