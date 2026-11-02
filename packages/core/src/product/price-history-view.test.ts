import { describe, expect, it } from "vitest";
import {
  availableRanges,
  buildHistoryView,
  defaultRange,
  findGaps,
  istanbulToday,
  yDomain,
} from "./price-history-view.ts";

const obs = (date: string, priceMinor: number) => ({ date, priceMinor });

describe("buildHistoryView", () => {
  it("two observations: tiny change keeps a small percent, no average", () => {
    const view = buildHistoryView(
      [obs("2026-10-15", 1099), obs("2026-10-28", 1102)],
      "30d",
      "2026-10-28",
    );
    expect(view.points).toHaveLength(2);
    expect(view.change?.amountMinor).toBe(3);
    expect(view.change?.direction).toBe("up");
    expect(view.change?.percent).toBeCloseTo(0.273, 2);
    expect(view.average).toBeNull();
    expect(view.min?.priceMinor).toBe(1099);
    expect(view.max?.date).toBe("2026-10-28");
  });

  it("a single observation has no change", () => {
    const view = buildHistoryView([obs("2026-10-28", 1099)], "30d", "2026-10-28");
    expect(view.change).toBeNull();
    expect(view.min?.priceMinor).toBe(1099);
  });

  it("empty series", () => {
    const view = buildHistoryView([], "90d", "2026-10-28");
    expect(view.points).toEqual([]);
    expect(view.min).toBeNull();
    expect(view.daysSinceLast).toBeNull();
    expect(view.stale).toBe(false);
  });

  it("13 days of history under a 90d window reports uncovered days", () => {
    const series = [obs("2026-10-15", 1099), obs("2026-10-28", 1102)];
    expect(buildHistoryView(series, "90d", "2026-10-28").uncoveredDays).toBe(77);
    expect(buildHistoryView(series, "all", "2026-10-28").uncoveredDays).toBe(0);
    expect(buildHistoryView(series, "7d", "2026-10-28").uncoveredDays).toBe(0);
  });

  it("filters by window and averages 3+ observations", () => {
    const series = [
      obs("2026-08-01", 5000),
      obs("2026-10-20", 1000),
      obs("2026-10-24", 2000),
      obs("2026-10-28", 3000),
    ];
    const view = buildHistoryView(series, "30d", "2026-10-28");
    expect(view.points.map((p) => p.date)).toEqual(["2026-10-20", "2026-10-24", "2026-10-28"]);
    expect(view.average).toBe(2000);
    expect(view.change?.direction).toBe("up");
    expect(buildHistoryView(series, "all", "2026-10-28").max?.priceMinor).toBe(5000);
  });

  it("flags a stale last observation", () => {
    const view = buildHistoryView(
      [obs("2026-10-10", 1000), obs("2026-10-15", 1000)],
      "30d",
      "2026-10-28",
    );
    expect(view.daysSinceLast).toBe(13);
    expect(view.stale).toBe(true);
    expect(view.change?.direction).toBe("flat");
  });
});

describe("gaps and ranges", () => {
  it("detects a long gap between observations", () => {
    const gaps = findGaps([
      obs("2026-10-01", 1),
      obs("2026-10-02", 1),
      obs("2026-10-03", 1),
      obs("2026-10-20", 1),
    ]);
    expect(gaps).toEqual([{ from: "2026-10-03", to: "2026-10-20", days: 17 }]);
  });

  it("default range covers the first observation, capped at 90d", () => {
    expect(defaultRange([obs("2026-10-25", 1)], "2026-10-28")).toBe("7d");
    expect(defaultRange([obs("2026-10-15", 1)], "2026-10-28")).toBe("30d");
    expect(defaultRange([obs("2025-01-01", 1)], "2026-10-28")).toBe("90d");
  });

  it("hides ranges beyond the fetched horizon", () => {
    expect(availableRanges(90).map((r) => r.key)).toEqual(["7d", "30d", "90d", "all"]);
  });

  it("istanbulToday uses the Turkish calendar day", () => {
    expect(istanbulToday(new Date("2026-10-27T22:30:00Z"))).toBe("2026-10-28");
  });
});

describe("yDomain", () => {
  it("keeps tiny moves visually small (at least 10% span)", () => {
    const [lo, hi] = yDomain(1099, 1102);
    expect(hi - lo).toBeGreaterThanOrEqual(110);
    expect(lo).toBeLessThan(1099);
    expect(hi).toBeGreaterThan(1102);
  });

  it("pads large moves slightly and never goes below zero", () => {
    const [lo, hi] = yDomain(1000, 5000);
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeGreaterThan(5000);
    expect(yDomain(10, 20)[0]).toBe(0);
  });
});
