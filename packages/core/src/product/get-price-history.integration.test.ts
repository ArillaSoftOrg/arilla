import type { Database } from "@arilla/db";
import { beforeAll, describe, expect, it } from "vitest";
import { getTestDb } from "../test-db.ts";
import { getPriceHistory } from "./get-price-history.ts";

describe("getPriceHistory() - integration (real seeded Postgres)", () => {
  let db: Database;

  beforeAll(() => {
    db = getTestDb();
  });

  it("returns a chronologically ordered daily price series for a real product", async () => {
    const points = await getPriceHistory(db, 43);
    expect(points.length).toBeGreaterThan(0);
    for (const point of points) {
      expect(point.minPriceKurus).toBeGreaterThan(0);
    }
    const dates = points.map((p) => p.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it("returns an empty array for a product with no offers/price history", async () => {
    const points = await getPriceHistory(db, 999_999_999);
    expect(points).toEqual([]);
  });
});
