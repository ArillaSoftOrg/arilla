import { describe, expect, it } from "vitest";
import { HOME_CATEGORY_OPTIONS, selectHomeCategoryImages } from "./home-category-config.ts";

describe("ana sayfa kategori görsel varyantları", () => {
  it("aynı ziyaret tohumu ve kategori için seçimi sabit tutar", () => {
    for (const category of HOME_CATEGORY_OPTIONS) {
      expect(selectHomeCategoryImages(category, 20261115)).toEqual(
        selectHomeCategoryImages(category, 20261115),
      );
    }
  });

  it("yalnızca ilgili mobil ve desktop havuzlarından seçim yapar", () => {
    for (const category of HOME_CATEGORY_OPTIONS) {
      for (const seed of [0, 1, 17, 2048, 0xffff_ffff]) {
        const selected = selectHomeCategoryImages(category, seed);
        expect(category.mobileImageSrcs).toContain(selected.mobile);
        expect(category.desktopImageSrcs).toContain(selected.desktop);
      }
    }
  });
});

describe("masaüstü hero srcset", () => {
  it("her genişlik varyantı için dosya vardır ve genişlikler artandır", async () => {
    const { existsSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { heroSrcSet, HOME_HERO_WIDTHS } = await import("./home-category-config.ts");
    const set = heroSrcSet("/görsel/desktop/optimized/kaliteli-1920.webp");
    expect(set).toBeDefined();
    const parts = (set as string).split(", ");
    expect(parts).toHaveLength(HOME_HERO_WIDTHS.length);
    for (const part of parts) {
      const [path] = part.split(" ");
      expect(existsSync(fileURLToPath(new URL(`../public${path}`, import.meta.url))), part).toBe(
        true,
      );
    }
    expect([...HOME_HERO_WIDTHS]).toEqual([...HOME_HERO_WIDTHS].sort((a, b) => a - b));
  });

  it("varyantı olmayan görsel tek kaynak kalır; tüm masaüstü görselleri dosya olarak vardır", async () => {
    const { existsSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { heroSrcSet } = await import("./home-category-config.ts");
    expect(heroSrcSet("/görsel/desktop/optimized/moda-luks-vinyet.webp")).toBeUndefined();
    for (const category of HOME_CATEGORY_OPTIONS) {
      for (const src of category.desktopImageSrcs) {
        expect(existsSync(fileURLToPath(new URL(`../public${src}`, import.meta.url))), src).toBe(
          true,
        );
      }
    }
  });
});
