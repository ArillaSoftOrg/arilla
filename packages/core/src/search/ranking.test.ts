import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  balancedScoreExpr,
  MISSING_PERCENTILE_FALLBACK,
  OUT_OF_STOCK_PENALTY,
  relevanceExpr,
} from "./ranking.ts";

describe("ranking constants", () => {
  it("are documented, tunable placeholders (docs/search.md gives no exact numbers)", () => {
    expect(OUT_OF_STOCK_PENALTY).toBe(0.3);
    expect(MISSING_PERCENTILE_FALLBACK).toBe(50);
  });
});

describe("relevanceExpr", () => {
  it("falls back to a constant 1.0 when there is no query text (browse-only)", () => {
    const expr = relevanceExpr(sql`p.title`, undefined);
    expect(expr.queryChunks.length).toBe(1);
  });

  it("uses pg_trgm similarity() against the title when text is present", () => {
    const withText = relevanceExpr(sql`p.title`, "siyah ayakkabı");
    const withoutText = relevanceExpr(sql`p.title`, undefined);
    expect(withText.queryChunks.length).toBeGreaterThan(withoutText.queryChunks.length);
  });

  it("treats blank/whitespace-only text the same as absent text", () => {
    const blank = relevanceExpr(sql`p.title`, "   ");
    const absent = relevanceExpr(sql`p.title`, undefined);
    expect(blank.queryChunks.length).toBe(absent.queryChunks.length);
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
