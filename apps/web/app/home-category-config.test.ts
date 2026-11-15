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
