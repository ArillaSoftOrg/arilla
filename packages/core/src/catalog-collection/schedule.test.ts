import { describe, expect, it } from "vitest";
import {
  autoCollectFlagEnabled,
  type CollectionFreshness,
  collectionFreshnessFindings,
  MAX_SCHEDULED_URLS,
  type ScheduleInput,
  scheduleVerdict,
  templateFromRun,
  trendyolTemplateFromUnits,
} from "./schedule.ts";

const NOW = new Date("2026-11-26T10:00:00Z");
const DAY = 86_400_000;
const TEMPLATE = { runId: 3, queries: ["kulaklik"], maxPages: 3, urls: [] };

type Quota = ScheduleInput["status"]["quota"];
const quota = (over: Partial<Quota> = {}): Quota =>
  ({ canStart: true, blockedBy: null, nextAllowedAt: null, ...over }) as Quota;

function input(over: Partial<ScheduleInput> = {}): ScheduleInput {
  return {
    flagEnabled: true,
    status: { quota: quota(), openRun: null },
    template: TEMPLATE,
    now: NOW,
    ...over,
  };
}

describe("scheduleVerdict (karar 0220/0221): kota KAYNAK POLITIKASINDAN", () => {
  it("bayrak, politika kotasi ve sablon tamamsa kosu acilabilir", () => {
    expect(scheduleVerdict(input())).toMatchObject({ due: true, blockedBy: null });
  });

  it("bayrak kapaliyken hicbir kosu acmaz", () => {
    expect(scheduleVerdict(input({ flagEnabled: false })).blockedBy).toBe("flag_off");
  });

  it("kodda gomulu 7 gun / ayda 4 YOK: politika izin veriyorsa ayni gun yeni kosu acilir", () => {
    // Politika: aralik 0, ayda 400, haftada 100 (kullanici beyani 26 Kasim 2026).
    expect(scheduleVerdict(input({ status: { quota: quota(), openRun: null } })).due).toBe(true);
  });

  it.each([
    ["interval", "interval"],
    ["week", "week"],
    ["month", "month"],
    ["daily_requests", "quota"],
    ["disabled", "quota"],
  ] as const)("politika engeli %s -> %s", (blocked, expected) => {
    const v = scheduleVerdict(
      input({
        status: { quota: quota({ canStart: false, blockedBy: blocked }), openRun: null },
      }),
    );
    expect(v).toMatchObject({ due: false, blockedBy: expected });
  });

  it("aralik/hafta engelinde en erken an politikadan; ay doluysa sonraki ay basi", () => {
    const at = new Date(NOW.getTime() + 2 * DAY);
    const week = scheduleVerdict(
      input({
        status: {
          quota: quota({ canStart: false, blockedBy: "week", nextAllowedAt: at }),
          openRun: null,
        },
      }),
    );
    expect(week.nextAllowedAt?.toISOString()).toBe(at.toISOString());
    const month = scheduleVerdict(
      input({ status: { quota: quota({ canStart: false, blockedBy: "month" }), openRun: null } }),
    );
    expect(month.nextAllowedAt?.toISOString()).toBe("2026-12-01T00:00:00.000Z");
  });

  it("acik kosu varsa yeni kosu acmaz (otomatik surdurme yok); sablon yoksa acmaz", () => {
    const v = scheduleVerdict(input({ status: { quota: quota(), openRun: {} as never } }));
    expect(v.blockedBy).toBe("open_run");
    expect(scheduleVerdict(input({ template: null })).blockedBy).toBe("no_template");
  });
});

describe("templateFromRun (Hepsiburada)", () => {
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
      urls: [],
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

describe("trendyolTemplateFromUnits (karar 0221)", () => {
  const product = "https://www.trendyol.com/apple/iphone-16-pro-128gb-col-titanyum-p-857296094";

  it("urun sayfasi kayitli kanonik adresle, liste yolu kokenle; /sr ve kayitsiz urun atlanir", () => {
    expect(
      trendyolTemplateFromUnits(7, [
        { kind: "product_page", unitKey: "857296094", url: product },
        { kind: "product_page", unitKey: "857296094", url: product },
        { kind: "product_page", unitKey: "111", url: null },
        { kind: "listing_page", unitKey: "/apple-cep-telefonu-x-b101470-c103498", url: null },
        { kind: "listing_page", unitKey: "/sr", url: null },
        { kind: "product_page", unitKey: "9", url: "https://www.trendyol.com/sepet" },
      ]),
    ).toEqual({
      runId: 7,
      queries: [],
      maxPages: 1,
      urls: [product, "https://www.trendyol.com/apple-cep-telefonu-x-b101470-c103498"],
    });
  });

  it("adres yoksa sablon yok; ust sinir kosu butcesi", () => {
    expect(trendyolTemplateFromUnits(7, [])).toBeNull();
    const many = Array.from({ length: 600 }, (_, i) => ({
      kind: "product_page",
      unitKey: String(i + 1),
      url: `https://www.trendyol.com/m/u-p-${i + 1}`,
    }));
    expect(trendyolTemplateFromUnits(7, many)?.urls).toHaveLength(MAX_SCHEDULED_URLS);
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
    expect(f?.key).toBe("collection.hepsiburada.freshness");
    expect(f?.evidence).toContain("40 gün önce");
    expect(f?.href).toBe("/yonetim/katalog/toplama");
  });

  it("Trendyol ayni 8 gun sinirini kendi anahtari ve sayfasiyla alir", () => {
    const ok = collectionFreshnessFindings(
      { ...base, source: "trendyol", newestOfferSeenAt: new Date(NOW.getTime() - 7 * DAY) },
      NOW,
    );
    expect(ok[0]).toMatchObject({ key: "collection.trendyol.freshness", severity: "healthy" });
    const [stale] = collectionFreshnessFindings(
      { ...base, source: "trendyol", newestOfferSeenAt: new Date(NOW.getTime() - 9 * DAY) },
      NOW,
    );
    expect(stale).toMatchObject({
      severity: "warning",
      href: "/yonetim/katalog/toplama/trendyol",
    });
  });
});
