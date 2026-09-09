import type { Database } from "@arilla/db";
import { beforeAll, describe, expect, it } from "vitest";
import { getTestDb } from "../test-db.ts";
import { getColorVariants } from "./get-color-variants.ts";

describe("getColorVariants() - integration (real seeded Postgres)", () => {
  let db: Database;

  beforeAll(() => {
    db = getTestDb();
  });

  it("returns the other colors sharing a real model_key group", async () => {
    const variants = await getColorVariants(db, "mdl-0011", 19);
    const ids = variants.map((v) => v.productId).sort();
    expect(ids).toEqual([20, 21]);
    expect(variants.every((v) => v.color !== null)).toBe(true);
  });

  it("returns an empty array for a model_key with no other products", async () => {
    const variants = await getColorVariants(db, "no-such-model-key", 1);
    expect(variants).toEqual([]);
  });
});
