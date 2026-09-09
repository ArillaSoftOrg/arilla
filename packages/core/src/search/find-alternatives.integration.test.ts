import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { getTestDb } from "../test-db.ts";
import { findAlternatives } from "./find-alternatives.ts";

describe("findAlternatives() - integration (real seeded Postgres)", () => {
  let db: Database;

  beforeAll(() => {
    db = getTestDb();
  });

  it("returns alternatives ranked by similarity_edge.score, descending", async () => {
    const edgeRow = await db.execute(
      sql`SELECT product_a FROM similarity_edge WHERE kind = 'visual' LIMIT 1`,
    );
    const anchorId = Number(edgeRow.rows[0]?.product_a);
    expect(Number.isNaN(anchorId)).toBe(false);

    const alternatives = await findAlternatives(db, anchorId);

    expect(alternatives.length).toBeGreaterThan(0);
    expect(alternatives.length).toBeLessThanOrEqual(6);
    expect(alternatives.every((alt) => alt.productId !== anchorId)).toBe(true);
    for (let i = 1; i < alternatives.length; i++) {
      const previous = alternatives[i - 1];
      const current = alternatives[i];
      if (previous && current) {
        expect(previous.similarityScore).toBeGreaterThanOrEqual(current.similarityScore);
      }
    }
  });

  it("finds the reverse side of an edge too (product_a = anchor OR product_b = anchor)", async () => {
    const edgeRow = await db.execute(
      sql`SELECT product_a, product_b FROM similarity_edge WHERE kind = 'visual' LIMIT 1`,
    );
    const productA = Number(edgeRow.rows[0]?.product_a);
    const productB = Number(edgeRow.rows[0]?.product_b);

    const alternativesFromB = await findAlternatives(db, productB, { limit: 50 });
    expect(alternativesFromB.some((alt) => alt.productId === productA)).toBe(true);
  });

  it("respects the limit option", async () => {
    const edgeRow = await db.execute(
      sql`SELECT product_a FROM similarity_edge WHERE kind = 'visual'
          GROUP BY product_a HAVING count(*) >= 3 LIMIT 1`,
    );
    const anchorId = Number(edgeRow.rows[0]?.product_a);
    expect(Number.isNaN(anchorId)).toBe(false);

    const alternatives = await findAlternatives(db, anchorId, { limit: 2 });
    expect(alternatives.length).toBeLessThanOrEqual(2);
  });
});
