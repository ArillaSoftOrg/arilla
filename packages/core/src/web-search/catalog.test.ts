import type { Database } from "@arilla/db";
import { describe, expect, it } from "vitest";
import { findCatalogImageCandidates } from "./catalog.ts";
import { attachCatalogImages } from "./merge.ts";
import type { WebProductGroup } from "./types.ts";

const group = (title: string): WebProductGroup => ({
  key: title,
  title,
  brand: "Apple",
  matchKind: "exact",
  offers: [],
  minVerifiedPriceKurus: null,
});

function fakeDb(rows: unknown[], fail = false): Database {
  return {
    execute: async () => {
      if (fail) throw new Error("db down");
      return { rows };
    },
  } as unknown as Database;
}

const rows = [
  {
    title: "iPhone 16 Pro 256 GB",
    color: "Siyah Titanyum",
    brand: "Apple",
    image: "https://cdn.magaza.com/16pro-siyah.jpg",
  },
  {
    title: "iPhone 16 Pro Max 256 GB",
    color: "Siyah Titanyum",
    brand: "Apple",
    image: "https://cdn.magaza.com/16promax-siyah.jpg",
  },
];

describe("findCatalogImageCandidates + attachCatalogImages (gorsel kaynagi A)", () => {
  it("gives the catalog image only to the same product", async () => {
    const groups = [
      group("Apple iPhone 16 Pro 256 GB Siyah Titanyum"),
      group("Apple iPhone 16 Pro 256 GB Doğal Titanyum"),
      group("Apple iPhone 15 Pro 256 GB Siyah Titanyum"),
    ];
    const candidates = await findCatalogImageCandidates(fakeDb(rows), groups);
    const out = attachCatalogImages(groups, candidates);
    expect(out.map((g) => g.imageUrl)).toEqual([
      "https://cdn.magaza.com/16pro-siyah.jpg",
      null,
      null,
    ]);
  });

  it("a database error means no catalog image, never an exception", async () => {
    expect(
      await findCatalogImageCandidates(fakeDb([], true), [group("Apple iPhone 16 Pro")]),
    ).toEqual([]);
  });
});
