import { ProductCard } from "@arilla/ui";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProductGalleryClient } from "./product-gallery-client.tsx";
import { clampIndex, mainImageAlt, nextIndex, thumbLabel } from "./product-gallery-state.ts";

const img = (n: number) => ({ url: `https://cdn.example/${n}.jpg`, width: 800, height: 800 });
const html = (count: number) =>
  renderToStaticMarkup(
    createElement(ProductGalleryClient, {
      title: "Defne Elbise",
      images: Array.from({ length: count }, (_, i) => img(i)),
    }),
  );
const imgTags = (markup: string) => markup.match(/<img /g)?.length ?? 0;
const buttons = (markup: string) => markup.match(/<button /g)?.length ?? 0;

describe("ProductGalleryClient markup", () => {
  it("0 images renders the placeholder and no <img>", () => {
    const markup = html(0);
    expect(imgTags(markup)).toBe(0);
    expect(markup).toContain('aria-hidden="true"');
  });

  it("1 image keeps today's look: one <img>, no thumbnails, plain product alt", () => {
    const markup = html(1);
    expect(imgTags(markup)).toBe(1);
    expect(buttons(markup)).toBe(0);
    expect(markup).toContain('alt="Defne Elbise"');
    expect(markup).toContain('loading="eager"');
  });

  it.each([2, 3])("%i images render a main image plus that many thumbnails", (count) => {
    const markup = html(count);
    expect(buttons(markup)).toBe(count);
    expect(imgTags(markup)).toBe(count + 1);
    expect(markup).toContain(`alt="Defne Elbise – görsel 1 / ${count}"`);
  });

  it("first thumbnail is selected, others are out of the tab order (roving tabindex)", () => {
    const markup = html(3);
    expect(markup.match(/aria-pressed="true"/g)?.length).toBe(1);
    expect(markup.match(/tabindex="0"/g)?.length).toBe(1);
    expect(markup.match(/tabindex="-1"/g)?.length).toBe(2);
  });

  it("thumbnails are labelled for assistive tech and their images are decorative", () => {
    const markup = html(2);
    expect(markup).toContain('aria-label="Defne Elbise: görsel 2 / 2"');
    expect(markup).toContain('alt=""');
  });

  it("main image reserves space (width/height) so selection does not shift layout", () => {
    expect(html(3)).toContain('width="800"');
  });

  it("the first image is high priority, thumbnails after it are lazy", () => {
    const markup = html(3);
    expect(markup).toContain('fetchPriority="high"');
    expect(markup.match(/loading="lazy"/g)?.length).toBe(2);
  });
});

describe("gallery selection state", () => {
  it("clamps the selected index into range", () => {
    expect(clampIndex(5, 3)).toBe(2);
    expect(clampIndex(-1, 3)).toBe(0);
    expect(clampIndex(0, 0)).toBe(0);
  });

  it("arrow keys move selection and wrap around", () => {
    expect(nextIndex(0, "ArrowRight", 3)).toBe(1);
    expect(nextIndex(2, "ArrowRight", 3)).toBe(0);
    expect(nextIndex(0, "ArrowLeft", 3)).toBe(2);
    expect(nextIndex(1, "Home", 3)).toBe(0);
    expect(nextIndex(0, "End", 3)).toBe(2);
  });

  it("ignores unrelated keys and single-image galleries", () => {
    expect(nextIndex(0, "Tab", 3)).toBeNull();
    expect(nextIndex(0, "ArrowRight", 1)).toBeNull();
  });

  it("alt texts follow the selection", () => {
    expect(mainImageAlt("Elbise", 1, 3)).toBe("Elbise – görsel 2 / 3");
    expect(mainImageAlt("Elbise", 0, 1)).toBe("Elbise");
    expect(thumbLabel("Elbise", 2, 3)).toBe("Elbise: görsel 3 / 3");
  });
});

describe("listing card loads only one image", () => {
  it("ProductCard renders exactly one <img> (the primary), never a gallery", () => {
    const markup = renderToStaticMarkup(
      createElement(ProductCard, {
        href: "/urun/x",
        title: "Elbise",
        imageUrl: "https://cdn.example/primary.jpg",
      } as never),
    );
    expect(imgTags(markup)).toBe(1);
  });
});
