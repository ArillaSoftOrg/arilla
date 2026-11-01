// @vitest-environment jsdom
import { ProductImage } from "@arilla/ui";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Karar 0166: varyant yuklenemezse tarayicida katalogdaki orijinal URL'ye duser.
 * `onError` jsdom'da elle tetiklenir (gercek ag yok).
 */
const HB = "https://productimages.hepsiburada.net/s/462/222-222/110000498569710.jpg";
const AE = "https://ae-pic-a1.aliexpress-media.com/kf/S5932c4f0aa2249daa0b09d44e1abf6356.jpg";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function mount(props: Record<string, unknown>): void {
  act(() => {
    root.render(createElement(ProductImage, { alt: "", ...props } as never));
  });
}

function img(): HTMLImageElement {
  const el = host.querySelector("img");
  if (!el) throw new Error("img yok");
  return el;
}

describe("ProductImage varyant yedegi", () => {
  it("varyant yuklenemezse orijinal URL'ye duser ve srcset/sizes kalkar", () => {
    mount({ src: HB, sizes: "46vw" });
    expect(img().getAttribute("src")).toContain("/450-450/");
    expect(img().getAttribute("srcset")).toContain("1000w");
    expect(img().getAttribute("sizes")).toBe("46vw");

    act(() => {
      img().dispatchEvent(new Event("error"));
    });
    expect(img().getAttribute("src")).toBe(HB);
    expect(img().hasAttribute("srcset")).toBe(false);
    expect(img().hasAttribute("sizes")).toBe(false);
  });

  it("orijinal de yuklenemezse dongu olmaz, orijinal URL'de kalir", () => {
    mount({ src: HB, sizes: "46vw" });
    act(() => {
      img().dispatchEvent(new Event("error"));
    });
    act(() => {
      img().dispatchEvent(new Event("error"));
    });
    expect(img().getAttribute("src")).toBe(HB);
  });

  it("taninmayan kaynak etkilenmez; hata olayi URL'yi degistirmez", () => {
    mount({ src: AE, sizes: "46vw" });
    expect(img().getAttribute("src")).toBe(AE);
    act(() => {
      img().dispatchEvent(new Event("error"));
    });
    expect(img().getAttribute("src")).toBe(AE);
  });
});
