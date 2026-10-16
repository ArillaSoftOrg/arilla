import { describe, expect, it } from "vitest";
import { isPublicIp, type SafeResponse } from "./safe-fetch.ts";
import {
  attachStoreImages,
  extractPageProduct,
  productNameMatches,
  robotsAllows,
  type SafeGetFn,
  selectDisplayGroups,
} from "./store-image.ts";
import type { WebProductGroup } from "./types.ts";

const PAGE = "https://www.shop.com.tr/urun/sony-wh-1000xm5";

describe("isPublicIp", () => {
  it("rejects private, loopback, link-local and mapped addresses", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "192.168.1.1",
      "172.20.0.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:10.0.0.1",
      "not-an-ip",
    ]) {
      expect(isPublicIp(ip), ip).toBe(false);
    }
  });
  it("accepts public addresses", () => {
    expect(isPublicIp("8.8.8.8")).toBe(true);
    expect(isPublicIp("2606:4700::1111")).toBe(true);
  });
});

describe("extractPageProduct", () => {
  it("reads JSON-LD Product.image (array, relative url) inside @graph", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@graph": [
        { "@type": "BreadcrumbList" },
        {
          "@type": "Product",
          name: "Sony WH-1000XM5 Kulaklik",
          image: ["/img/a.jpg?utm_source=x"],
        },
      ],
    })}</script>`;
    expect(extractPageProduct(html, PAGE)).toEqual({
      name: "Sony WH-1000XM5 Kulaklik",
      image: "https://www.shop.com.tr/img/a.jpg",
    });
  });
  it("uses og:image unless the page declares a non-product type", () => {
    const base = `<meta property="og:title" content="Sony &amp; Co WH-1000XM5"><meta property="og:image" content="https://cdn.shop.com.tr/p.jpg">`;
    expect(extractPageProduct(base, PAGE)?.image).toBe("https://cdn.shop.com.tr/p.jpg");
    const website = `${base}<meta property="og:type" content="website">`;
    expect(extractPageProduct(website, PAGE)?.name).toBe("Sony & Co WH-1000XM5");
    const article = `${base}<meta property="og:type" content="article">`;
    expect(extractPageProduct(article, PAGE)).toBeNull();
  });
  it("rejects unsafe image urls", () => {
    const html = `<script type="application/ld+json">{"@type":"Product","name":"A B","image":"http://10.0.0.1/x.jpg"}</script>`;
    expect(extractPageProduct(html, PAGE)).toBeNull();
  });
});

describe("productNameMatches", () => {
  const group = { title: "Sony WH-1000XM5 Kulaklik", brand: "Sony" };
  it("accepts the same product and rejects a different model", () => {
    expect(productNameMatches(group, "Sony WH-1000XM5 Kablosuz Kulaklik Siyah")).toBe(true);
    expect(productNameMatches(group, "Sony WH-1000XM4 Kablosuz Kulaklik")).toBe(false);
    expect(productNameMatches(group, "Bose QuietComfort 45")).toBe(false);
  });
});

describe("robotsAllows", () => {
  it("honours disallow, allow and our own agent group", () => {
    const robots = "User-agent: *\nDisallow: /urun/\nAllow: /urun/ok\n";
    expect(robotsAllows(robots, "/urun/x")).toBe(false);
    expect(robotsAllows(robots, "/urun/ok-1")).toBe(true);
    expect(robotsAllows(robots, "/baska")).toBe(true);
    expect(robotsAllows("User-agent: ManiCepteBot\nDisallow: /\n", "/a")).toBe(false);
    expect(
      robotsAllows("User-agent: *\nDisallow: /\nUser-agent: ManiCepteBot\nAllow: /\n", "/a"),
    ).toBe(true);
  });
});

function group(over: Partial<WebProductGroup> = {}): WebProductGroup {
  return {
    key: "k",
    title: "Sony WH-1000XM5 Kulaklik",
    brand: "Sony",
    matchKind: "exact",
    offers: [
      {
        id: "o1",
        seller: "shop.com.tr",
        host: "shop.com.tr",
        url: PAGE,
        title: "x",
        priceKurus: null,
        priceStatus: "unverified",
        inStock: null,
      },
    ],
    minVerifiedPriceKurus: null,
    ...over,
  };
}

function res(over: Partial<SafeResponse>): SafeResponse {
  return {
    status: 200,
    contentType: "text/html",
    contentLength: null,
    body: Buffer.alloc(0),
    finalUrl: PAGE,
    ...over,
  };
}

const LD = `<script type="application/ld+json">{"@type":"Product","name":"Sony WH-1000XM5 Kablosuz Kulaklik","image":"https://cdn.shop.com.tr/a.jpg"}</script>`;

describe("attachStoreImages", () => {
  const fake =
    (opts: {
      robots?: string;
      html?: string;
      imageType?: string;
      imageLength?: number;
    }): SafeGetFn =>
    async (url) => {
      if (url.endsWith("/robots.txt")) {
        return res({ contentType: "text/plain", body: Buffer.from(opts.robots ?? "") });
      }
      if (url.endsWith(".jpg")) {
        return res({
          contentType: opts.imageType ?? "image/jpeg",
          contentLength: opts.imageLength ?? 1000,
        });
      }
      return res({ body: Buffer.from(opts.html ?? LD) });
    };

  it("attaches a verified store image", async () => {
    const [out] = await attachStoreImages([group()], { get: fake({}) });
    expect(out?.imageUrl).toBe("https://cdn.shop.com.tr/a.jpg");
  });
  it("keeps an existing catalog image untouched", async () => {
    const [out] = await attachStoreImages([group({ imageUrl: "https://cat/x.jpg" })], {
      get: async () => {
        throw new Error("must not fetch");
      },
    });
    expect(out?.imageUrl).toBe("https://cat/x.jpg");
  });
  it("skips robots-disallowed pages, wrong products, bad image types and blocked pages", async () => {
    const cases = [
      fake({ robots: "User-agent: *\nDisallow: /" }),
      fake({ html: LD.replace("WH-1000XM5", "WH-1000XM4") }),
      fake({ imageType: "image/svg+xml" }),
      fake({ imageLength: 50_000_000 }),
      (async () => res({ status: 403 })) as SafeGetFn,
      (async () => null) as SafeGetFn,
    ];
    for (const get of cases) {
      const [out] = await attachStoreImages([group()], { get });
      expect(out?.imageUrl ?? null).toBeNull();
    }
  });
});

describe("pool, independence and display selection", () => {
  const mk = (n: number, host = "shop.com.tr", title?: string): WebProductGroup =>
    group({
      key: `k${n}`,
      title: title ?? `Sony WH-1000XM5 Kulaklik ${n}`,
      offers: [
        {
          id: `o${n}`,
          seller: host,
          host,
          url: `https://www.${host}/urun/p${n}`,
          title: "x",
          priceKurus: null,
          priceStatus: "unverified",
          inStock: null,
        },
      ],
    });
  const page = (n: number) =>
    `<script type="application/ld+json">{"@type":"Product","name":"Sony WH-1000XM5 Kulaklik ${n}","image":"https://cdn.shop.com.tr/${n}.jpg"}</script>`;

  it("judges each product on its own: a 403 on one product does not block the same store's others", async () => {
    const get: SafeGetFn = async (url) => {
      if (url.endsWith("/robots.txt")) return res({ body: Buffer.from("") });
      if (url.endsWith(".jpg")) return res({ contentType: "image/png", contentLength: 10 });
      if (url.endsWith("/p1")) return res({ status: 403 });
      const n = Number(/\/p(\d+)$/.exec(url)?.[1]);
      return res({ body: Buffer.from(page(n)) });
    };
    const out = await attachStoreImages([mk(1), mk(2), mk(3)], { get });
    expect(out.map((g) => Boolean(g.imageUrl))).toEqual([false, true, true]);
  });

  it("goes past the first 8 candidates until enough imaged products are found", async () => {
    const get: SafeGetFn = async (url) => {
      if (url.endsWith("/robots.txt")) return res({ body: Buffer.from("") });
      if (url.endsWith(".jpg")) return res({ contentType: "image/jpeg", contentLength: 10 });
      const n = Number(/\/p(\d+)$/.exec(url)?.[1]);
      // Ilk 9 urunun sayfasi engelli; 10-12 gorselli.
      return n <= 9 ? res({ status: 404 }) : res({ body: Buffer.from(page(n)) });
    };
    const groups = Array.from({ length: 12 }, (_, i) => mk(i + 1));
    const out = await attachStoreImages(groups, { get });
    expect(
      selectDisplayGroups(out)
        .map((g) => g.key)
        .slice(0, 3),
    ).toEqual(["k10", "k11", "k12"]);
  });

  it("does not fetch more than needed once the target is reached", async () => {
    let pages = 0;
    const get: SafeGetFn = async (url) => {
      if (url.endsWith("/robots.txt")) return res({ body: Buffer.from("") });
      if (url.endsWith(".jpg")) return res({ contentType: "image/jpeg", contentLength: 10 });
      pages++;
      const n = Number(/\/p(\d+)$/.exec(url)?.[1]);
      return res({ body: Buffer.from(page(n)) });
    };
    const out = await attachStoreImages(
      Array.from({ length: 12 }, (_, i) => mk(i + 1)),
      {
        get,
        target: 2,
      },
    );
    expect(selectDisplayGroups(out).filter((g) => g.imageUrl).length).toBeGreaterThanOrEqual(2);
    expect(pages).toBeLessThan(12);
  });

  it("does not attach broken-image or wrong-product images (products stay, imageless)", async () => {
    const get: SafeGetFn = async (url) => {
      if (url.endsWith("/robots.txt")) return res({ body: Buffer.from("") });
      if (url.endsWith("/1.jpg")) return res({ status: 404, contentType: "text/html" });
      return res({ body: Buffer.from(page(url.endsWith("/p2") ? 99 : 1)) });
    };
    const out = await attachStoreImages(
      [mk(1), mk(2, "other.com.tr", "Sony WH-1000XM4 Kulaklik")],
      {
        get,
      },
    );
    expect(out.every((g) => !g.imageUrl)).toBe(true);
    expect(selectDisplayGroups(out).map((g) => g.key)).toEqual(["k1", "k2"]);
  });

  const withImg = (n: number, img: string | null, matchKind: "exact" | "similar" = "exact") => ({
    ...mk(n),
    matchKind,
    imageUrl: img,
  });

  it("puts imaged products first, keeps imageless ones compact after, exact before similar", () => {
    const out = selectDisplayGroups([
      withImg(1, null, "exact"),
      withImg(2, "https://c/2.jpg", "similar"),
      withImg(3, "https://c/3.jpg", "exact"),
      withImg(4, null, "similar"),
    ]);
    expect(out.map((g) => g.key)).toEqual(["k3", "k1", "k2", "k4"]);
  });

  it("keeps a product whose image is shared with another, but without the image", () => {
    const out = selectDisplayGroups([withImg(1, "https://c/1.jpg"), withImg(2, "https://c/1.jpg")]);
    expect(out.map((g) => [g.key, g.imageUrl])).toEqual([
      ["k1", "https://c/1.jpg"],
      ["k2", null],
    ]);
  });

  it("caps imaged at 8 and imageless at the rest of the pool", () => {
    const input = [
      ...Array.from({ length: 10 }, (_, i) => withImg(i + 1, `https://c/${i + 1}.jpg`)),
      ...Array.from({ length: 6 }, (_, i) => withImg(i + 11, null)),
    ];
    const out = selectDisplayGroups(input);
    expect(out.filter((g) => g.imageUrl).length).toBe(8);
    expect(out.filter((g) => !g.imageUrl).length).toBe(4);
  });

  it("keeps imageless products when no result has a verifiable image", () => {
    expect(selectDisplayGroups([mk(1), mk(2)]).length).toBe(2);
  });
});
