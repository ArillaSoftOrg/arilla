import type { Database } from "@arilla/db";
import { beforeAll, describe, expect, it } from "vitest";
import { getTestDb } from "../test-db.ts";
import { getSizeOptions } from "./get-size-options.ts";

describe("getSizeOptions() - integration (real seeded Postgres)", () => {
  let db: Database;

  beforeAll(() => {
    db = getTestDb();
  });

  it("marks a size available if in stock on at least one offer (cross-offer disagreement)", async () => {
    const sizes = await getSizeOptions(db, 19);
    const bySize = Object.fromEntries(sizes.map((s) => [s.sizeNorm, s.inStock]));
    expect(bySize.l).toBe(true);
    expect(bySize.m).toBe(true);
    expect(bySize.s).toBe(true);
    expect(bySize.xl).toBe(true);
    expect(bySize.xs).toBe(false);
  });

  it("sorts letter sizes by the fixed rank, not alphabetically", async () => {
    const sizes = await getSizeOptions(db, 19);
    const order = sizes.map((s) => s.sizeNorm);
    expect(order).toEqual(["xs", "s", "m", "l", "xl"]);
  });

  it("returns an empty array for a product with no size variants (e.g. a perfume)", async () => {
    const sizes = await getSizeOptions(db, 4);
    expect(sizes).toEqual([]);
  });
});
