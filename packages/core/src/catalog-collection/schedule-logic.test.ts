import { describe, expect, it } from "vitest";
import { collectionScheduleFindings } from "../admin/collection-schedule-findings.ts";
import {
  isFailedOutcome,
  MAX_SCHEDULE_TARGETS,
  normalizeScheduleTargets,
  outcomeForStop,
  paceDelayMs,
  RECHECK_MS,
  type ScheduleInputs,
  scheduleDecision,
} from "./schedule-logic.ts";
import {
  isCollectibleTrendyolUrl,
  parseToExtensionMessage,
  RELAY_CHANNEL,
} from "./trendyol-relay.ts";

const NOW = new Date("2026-11-26T10:00:00Z");
const base: ScheduleInputs = {
  flagEnabled: true,
  scheduleEnabled: true,
  sourceEnabled: true,
  targetCount: 3,
  quota: { canStart: true, blockedBy: null, nextAllowedAt: null },
  openRun: null,
};

describe("zamanlama karari (karar 0221): kota sunucudan, asla gevsetilmez", () => {
  it("her sey acik ve kota izinli: baslat", () => {
    expect(scheduleDecision(base, NOW)).toEqual({ action: "start" });
  });

  it.each([
    [{ flagEnabled: false }, "flag_off"],
    [{ scheduleEnabled: false }, "schedule_off"],
    [{ sourceEnabled: false }, "source_disabled"],
    [{ targetCount: 0 }, "no_targets"],
  ] as const)("%o kapali: bekle (%s), 6 saat sonra yokla", (over, reason) => {
    const d = scheduleDecision({ ...base, ...over }, NOW);
    expect(d).toEqual({
      action: "wait",
      reason,
      nextCheckAt: new Date(NOW.getTime() + RECHECK_MS),
    });
  });

  it("7 gun dolmadi: kotanin verdigi zamana kadar bekle", () => {
    const at = new Date("2026-11-30T08:00:00Z");
    expect(
      scheduleDecision(
        { ...base, quota: { canStart: false, blockedBy: "interval", nextAllowedAt: at } },
        NOW,
      ),
    ).toEqual({ action: "wait", reason: "interval", nextCheckAt: at });
  });

  it("ayda 4 doldu: sonraki ayin basinda yokla (ilk yukleme dahil sayilir)", () => {
    const d = scheduleDecision(
      { ...base, quota: { canStart: false, blockedBy: "month", nextAllowedAt: null } },
      NOW,
    );
    expect(d).toMatchObject({ action: "wait", reason: "month" });
    if (d.action === "wait") expect(d.nextCheckAt.toISOString()).toBe("2026-12-01T00:05:00.000Z");
  });

  it("hacim kotasi ya da bilinmeyen engel: baslatmaz", () => {
    expect(
      scheduleDecision(
        { ...base, quota: { canStart: false, blockedBy: "daily_requests", nextAllowedAt: null } },
        NOW,
      ),
    ).toMatchObject({ action: "wait", reason: "volume" });
  });

  it("acik koşu: zamanlanmissa yarim kalmistir (kapatilir), elle acilmissa dokunulmaz", () => {
    expect(scheduleDecision({ ...base, openRun: { id: 9, scheduled: true } }, NOW)).toEqual({
      action: "interrupted",
      runId: 9,
    });
    expect(scheduleDecision({ ...base, openRun: { id: 9, scheduled: false } }, NOW)).toMatchObject({
      action: "wait",
      reason: "open_run",
    });
  });
});

describe("hiz ve hedef listesi", () => {
  it("bekleme en az pace, ustune en cok %50; sinirlar zorlanir", () => {
    expect(paceDelayMs(45, 0)).toBe(45_000);
    expect(paceDelayMs(45, 1)).toBe(67_500);
    expect(paceDelayMs(1, 0)).toBe(20_000);
    expect(paceDelayMs(10_000, 0)).toBe(600_000);
    expect(paceDelayMs(45, 7)).toBe(67_500);
  });

  it("yalniz toplanabilir Trendyol adresleri; yinelenen/bos atilir; en cok 500", () => {
    const r = normalizeScheduleTargets(
      [
        "https://www.trendyol.com/apple/iphone-16-pro-128gb-col-titanyum-p-857296094",
        "https://www.trendyol.com/apple/iphone-16-pro-128gb-col-titanyum-p-857296094",
        "",
        "https://www.trendyol.com/apple-cep-telefonu-x-b101470-c103498",
        "https://www.trendyol.com/hesabim/siparislerim",
        "https://example.com/x-p-1",
        42,
      ],
      isCollectibleTrendyolUrl,
    );
    expect(r).toEqual({
      urls: [
        "https://www.trendyol.com/apple/iphone-16-pro-128gb-col-titanyum-p-857296094",
        "https://www.trendyol.com/apple-cep-telefonu-x-b101470-c103498",
      ],
      invalid: 3,
      overflow: 0,
    });
    const many = Array.from({ length: 510 }, (_, i) => `https://www.trendyol.com/m/u-p-${i + 1}`);
    const capped = normalizeScheduleTargets(many.join("\n"), isCollectibleTrendyolUrl);
    expect(capped.urls).toHaveLength(MAX_SCHEDULE_TARGETS);
    expect(capped.overflow).toBe(10);
  });

  it("durma -> sonuc; basarisiz sonuclar bulgu uretir", () => {
    expect(outcomeForStop(null)).toBe("completed");
    expect(outcomeForStop("blocked")).toBe("blocked");
    expect(outcomeForStop("budget")).toBe("budget");
    expect(isFailedOutcome("blocked")).toBe(true);
    expect(isFailedOutcome("interrupted")).toBe(true);
    expect(isFailedOutcome("budget")).toBe(false);
    expect(isFailedOutcome(null)).toBe(false);
  });
});

describe("eklenti mesajlari: gezinme yalniz toplanabilir adrese", () => {
  const msg = (data: Record<string, unknown>) =>
    parseToExtensionMessage({ channel: RELAY_CHANNEL, ...data });

  it("urun/liste adresi kabul; hesap, baska alan adi, gecersiz kosu reddedilir", () => {
    const url = "https://www.trendyol.com/adidas/samba-og-p-813659620";
    expect(msg({ type: "navigate", runId: 3, url })).toEqual({
      channel: RELAY_CHANNEL,
      type: "navigate",
      runId: 3,
      url,
    });
    expect(msg({ type: "navigate", runId: 3, url: "https://www.trendyol.com/sepet" })).toBeNull();
    expect(msg({ type: "navigate", runId: 3, url: "https://evil.example/x-p-1" })).toBeNull();
    expect(msg({ type: "navigate", runId: 0, url })).toBeNull();
    expect(msg({ type: "finish" })).toEqual({ channel: RELAY_CHANNEL, type: "finish" });
    expect(msg({ type: "schedule_hint", nextCheckAt: "yarin" })).toBeNull();
    expect(msg({ type: "schedule_hint", nextCheckAt: "2026-12-01T00:00:00Z" })).toEqual({
      channel: RELAY_CHANNEL,
      type: "schedule_hint",
      nextCheckAt: "2026-12-01T00:00:00.000Z",
    });
  });
});

describe("zamanlama bulgulari", () => {
  const item = {
    source: "trendyol",
    active: true,
    lastOutcome: null,
    lastErrorCode: null,
    lastFinishedAt: null,
    dueAt: null,
    blocked: false,
  } as const;

  it("son koşu engelle durdu: uyari", () => {
    const f = collectionScheduleFindings(
      [
        {
          ...item,
          lastOutcome: "blocked",
          lastErrorCode: "structure_missing",
          lastFinishedAt: new Date("2026-11-25T10:00:00Z"),
          dueAt: new Date("2026-12-02T10:00:00Z"),
        },
      ],
      NOW,
    );
    expect(f.map((x) => [x.key, x.severity])).toEqual([
      ["collection.schedule_failed.trendyol", "warning"],
    ]);
  });

  it("zamani 2 gunden fazla gecti ve koşu yok: gecikme; ay dolmussa ya da kapaliysa yok", () => {
    const late = { ...item, dueAt: new Date("2026-11-22T00:00:00Z") };
    expect(collectionScheduleFindings([late], NOW).map((x) => x.key)).toEqual([
      "collection.schedule_overdue.trendyol",
    ]);
    expect(collectionScheduleFindings([{ ...late, blocked: true }], NOW)).toEqual([]);
    expect(collectionScheduleFindings([{ ...late, active: false }], NOW)).toEqual([]);
    expect(
      collectionScheduleFindings([{ ...late, dueAt: new Date("2026-11-25T00:00:00Z") }], NOW),
    ).toEqual([]);
  });
});
