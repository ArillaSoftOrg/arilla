import { describe, expect, it } from "vitest";
import { buildGallery, type GalleryRow } from "./get-product-gallery.ts";

const row = (n: string, extra: Partial<GalleryRow> = {}): GalleryRow => ({
  offerId: 7,
  sourceUrl: `https://cdn.example/${n}.jpg`,
  r2Url: null,
  width: null,
  height: null,
  isVariantSpecific: false,
  ...extra,
});

describe("buildGallery", () => {
  it("0 images and no legacy -> none (placeholder)", () => {
    expect(buildGallery([], null)).toEqual({ images: [], source: "none" });
  });

  it("legacy primary_image_url is the single-image fallback", () => {
    const gallery = buildGallery([], "https://cdn.example/old.jpg");
    expect(gallery.source).toBe("legacy");
    expect(gallery.images.map((i) => i.url)).toEqual(["https://cdn.example/old.jpg"]);
    expect(gallery.images[0]?.sourceOfferId).toBeNull();
  });

  it.each([1, 2, 3])("%i gallery rows are all shown, gallery wins over legacy", (count) => {
    const rows = Array.from({ length: count }, (_, i) => row(String(i)));
    const gallery = buildGallery(rows, "https://cdn.example/old.jpg");
    expect(gallery.source).toBe("gallery");
    expect(gallery.images).toHaveLength(count);
  });

  it("never returns more than 3 even if given more rows", () => {
    const rows = Array.from({ length: 6 }, (_, i) => row(String(i)));
    expect(buildGallery(rows, null).images).toHaveLength(3);
  });

  it("uses r2_url instead of source_url when present", () => {
    const gallery = buildGallery(
      [row("a", { r2Url: "https://media.manicepte.com/products/a.webp" })],
      null,
    );
    expect(gallery.images[0]?.url).toBe("https://media.manicepte.com/products/a.webp");
  });

  it("keeps display order and provenance, drops repeated urls", () => {
    const gallery = buildGallery(
      [
        row("a", { offerId: 3 }),
        row("a", { offerId: 3 }),
        row("b", { offerId: 3, isVariantSpecific: true }),
      ],
      null,
    );
    expect(gallery.images.map((i) => i.url)).toEqual([
      "https://cdn.example/a.jpg",
      "https://cdn.example/b.jpg",
    ]);
    expect(gallery.images[1]).toMatchObject({ sourceOfferId: 3, isVariantSpecific: true });
  });

  it("does not invent a variant relation", () => {
    expect(buildGallery([row("a")], null).images[0]?.isVariantSpecific).toBe(false);
  });
});
