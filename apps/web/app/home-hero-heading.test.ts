import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HOME_CATEGORY_OPTIONS } from "./home-category-picker-client.tsx";
import { HOME_COPY } from "./home-copy.ts";
import { HomeHeroHeading } from "./home-hero-heading.tsx";

describe("HomeHeroHeading", () => {
  it("kategori adını başlığın içinde açılır liste olarak, soneki yanında gösterir", () => {
    const option = HOME_CATEGORY_OPTIONS[0];
    const html = renderToStaticMarkup(
      createElement(HomeHeroHeading, { value: option.id, onChange: () => {} }),
    );
    expect(html).toMatch(/^<h1[^>]*id="anasayfa-baslik"/);
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain(option.label);
    expect(html).toContain(HOME_COPY.heroTitleSuffix);
    // Tek başlık: içinde başka blok öğe (div) olmamalı.
    expect(html).not.toContain("<div");
  });

  it("her kategori için başlık o kategori adını taşır", () => {
    for (const option of HOME_CATEGORY_OPTIONS) {
      const html = renderToStaticMarkup(
        createElement(HomeHeroHeading, { value: option.id, onChange: () => {} }),
      );
      expect(html).toContain(option.label);
    }
  });
});
