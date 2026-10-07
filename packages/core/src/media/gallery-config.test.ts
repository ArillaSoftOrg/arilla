import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_DISPLAY_IMAGES, pickImageUrl } from "./gallery-config.ts";

describe("pickImageUrl", () => {
  it("prefers r2_url over source_url over legacy", () => {
    expect(
      pickImageUrl({
        r2Url: "https://media.manicepte.com/products/a.webp",
        sourceUrl: "https://cdn.example/a.jpg",
        legacyUrl: "https://cdn.example/old.jpg",
      }),
    ).toBe("https://media.manicepte.com/products/a.webp");
  });

  it("falls back to source_url when r2_url is null", () => {
    expect(
      pickImageUrl({
        r2Url: null,
        sourceUrl: "https://cdn.example/a.jpg",
        legacyUrl: "https://x/o.jpg",
      }),
    ).toBe("https://cdn.example/a.jpg");
  });

  it("falls back to the legacy primary image, then null (placeholder)", () => {
    expect(pickImageUrl({ legacyUrl: "https://cdn.example/old.jpg" })).toBe(
      "https://cdn.example/old.jpg",
    );
    expect(pickImageUrl({})).toBeNull();
  });

  it("ignores blank and non-http(s) values", () => {
    expect(
      pickImageUrl({
        r2Url: "  ",
        sourceUrl: "javascript:alert(1)",
        legacyUrl: "data:image/png;base64,AAAA",
      }),
    ).toBeNull();
  });
});

describe("gallery limits", () => {
  it("MAX_DISPLAY_IMAGES matches the ingest side (services/ingest/collect/images.py)", () => {
    const python = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../../../../services/ingest/collect/images.py",
      ),
      "utf8",
    );
    const match = /^MAX_DISPLAY_IMAGES\s*=\s*(\d+)/m.exec(python);
    expect(match).not.toBeNull();
    expect(MAX_DISPLAY_IMAGES).toBe(Number(match?.[1]));
  });
});
