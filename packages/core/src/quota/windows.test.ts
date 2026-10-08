import { describe, expect, it } from "vitest";
import { QUOTA_POLICY, QUOTA_WINDOWS } from "./policy.ts";
import { quotaKey } from "./redis-windows.ts";
import { quotaPeriod } from "./windows.ts";

/** Istanbul = UTC+3: 2026-10-08 19:30 (persembe). */
const THURSDAY_EVENING = new Date("2026-10-08T16:30:00Z");

describe("politika (tek kaynak)", () => {
  it("hedef limitler", () => {
    expect(QUOTA_POLICY).toEqual({
      search_rights: { hour: 10, day: 30, week: 120, month: 350 },
      chat_message: { hour: 20, day: 60, week: 300, month: 900 },
      realtime_interpretation_user: { hour: 30, day: 100, week: 400, month: 1000 },
      realtime_interpretation_anonymous: { hour: 30, day: 60, week: 200, month: 500 },
    });
  });

  it("her havuzda pencereler kisadan uzuna artan", () => {
    for (const limits of Object.values(QUOTA_POLICY)) {
      const values = QUOTA_WINDOWS.map((window) => limits[window]);
      expect([...values].sort((a, b) => a - b)).toEqual(values);
    }
  });
});

describe("Istanbul takvim pencereleri", () => {
  it("saat: saat basi -> bir sonraki saat basi", () => {
    const period = quotaPeriod("hour", THURSDAY_EVENING);
    expect(period.start.toISOString()).toBe("2026-10-08T16:00:00.000Z");
    expect(period.end.toISOString()).toBe("2026-10-08T17:00:00.000Z");
    expect(period.id).toBe("2026-10-08T19");
  });

  it("gun: Istanbul 00:00 (UTC 21:00)", () => {
    const period = quotaPeriod("day", THURSDAY_EVENING);
    expect(period.start.toISOString()).toBe("2026-10-07T21:00:00.000Z");
    expect(period.end.toISOString()).toBe("2026-10-08T21:00:00.000Z");
    expect(period.id).toBe("2026-10-08");
    // Gece yarisinin bir an oncesi ayni gun, tam gece yarisi yeni gun.
    expect(quotaPeriod("day", new Date("2026-10-08T20:59:59.999Z")).id).toBe("2026-10-08");
    expect(quotaPeriod("day", new Date("2026-10-08T21:00:00.000Z")).id).toBe("2026-10-09");
  });

  it("hafta: pazartesi 00:00 Istanbul (ISO hafta)", () => {
    const period = quotaPeriod("week", THURSDAY_EVENING);
    expect(period.start.toISOString()).toBe("2026-10-04T21:00:00.000Z");
    expect(period.end.toISOString()).toBe("2026-10-11T21:00:00.000Z");
    expect(period.id).toBe("2026-10-05");
    // Pazar 23:59 Istanbul ayni hafta; pazartesi 00:00 yeni hafta.
    expect(quotaPeriod("week", new Date("2026-10-11T20:59:00Z")).id).toBe("2026-10-05");
    expect(quotaPeriod("week", new Date("2026-10-11T21:00:00Z")).id).toBe("2026-10-12");
  });

  it("ay: ayin 1'i 00:00 Istanbul", () => {
    const period = quotaPeriod("month", THURSDAY_EVENING);
    expect(period.start.toISOString()).toBe("2026-09-30T21:00:00.000Z");
    expect(period.end.toISOString()).toBe("2026-10-31T21:00:00.000Z");
    expect(period.id).toBe("2026-10");
  });

  it("yil sonu: ay ve hafta yil sinirini dogru gecer", () => {
    // 2027-01-01 00:30 Istanbul (cuma): hafta pazartesi 2026-12-28'de basladi.
    const newYear = new Date("2026-12-31T21:30:00Z");
    expect(quotaPeriod("month", newYear).id).toBe("2027-01");
    expect(quotaPeriod("week", newYear).id).toBe("2026-12-28");
    expect(quotaPeriod("week", newYear).start.toISOString()).toBe("2026-12-27T21:00:00.000Z");
    expect(quotaPeriod("day", newYear).id).toBe("2027-01-01");
  });

  it("donem bitisi bir sonraki donemin baslangicidir", () => {
    for (const window of QUOTA_WINDOWS) {
      const period = quotaPeriod(window, THURSDAY_EVENING);
      expect(quotaPeriod(window, period.end).start.getTime()).toBe(period.end.getTime());
      expect(quotaPeriod(window, new Date(period.end.getTime() - 1)).id).toBe(period.id);
    }
  });
});

describe("Redis anahtari", () => {
  it("havuz, pencere, donem ve ozne; ham IP icermez", () => {
    expect(quotaKey("chat_message", "week", THURSDAY_EVENING, "user:7")).toBe(
      "quota:chat_message:week:2026-10-05:user:7",
    );
    expect(quotaKey("realtime_interpretation_anonymous", "hour", THURSDAY_EVENING, "ip:ab")).toBe(
      "quota:realtime_interpretation_anonymous:hour:2026-10-08T19:ip:ab",
    );
  });
});
