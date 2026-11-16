import type { DiscoveryItem } from "@arilla/ui";
import { describe, expect, it } from "vitest";
import { dedupeDiscoveryItems } from "./dedupe-discovery.ts";

const item = (id: string): DiscoveryItem => ({
  id,
  title: id,
  imageUrl: `https://example.test/${id}.jpg`,
  imageAlt: id,
});

describe("dedupeDiscoveryItems", () => {
  it("aynı ürünü iki listede de tek tutar; seçilmiş liste önceliklidir", () => {
    const result = dedupeDiscoveryItems(
      [item("product-1"), item("product-2")],
      [item("product-2"), item("product-3")],
    );
    expect(result.curated.map((i) => i.id)).toEqual(["product-1", "product-2"]);
    expect(result.organic.map((i) => i.id)).toEqual(["product-3"]);
  });

  it("aynı listedeki tekrarı ilk görülene indirir ve sırayı korur", () => {
    const result = dedupeDiscoveryItems([item("a"), item("b"), item("a")], []);
    expect(result.curated.map((i) => i.id)).toEqual(["a", "b"]);
  });
});
