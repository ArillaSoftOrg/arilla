import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  balancedScoreExpr,
  MISSING_PERCENTILE_FALLBACK,
  OUT_OF_STOCK_PENALTY,
} from "./ranking.ts";

describe("ranking constants", () => {
  it("are documented, tunable placeholders (docs/search.md gives no exact numbers)", () => {
    expect(OUT_OF_STOCK_PENALTY).toBe(0.3);
    expect(MISSING_PERCENTILE_FALLBACK).toBe(50);
  });
});

describe("balancedScoreExpr", () => {
  it("builds a single composite SQL fragment from the four factors", () => {
    const expr = balancedScoreExpr(
      sql`1.0`,
      sql`bo.trust_score`,
      sql`bo.in_stock`,
      sql`pps.current_percentile`,
    );
    expect(expr.queryChunks.length).toBeGreaterThan(0);
  });
});
