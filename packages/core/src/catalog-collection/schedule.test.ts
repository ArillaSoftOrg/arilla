import { describe, expect, it } from "vitest";
import {
  autoCollectFlagEnabled,
  type CollectionFreshness,
  collectionFreshnessFindings,
  type ScheduleInput,
  scheduleVerdict,
  templateFromRun,
} from "./schedule.ts";

const NOW = new Date("2026-11-26T10:00:00Z");
const DAY = 86_400_000;
const TEMPLATE = { runId: 3, queries: ["kulaklik"], maxPages: 3 };

function input(over: Partial<ScheduleInput> = {}): ScheduleInput {
  return {
    flagEnabled: true,
    status: { quota: { canStart: true } as ScheduleInput["status"]["quota"], openRun: null },
    lastCountedAt: new Date(NOW.getTime() - 8 * DAY),
    runsThisMonth: 1,
    template: TEMPLATE,
    now: NOW,
    ...over,
  };
}

describe("scheduleVerdict (karar 0220)", () => {
  it("bayrak, 7 gun, ay tavani, kota ve sablon tamamsa kosu acilabilir", () => {
    const v = scheduleVerdict(input());
    expect(v).toMatchObject({ due: true, blockedBy: null, template: TEMPLATE });
  });

  it("bayrak kapaliyken hicbir kosu acmaz", () => {
    expect(scheduleVerdict(input({ flagEnabled: false })).blockedBy).toBe("flag_off");
  });

  it("son kosudan 7 gun gecmeden acmaz; en erken ani bildirir", () => {
    const last = new Date(NOW.getTime() - 6 * DAY);
    const v = scheduleVerdict(input({ lastCountedAt: last }));
    expect(v.due).toBe(false);
    expect(v.blockedBy).toBe("interval");
    expect(v.nextAllowedAt?.toISOString()).toBe(new Date(last.getTime() + 7 * DAY).toISOString());
  });

  it("takvim ayinda 4 kosu yapildiysa sonraki ay basina erteler (DB politikasi gevsek olsa bile)", () => {
    const v = scheduleVerdict(input({ runsThisMonth: 4 }));
    expect(v.blockedBy).toBe("month");
    expect(v.nextAllowedAt?.toISOString()).toBe("2026-12-01T00:00:00.000Z");
  });

  it("acik kosu varsa yeni kosu acmaz (otomatik surdurme yok)", () => {
    const v = scheduleVerdict(input({ status: { ...input().status, openRun: {} as never } }));
    expect(v.blockedBy).toBe("open_run");
  });

  it("kaynak kotasi izin vermiyorsa ya da sablon yoksa acmaz", () => {
    const blocked = input({
      status: { quota: { canStart: false } as ScheduleInput["status"]["quota"], openRun: null },
    });
    expect(scheduleVerdict(blocked).blockedBy).toBe("quota");
    expect(scheduleVerdict(input({ template: null })).blockedBy).toBe("no_template");
  });

  it("hic kosu yoksa ilk kosu da sablonsuz acilamaz (ilk yukleme elle ve kotaya sayilir)", () => {
    const v = scheduleVerdict(input({ lastCountedAt: null, runsThisMonth: 0, template: null }));
    expect(v.blockedBy).toBe("no_template");
  });
});

describe("templateFromRun", () => {
  const run = (over: Record<string, unknown> = {}) => ({
    id: 9,
    status: "completed",
    checkpoint: { queries: [" kulaklik ", "kulaklik", "", "telefon"], done: {} },
    options: { maxPages: 99 },
    ...over,
  });

  it("kapanmis arama kosusunun sorgularini tekillestirir, sayfa tavanini 50'ye kirpar", () => {
    expect(templateFromRun(run())).toEqual({
      runId: 9,
      queries: ["kulaklik", "telefon"],
      maxPages: 50,
    });
  });

  it("acik, birakilmis, kesif ya da sorgusuz kosudan sablon cikmaz", () => {
    expect(templateFromRun(run({ status: "open" }))).toBeNull();
    expect(templateFromRun(run({ status: "released" }))).toBeNull();
    expect(templateFromRun(run({ checkpoint: { mode: "discovery", queries: ["x"] } }))).toBeNull();
    expect(templateFromRun(run({ checkpoint: { queries: [] } }))).toBeNull();
    expect(templateFromRun(run({ checkpoint: null }))).toBeNull();
  });
});

describe("autoCollectFlagEnabled", () => {
  it("yalniz acik 'true' ile acilir; varsayilan kapali", () => {
    expect(autoCollectFlagEnabled({})).toBe(false);
    expect(autoCollectFlagEnabled({ CATALOG_AUTO_COLLECT_ENABLED: "1" })).toBe(false);
    expect(autoCollectFlagEnabled({ CATALOG_AUTO_COLLECT_ENABLED: " TRUE " })).toBe(true);
  });
});

describe("collectionFreshnessFindings", () => {
  const base: CollectionFreshness = {
    source: "hepsiburada",
    enabled: true,
    lastClosedAt: new Date(NOW.getTime() - 3 * DAY),
    lastStatus: "completed",
    lastReason: null,
    newestOfferSeenAt: new Date(NOW.getTime() - 3 * DAY),
    activeOffers: 2017,
  };

  it("teklif yoksa bulgu yok", () => {
    expect(collectionFreshnessFindings({ ...base, activeOffers: 0 }, NOW)).toEqual([]);
  });

  it("sinir icinde saglikli; son kosu yarida kaldiysa bilgi", () => {
    expect(collectionFreshnessFindings(base, NOW)[0]?.severity).toBe("healthy");
    expect(collectionFreshnessFindings({ ...base, lastStatus: "aborted" }, NOW)[0]?.severity).toBe(
      "info",
    );
  });

  it("8 gunu asan teklif uyarisi (uretimdeki 16 Ekim durumu)", () => {
    const [f] = collectionFreshnessFindings(
      { ...base, newestOfferSeenAt: new Date("2026-10-16T12:00:00Z") },
      NOW,
    );
    expect(f?.severity).toBe("warning");
    expect(f?.evidence).toContain("40 gün önce");
    expect(f?.href).toBe("/yonetim/katalog/toplama");
  });
});
