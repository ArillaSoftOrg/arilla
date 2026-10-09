import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb } from "../test-db.ts";
import { findAlternatives } from "./find-alternatives.ts";
import { createSimilarityFixture, type SimilarityFixture } from "./similarity-test-fixture.ts";

describe("findAlternatives() - integration (gercek Postgres, kendi benzerlik fixture'i)", () => {
  let db: Database;
  let fixture: SimilarityFixture;

  beforeAll(async () => {
    db = getTestDb();
    fixture = await createSimilarityFixture("alternatives");
  });

  afterAll(async () => {
    await fixture.cleanup();
  });

  it("returns alternatives ranked by similarity_edge.score, descending", async () => {
    const alternatives = await findAlternatives(db, fixture.anchorId);

    expect(alternatives.length).toBe(fixture.alternativeIds.length);
    expect(alternatives.length).toBeLessThanOrEqual(6);
    expect(alternatives.every((alt) => alt.productId !== fixture.anchorId)).toBe(true);
    expect(alternatives.map((alt) => alt.productId)).toEqual(fixture.alternativeIds);
    for (let i = 1; i < alternatives.length; i++) {
      const previous = alternatives[i - 1];
      const current = alternatives[i];
      if (previous && current) {
        expect(previous.similarityScore).toBeGreaterThanOrEqual(current.similarityScore);
      }
    }
  });

  it("finds the reverse side of an edge too (product_a = anchor OR product_b = anchor)", async () => {
    // Kenar yalnizca (capa, alternatif) yonunde yazildi; alternatiften aranir.
    const [firstAlternative] = fixture.alternativeIds;
    const alternativesFromB = await findAlternatives(db, firstAlternative as number, { limit: 50 });
    expect(alternativesFromB.some((alt) => alt.productId === fixture.anchorId)).toBe(true);
  });

  it("respects the limit option", async () => {
    expect(fixture.alternativeIds.length).toBeGreaterThanOrEqual(3);
    const alternatives = await findAlternatives(db, fixture.anchorId, { limit: 2 });
    expect(alternatives.map((alt) => alt.productId)).toEqual(fixture.alternativeIds.slice(0, 2));
  });
});
