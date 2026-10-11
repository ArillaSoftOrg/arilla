import { describe, expect, it } from "vitest";
import { isPublicIp, type SafeResponse } from "./safe-fetch.ts";
import {
  attachStoreImages,
  extractPageProduct,
  productNameMatches,
  robotsAllows,
  type SafeGetFn,
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
