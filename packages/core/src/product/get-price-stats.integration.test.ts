import type { Database } from "@arilla/db";
import { beforeAll, describe, expect, it } from "vitest";
import { getTestDb } from "../test-db.ts";
import { getPriceStats } from "./get-price-stats.ts";

describe("getPriceStats() - integration (real seeded Postgres)", () => {
  let db: Database;

  beforeAll(() => {
    db = getTestDb();
  });

  it("returns the inflated + lowest-90d stats for a known product", async () => {
    const stats = await getPriceStats(db, 43);
    expect(stats).not.toBeNull();
    expect(stats?.currentPercentile).toBe(0);
    expect(stats?.listPriceInflated).toBe(true);
    expect(stats?.dropCount90d).toBeGreaterThan(0);
  });

  it("returns null for a product with no stats row", async () => {
    const stats = await getPriceStats(db, 999_999_999);
    expect(stats).toBeNull();
  });
});
