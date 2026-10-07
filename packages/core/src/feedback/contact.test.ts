/**
 * Veritabani ve Redis'siz: INSERT ve sayac taklit edilir. Gercek Postgres'le
 * yazilan satirlar `contact.integration.test.ts` icinde.
 */
import type { Database } from "@arilla/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RedisUnavailableError } from "../redis/client.ts";
import { CONTACT_LIMITS, submitContact, validateContact } from "./contact.ts";
import { FEEDBACK_MAX_SUBMISSIONS, feedbackRateLimitKey } from "./rate-limit.ts";

const FIELDS: [string, unknown][] = [
  ["name", "Ayşe Yılmaz"],
  ["email", "Ayse@Example.com"],
  ["category", "price_error"],
  ["subject", "Yanlış fiyat"],
  ["message", "Ürün sayfasındaki fiyat mağazadakinden farklı görünüyor."],
];

function without(field: string): [string, unknown][] {
  return FIELDS.filter(([key]) => key !== field);
}

function withValue(field: string, value: unknown): [string, unknown][] {
  return FIELDS.map(([key, current]) => [key, key === field ? value : current]);
}

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
  const keys: string[] = [];
  return {
    keys,
    increment: async (key: string) => {
      keys.push(key);
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("validateContact()", () => {
  it("gecerli formu temizler: e-posta kucuk harf, bosluklar birlesir", () => {
    const result = validateContact(withValue("name", "  Ayşe   Yılmaz "));
    expect(result).toEqual({
      ok: true,
      value: {
        name: "Ayşe Yılmaz",
        email: "ayse@example.com",
        category: "price_error",
        subject: "Yanlış fiyat",
        message: "Ürün sayfasındaki fiyat mağazadakinden farklı görünüyor.",
      },
    });
  });

  it.each(["name", "email", "category", "subject", "message"])("%s zorunlu", (field) => {
    const result = validateContact(without(field));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors[field as "name"]).toBe("required");
  });

  it("gecersiz e-posta ve kategori alan hatasidir", () => {
    const badEmail = validateContact(withValue("email", "ayse@"));
    expect(!badEmail.ok && badEmail.fieldErrors.email).toBe("invalid");
    // Geri bildirim kategorisi iletisimde gecersizdir (tur ile eslesir).
    const badCategory = validateContact(withValue("category", "feature_request"));
    expect(!badCategory.ok && badCategory.fieldErrors.category).toBe("invalid");
  });

  it("uzunluk sinirlari kod noktasi olarak olculur", () => {
    const short = validateContact(withValue("message", "kısa"));
    expect(!short.ok && short.fieldErrors.message).toBe("too_short");
    const long = validateContact(withValue("subject", "ş".repeat(CONTACT_LIMITS.subjectMax + 1)));
    expect(!long.ok && long.fieldErrors.subject).toBe("too_long");
    const oneLetter = validateContact(withValue("name", "A"));
    expect(!oneLetter.ok && oneLetter.fieldErrors.name).toBe("too_short");
  });

  it("bilinmeyen alan (orn. user_id), cift alan ve dosya formu reddeder", () => {
    expect(validateContact([...FIELDS, ["user_id", "7"]])).toMatchObject({
      ok: false,
      formError: "malformed",
    });
    expect(validateContact([...FIELDS, ["name", "İkinci"]])).toMatchObject({
      formError: "malformed",
    });
    expect(validateContact(withValue("message", new Blob(["x"])))).toMatchObject({
      formError: "malformed",
    });
  });

  it("Next'in $ACTION alanlarini yok sayar; asiri buyuk govdeyi reddeder", () => {
    expect(validateContact([...FIELDS, ["$ACTION_ID_abc", ""]]).ok).toBe(true);
    expect(validateContact(withValue("message", "a".repeat(7000)))).toMatchObject({
      formError: "too_large",
    });
  });

  it("kontrol karakterlerini atar, satir sonunu korur", () => {
    const result = validateContact(
      withValue("message", "Merhaba\u0000,\r\nfiyat yanlış görünüyor."),
    );
    expect(result.ok && result.value.message).toBe("Merhaba,\nfiyat yanlış görünüyor.");
  });
});

describe("submitContact()", () => {
  it("anonim gonderim: kind=contact, source=public, konu title'a yazilir", async () => {
    const { db, rows } = fakeDb();
    const counter = memoryCounter();
    const result = await submitContact(
      db,
      { fields: FIELDS, userId: null, ip: "203.0.113.9" },
      counter.increment,
    );
    expect(result).toEqual({ status: "ok" });
    expect(rows).toEqual([
      {
        kind: "contact",
        userId: null,
        name: "Ayşe Yılmaz",
        email: "ayse@example.com",
        category: "price_error",
        title: "Yanlış fiyat",
        message: "Ürün sayfasındaki fiyat mağazadakinden farklı görünüyor.",
        priority: null,
        source: "public",
      },
    ]);
    // Geri bildirimle ayni kota anahtari.
    expect(counter.keys).toEqual([feedbackRateLimitKey({ userId: null, ip: "203.0.113.9" })]);
  });

  it("girisli gonderim: hesap yalnizca oturumdan, source=early_access", async () => {
    const { db, rows } = fakeDb();
    const counter = memoryCounter();
    await submitContact(db, { fields: FIELDS, userId: 42, ip: null }, counter.increment);
    expect(rows[0]).toMatchObject({ userId: 42, source: "early_access", kind: "contact" });
    expect(counter.keys).toEqual(["feedback:user:42"]);
  });

  it("gecersiz formda sayac artmaz ve satir yazilmaz", async () => {
    const { db, rows } = fakeDb();
    const counter = memoryCounter();
    const result = await submitContact(
      db,
      { fields: without("email"), userId: null, ip: "203.0.113.9" },
      counter.increment,
    );
    expect(result).toMatchObject({ status: "invalid", fieldErrors: { email: "required" } });
    expect(counter.keys).toEqual([]);
    expect(rows).toEqual([]);
  });

  it("kota dolunca rate_limited ve satir yazilmaz", async () => {
    const { db, rows } = fakeDb();
    const counter = memoryCounter();
    const input = { fields: FIELDS, userId: null, ip: "203.0.113.9" };
    for (let i = 0; i < FEEDBACK_MAX_SUBMISSIONS; i++) {
      expect(await submitContact(db, input, counter.increment)).toEqual({ status: "ok" });
    }
    expect(await submitContact(db, input, counter.increment)).toEqual({ status: "rate_limited" });
    expect(rows).toHaveLength(FEEDBACK_MAX_SUBMISSIONS);
  });

  it("Redis yoksa yazilmaz (fail-closed); log icerik tasimaz", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, rows } = fakeDb();
    const result = await submitContact(db, { fields: FIELDS, userId: null, ip: null }, async () => {
      throw new RedisUnavailableError("incr");
    });
    expect(result).toEqual({ status: "unavailable" });
    expect(rows).toEqual([]);
    expect(error.mock.calls.flat().join(" ")).not.toMatch(/ayse|Ayşe|fiyat/i);
  });

  it("INSERT hatasinda yalnizca hata kodu loglanir", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = Object.assign(new Error("ayse@example.com violates check"), { code: "23514" });
    const { db } = fakeDb(failure);
    const counter = memoryCounter();
    const result = await submitContact(
      db,
      { fields: FIELDS, userId: null, ip: null },
      counter.increment,
    );
    expect(result).toEqual({ status: "unavailable" });
    const logged = error.mock.calls.flat().join(" ");
    expect(logged).toContain("23514");
    expect(logged).not.toContain("ayse@example.com");
  });
});
