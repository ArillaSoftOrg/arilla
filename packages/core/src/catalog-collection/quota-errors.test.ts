import { describe, expect, it } from "vitest";
import { collectionErrorFrom, remainingQuota, type UsageSnapshot } from "./service.ts";

const wrap = (message: string) => ({ message: "Failed query", cause: { message } });

describe("collectionErrorFrom (karar 0123 kodlari)", () => {
  it.each([
    "collection_quota_daily_requests",
    "collection_quota_monthly_requests",
    "collection_quota_monthly_products",
    "collection_quota_month",
    "collection_quota_interval",
    "collection_products_decrease",
  ])("%s tam kodla eslesir (onek kod yutmaz)", (code) => {
    expect(collectionErrorFrom(wrap(code))?.code).toBe(code);
  });

  it("bilinmeyen kod null doner", () => {
    expect(collectionErrorFrom(wrap("collection_quota_other"))).toBeNull();
  });
});

describe("remainingQuota", () => {
  const usage = (reqDay: number, reqMonth: number, prodMonth: number): UsageSnapshot => ({
    day: { requests: reqDay, products: 0 },
    month: { requests: reqMonth, products: prodMonth },
    dayResetsAt: new Date(0),
    monthResetsAt: new Date(0),
  });
  const limits = {
    dailyMaxRequests: 20000,
    monthlyMaxRequests: 600000,
    monthlyMaxProducts: 5_000_000,
  };

  it("gunluk hak aylik kalani asamaz", () => {
    expect(remainingQuota(limits, usage(100, 599_950, 0))).toEqual({
      requestsToday: 50,
      requestsMonth: 50,
      productsMonth: 5_000_000,
    });
  });

  it("negatif olmaz; sinirsiz kota null", () => {
    expect(remainingQuota(limits, usage(25_000, 0, 6_000_000))).toMatchObject({
      requestsToday: 0,
      productsMonth: 0,
    });
    expect(
      remainingQuota(
        { dailyMaxRequests: null, monthlyMaxRequests: null, monthlyMaxProducts: null },
        usage(1, 1, 1),
      ),
    ).toEqual({ requestsToday: null, requestsMonth: null, productsMonth: null });
  });
});
