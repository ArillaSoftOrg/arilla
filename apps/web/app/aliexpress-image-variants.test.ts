// @vitest-environment jsdom
import { ProductCard, ProductImage, resolveImageVariants } from "@arilla/ui";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Karar 0167: AliExpress CDN varyantlari. `_{N}x{N}.jpg` eki N = 220/300/350/480/640/720/960/1200
 * icin gercek CDN'de dogrulandi (200, yeniden boyutlandirma, buyutme yok); 1200 uzeri
 * yeniden boyutlanmaz. Bayrak varsayilan KAPALI.
 */
const HASH = "5fa49ebc8cb345a0ad6e2fdc75d6e01c";
const S_URL = `https://ae-pic-a1.aliexpress-media.com/kf/S${HASH}G.jpg`;
const H_URL = `https://ae-pic-a1.aliexpress-media.com/kf/H${HASH}g.png`;
const A_URL = `https://ae-pic-a1.aliexpress-media.com/kf/A${HASH}5.jpeg`;
const HTB_URL = "https://ae-pic-a1.aliexpress-media.com/kf/HTB1wfhManZRMeJjSspkq6xGpXXac.jpg";
const HB = "https://productimages.hepsiburada.net/s/462/222-222/110000498569710.jpg";
const ON = { aliexpress: true } as const;

describe("resolveImageVariants - AliExpress", () => {
  it("bayrak kapaliyken (varsayilan) hicbir AliExpress URL'sine dokunmaz", () => {
    for (const url of [S_URL, H_URL, A_URL, HTB_URL]) {
      expect(resolveImageVariants(url)).toBeNull();
      expect(resolveImageVariants(url, { aliexpress: false })).toBeNull();
    }
  });

  it("bayrak aciksa dogrulanmis dort URL ailesi icin 8 genislikli srcset uretir", () => {
    for (const url of [S_URL, H_URL, A_URL, HTB_URL]) {
      const v = resolveImageVariants(url, ON);
      expect(v?.original).toBe(url);
      expect(v?.src).toBe(`${url}_640x640.jpg`);
      expect(v?.srcSet).toBe(
        [220, 300, 350, 480, 640, 720, 960, 1200]
          .map((w) => `${url}_${w}x${w}.jpg ${w}w`)
          .join(", "),
      );
    }
  });

  it("dogrulanmamis ya da bozuk bicimlere dokunmaz (null)", () => {
    const cases = [
      `${S_URL}_640x640.jpg`, // zaten boyutlu: ikinci ek eklenmez
      `${S_URL}?x=1`,
      S_URL.replace("https:", "http:"),
      S_URL.replace("ae-pic-a1", "ae-pic-a2"),
      S_URL.replace("aliexpress-media.com", "aliexpress-media.com.evil.example"),
      S_URL.replace(".jpg", ".webp"),
      S_URL.replace(".jpg", ".gif"),
      S_URL.replace("/kf/", "/kg/"),
      S_URL.replace(`S${HASH}`, `S${HASH.slice(0, 20)}`), // kisa hash
      S_URL.replace(`S${HASH}`, `X${HASH}`), // bilinmeyen onek
      S_URL.replace("/kf/S", "/kf/../S"),
      "https://ae01.alicdn.com/kf/S5fa49ebc8cb345a0ad6e2fdc75d6e01cG.jpg", // baska host
      "https://ae-pic-a1.aliexpress-media.com/kf/HTB1short.jpg",
      "",
    ];
    for (const url of cases) expect(resolveImageVariants(url, ON), url).toBeNull();
  });

  it("Hepsiburada bayraktan bagimsiz: kapaliyken de acikken de ayni", () => {
    const off = resolveImageVariants(HB);
    const on = resolveImageVariants(HB, ON);
    expect(off).not.toBeNull();
    expect(on).toEqual(off);
  });
});

describe("ProductImage / ProductCard - bayrak kapali ve acik", () => {
  const image = (props: Record<string, unknown>) =>
    renderToStaticMarkup(createElement(ProductImage, { alt: "", ...props } as never));
  const card = (props: Record<string, unknown>) =>
    renderToStaticMarkup(
      createElement(ProductCard, {
        href: "/urun/x",
        title: "Urun",
        minPrice: 1000,
        ...props,
      } as never),
    );

  it("kapaliyken AliExpress isaretlemesi bugunkuyle birebir: orijinal src, srcset yok", () => {
    const html = image({ src: S_URL, sizes: "46vw" });
    expect(html).toContain(`src="${S_URL}"`);
    expect(html).not.toContain("srcSet");
    expect(html).not.toContain("sizes=");
  });

  it("acikken srcset + sizes uretir; src 640, orijinal yalniz yedek", () => {
    const html = image({ src: S_URL, sizes: "46vw", aliexpress: true });
    expect(html).toContain('sizes="46vw"');
    expect(html).toContain("srcSet=");
    expect(html).toContain(`src="${S_URL}_640x640.jpg"`);
    expect(html).toContain("_1200x1200.jpg 1200w");
    expect(html).toContain("_720x720.jpg 720w");
    expect(html).not.toContain(`src="${S_URL}"`);
  });

  it("sizes olmadan acikken tek orta boyut (srcset yok)", () => {
    const html = image({ src: S_URL, aliexpress: true });
    expect(html).toContain(`src="${S_URL}_640x640.jpg"`);
    expect(html).not.toContain("srcSet");
  });

  it("ProductCard bayragi iletir; varsayilan kapali", () => {
    expect(card({ imageUrl: S_URL })).toContain(`src="${S_URL}"`);
    expect(card({ imageUrl: S_URL })).not.toContain("srcSet");
    const on = card({ imageUrl: S_URL, aliexpressVariants: true });
    expect(on).toContain("_480x480.jpg 480w");
    // Desteklenmeyen boyutlar CDN'de sessizce orijinali doner: merdivende ASLA olmamali.
    for (const bad of [400, 560, 1000, 1100, 1600, 1800, 2400, 4000]) {
      expect(on).not.toContain(`_${bad}x${bad}.jpg`);
    }
    expect(on).toContain("calc(50vw - 48px)");
  });

  it("ProductCard Hepsiburada regresyonu: bayraktan bagimsiz 450 + 1000w", () => {
    for (const flag of [false, true]) {
      const html = card({ imageUrl: HB, aliexpressVariants: flag });
      expect(html).toContain("450-450");
      expect(html).toContain("1000w");
      expect(html).not.toContain("222-222");
    }
  });
});

describe("AliExpress varyant yedegi (jsdom)", () => {
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
  const img = () => host.querySelector("img") as HTMLImageElement;
  const mount = (props: Record<string, unknown>) =>
    act(() => {
      root.render(createElement(ProductImage, { alt: "", ...props } as never));
    });

  it("varyant yuklenemezse orijinal URL'ye duser; srcset ve sizes kalkar", () => {
    mount({ src: S_URL, sizes: "46vw", aliexpress: true });
    expect(img().getAttribute("src")).toBe(`${S_URL}_640x640.jpg`);
    act(() => {
      img().dispatchEvent(new Event("error"));
    });
    expect(img().getAttribute("src")).toBe(S_URL);
    expect(img().hasAttribute("srcset")).toBe(false);
    expect(img().hasAttribute("sizes")).toBe(false);
  });

  it("orijinal de yuklenemezse dongu yok, orijinalde kalir", () => {
    mount({ src: S_URL, sizes: "46vw", aliexpress: true });
    act(() => {
      img().dispatchEvent(new Event("error"));
    });
    act(() => {
      img().dispatchEvent(new Event("error"));
    });
    expect(img().getAttribute("src")).toBe(S_URL);
  });

  it("bayrak kapaliyken hata olayi URL'yi degistirmez", () => {
    mount({ src: S_URL, sizes: "46vw" });
    act(() => {
      img().dispatchEvent(new Event("error"));
    });
    expect(img().getAttribute("src")).toBe(S_URL);
  });
});
