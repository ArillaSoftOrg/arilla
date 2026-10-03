import { describe, expect, it } from "vitest";
import { audienceGate, formAvailability } from "./availability.ts";
import {
  consumeFormQuota,
  FORM_ANON_MAX,
  FORM_ANON_SINGLE_DAILY_MAX,
  FORM_USER_MAX,
  formRateLimitKey,
} from "./rate-limit.ts";

const NOW = new Date("2026-10-03T12:00:00Z");
const before = new Date("2026-10-03T11:00:00Z");
const after = new Date("2026-10-03T13:00:00Z");

describe("formAvailability()", () => {
  it("taslak ve kapalı formu açık saymaz", () => {
    expect(formAvailability({ status: "draft", startsAt: null, endsAt: null }, NOW)).toBe("draft");
    expect(formAvailability({ status: "closed", startsAt: null, endsAt: null }, NOW)).toBe(
      "closed",
    );
  });

  it("yayındaki formu zaman aralığına göre değerlendirir", () => {
    expect(formAvailability({ status: "published", startsAt: null, endsAt: null }, NOW)).toBe(
      "open",
    );
    expect(formAvailability({ status: "published", startsAt: before, endsAt: after }, NOW)).toBe(
      "open",
    );
    expect(formAvailability({ status: "published", startsAt: after, endsAt: null }, NOW)).toBe(
      "not_started",
    );
    expect(formAvailability({ status: "published", startsAt: null, endsAt: before }, NOW)).toBe(
      "ended",
    );
    // Bitiş anının kendisi artık kapalıdır.
    expect(formAvailability({ status: "published", startsAt: null, endsAt: NOW }, NOW)).toBe(
      "ended",
    );
  });
});

describe("audienceGate()", () => {
  it("public herkese açıktır", () => {
    expect(audienceGate("public", null, false)).toBe("ok");
  });

  it("authenticated giriş ister", () => {
    expect(audienceGate("authenticated", null, false)).toBe("login_required");
    expect(audienceGate("authenticated", { id: 1 }, false)).toBe("ok");
  });

  it("early_access giriş ve üyelik ister", () => {
    expect(audienceGate("early_access", null, true)).toBe("login_required");
    expect(audienceGate("early_access", { id: 1 }, false)).toBe("early_access_required");
    expect(audienceGate("early_access", { id: 1 }, true)).toBe("ok");
  });
});

describe("form oran sınırı", () => {
  function counter() {
    const counts = new Map<string, number>();
    const fn = async (key: string) => {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    };
    return { fn, counts };
  }

  it("anahtar: girişlide oturumdaki id, anonimde IP özeti (düz IP yok)", () => {
    expect(formRateLimitKey({ formId: 7, userId: 3, ip: "1.2.3.4" })).toBe("forms:user:3:7");
    const anon = formRateLimitKey({ formId: 7, userId: null, ip: "1.2.3.4" });
    expect(anon).toMatch(/^forms:ip:[0-9a-f]{64}:7$/);
    expect(anon).not.toContain("1.2.3.4");
    expect(formRateLimitKey({ formId: 7, userId: null, ip: null })).toBe("forms:ip:unknown:7");
  });

  it("girişli kullanıcı sınırdan sonra durur", async () => {
    const { fn } = counter();
    const input = { formId: 1, userId: 5, ip: null, singleResponse: true };
    for (let i = 0; i < FORM_USER_MAX; i++) expect(await consumeFormQuota(input, fn)).toBe(true);
    expect(await consumeFormQuota(input, fn)).toBe(false);
  });

  it("anonim: çok yanıtlı formda pencere sınırı, tek yanıtlıda ek günlük sınır", async () => {
    const multi = counter();
    const m = { formId: 1, userId: null, ip: "9.9.9.9", singleResponse: false };
    for (let i = 0; i < FORM_ANON_MAX; i++) expect(await consumeFormQuota(m, multi.fn)).toBe(true);
    expect(await consumeFormQuota(m, multi.fn)).toBe(false);

    const single = counter();
    const s = { formId: 2, userId: null, ip: "9.9.9.9", singleResponse: true };
    for (let i = 0; i < FORM_ANON_SINGLE_DAILY_MAX; i++) {
      expect(await consumeFormQuota(s, single.fn)).toBe(true);
    }
    expect(await consumeFormQuota(s, single.fn)).toBe(false);
  });

  it("farklı form ve farklı IP birbirini etkilemez", async () => {
    const { fn } = counter();
    const a = { formId: 1, userId: null, ip: "1.1.1.1", singleResponse: false };
    for (let i = 0; i < FORM_ANON_MAX; i++) await consumeFormQuota(a, fn);
    expect(await consumeFormQuota(a, fn)).toBe(false);
    expect(await consumeFormQuota({ ...a, formId: 2 }, fn)).toBe(true);
    expect(await consumeFormQuota({ ...a, ip: "2.2.2.2" }, fn)).toBe(true);
  });
});
