/**
 * Veritabani ve Redis'siz: INSERT ve sayac taklit edilir. Gercek Postgres'le
 * yazilan satirlar `submit-feedback.integration.test.ts` icinde.
 */
import type { Database } from "@arilla/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RedisUnavailableError } from "../redis/client.ts";
import {
  FEEDBACK_MAX_SUBMISSIONS,
  FEEDBACK_WINDOW_SECONDS,
  feedbackRateLimitKey,
} from "./rate-limit.ts";
import { submitFeedback } from "./submit-feedback.ts";

const FIELDS: [string, unknown][] = [
  ["category", "suggestion"],
  ["title", "Karşılaştırma tablosu"],
  ["message", "Ürünleri yan yana karşılaştırabileceğim bir tablo olsun."],
];

function fakeDb(fail?: Error) {
  const rows: Record<string, unknown>[] = [];
  const db = {
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        if (fail) throw fail;
        rows.push(row);
      },
    }),
  } as unknown as Pick<Database, "insert">;
  return { db, rows };
}

function memoryCounter() {
  const counts = new Map<string, number>();
  const calls: [string, number][] = [];
  return {
    calls,
    increment: async (key: string, windowSeconds: number) => {
      calls.push([key, windowSeconds]);
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("feedbackRateLimitKey()", () => {
  it("girisli kullanicida oturumdaki id'yi kullanir", () => {
    expect(feedbackRateLimitKey({ userId: 42, ip: "203.0.113.9" })).toBe("feedback:user:42");
  });

  it("anonimde IP'yi duz yazmaz, ozetler", () => {
    const key = feedbackRateLimitKey({ userId: null, ip: "203.0.113.9" });
    expect(key).toMatch(/^feedback:ip:[0-9a-f]{64}$/);
    expect(key).not.toContain("203.0.113.9");
  });

  it("IP yoksa ortak kovaya duser", () => {
    expect(feedbackRateLimitKey({ userId: null, ip: null })).toBe("feedback:ip:unknown");
  });
});

describe("submitFeedback()", () => {
  it("anonim gonderimi public kaynakla ve user_id olmadan yazar", async () => {
    const { db, rows } = fakeDb();
    const counter = memoryCounter();
    const result = await submitFeedback(
      db,
      { fields: [...FIELDS, ["email", "ada@example.test"]], user: null, ip: "203.0.113.9" },
      counter.increment,
    );
    expect(result).toEqual({ status: "ok" });
    expect(rows).toEqual([
      expect.objectContaining({
        userId: null,
        email: "ada@example.test",
        source: "public",
        priority: null,
      }),
    ]);
    expect(counter.calls[0]?.[1]).toBe(FEEDBACK_WINDOW_SECONDS);
  });

  it("girisli gonderimi oturumdaki kullaniciya ve hesap e-postasina baglar", async () => {
    const { db, rows } = fakeDb();
    const result = await submitFeedback(
      db,
      {
        fields: [...FIELDS, ["email", "baskasi@example.test"]],
        user: { id: 7, email: "hesap@example.test" },
        ip: "203.0.113.9",
      },
      memoryCounter().increment,
    );
    expect(result).toEqual({ status: "ok" });
    expect(rows[0]).toMatchObject({
      userId: 7,
      email: "hesap@example.test",
      source: "early_access",
    });
  });

  it("istemcinin gonderdigi user_id'yi reddeder ve hicbir sey yazmaz", async () => {
    const { db, rows } = fakeDb();
    const counter = memoryCounter();
    const result = await submitFeedback(
      db,
      { fields: [...FIELDS, ["user_id", "1"]], user: null, ip: "203.0.113.9" },
      counter.increment,
    );
    expect(result).toEqual({ status: "invalid", fieldErrors: {}, formError: "malformed" });
    expect(rows).toHaveLength(0);
    expect(counter.calls).toHaveLength(0);
  });

  it(`${FEEDBACK_MAX_SUBMISSIONS} gonderimden sonra oran sinirina takilir`, async () => {
    const { db, rows } = fakeDb();
    const counter = memoryCounter();
    const results = [];
    for (let i = 0; i <= FEEDBACK_MAX_SUBMISSIONS; i++) {
      results.push(
        await submitFeedback(
          db,
          { fields: FIELDS, user: null, ip: "203.0.113.9" },
          counter.increment,
        ),
      );
    }
    expect(results.slice(0, FEEDBACK_MAX_SUBMISSIONS).every((r) => r.status === "ok")).toBe(true);
    expect(results.at(-1)).toEqual({ status: "rate_limited" });
    expect(rows).toHaveLength(FEEDBACK_MAX_SUBMISSIONS);
    // Baska bir IP etkilenmez.
    expect(
      await submitFeedback(
        db,
        { fields: FIELDS, user: null, ip: "198.51.100.1" },
        counter.increment,
      ),
    ).toEqual({ status: "ok" });
  });

  it("Redis yoksa yazmaz (fail-closed) ve ayrinti sizdirmaz", async () => {
    const { db, rows } = fakeDb();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await submitFeedback(db, { fields: FIELDS, user: null, ip: null }, async () => {
      throw new RedisUnavailableError("sayac", { cause: new Error("ECONNREFUSED 10.0.0.1:6379") });
    });
    expect(result).toEqual({ status: "unavailable" });
    expect(rows).toHaveLength(0);
    expect(JSON.stringify(log.mock.calls)).not.toContain("10.0.0.1");
  });

  it("veritabani hatasinin ic ayrintisini ne donuste ne logda sizdirir", async () => {
    const pgError = Object.assign(
      new Error('new row for relation "feedback" violates check constraint "feedback_title_check"'),
      { code: "23514", detail: "Failing row contains (secret-title, ada@example.test)" },
    );
    const { db } = fakeDb(new Error("Failed query: insert into feedback ...", { cause: pgError }));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await submitFeedback(
      db,
      { fields: [...FIELDS, ["email", "ada@example.test"]], user: null, ip: null },
      memoryCounter().increment,
    );
    expect(result).toEqual({ status: "unavailable" });
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain("23514");
    for (const secret of [
      "feedback_title_check",
      "ada@example.test",
      "insert into",
      "Karşılaştırma",
    ]) {
      expect(logged).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });
});
