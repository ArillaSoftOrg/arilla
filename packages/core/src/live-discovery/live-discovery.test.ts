import { describe, expect, it } from "vitest";

import { discoverProducts, pickCategory } from "./discover.ts";
import { extractListingProducts, extractProductPage, parsePrice } from "./extract.ts";
import { matchTitle, tokenize } from "./match.ts";
import { type FetchLike, PoliteFetcher } from "./polite-fetcher.ts";
import { isAllowed, parseRobots } from "./robots.ts";

// Sentetik test verisi: canli sonuc DEGILDIR, yalnizca ayristirici davranisini sinar.
const ORIGIN = "https://shop.test";

const ROBOTS = `User-agent: *
User-agent: Googlebot
Disallow: /*?q=
Disallow: /sr?
Disallow: /sr$
Allow: /*gads=true
Disallow: /sepetim

User-agent: AhrefsBot
Disallow: /
`;

function ld(obj: unknown): string {
  return `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;
}

function offer(price: string, extra: Record<string, unknown> = {}) {
  return {
    "@type": "Offer",
    priceCurrency: "TRY",
    price,
    availability: "https://schema.org/InStock",
    itemCondition: "https://schema.org/NewCondition",
    ...extra,
  };
}

function productNode(
  slug: string,
  id: number,
  name: string,
  price: string,
  related: string[] = [],
) {
  return {
    "@type": "Product",
    url: `${ORIGIN}/${slug}-p-${id}`,
    name,
    image: [`https://img.test/${id}.jpg`],
    offers: offer(price),
    isRelatedTo: related,
  };
}

function fakeFetch(pages: Record<string, { status?: number; body: string }>): {
  fn: FetchLike;
  calls: string[];
} {
  const calls: string[] = [];
  const fn: FetchLike = async (url) => {
    calls.push(url);
    const hit = pages[url];
    const status = hit?.status ?? (hit ? 200 : 404);
    return { status, headers: { get: () => null }, text: async () => hit?.body ?? "" };
  };
  return { fn, calls };
}

function mkFetcher(fn: FetchLike, maxRequests = 20) {
  return new PoliteFetcher({
    userAgent: "TestBot/1.0",
    origin: ORIGIN,
    maxRequests,
    minIntervalMs: 0,
    fetchImpl: fn,
    sleep: async () => {},
  });
}

describe("robots", () => {
  const rules = parseRobots(ROBOTS, "TestBot/1.0");
  it("arama yolunu ve sorgu parametresini engeller", () => {
    expect(isAllowed(rules, "/sr?q=iphone")).toBe(false);
    expect(isAllowed(rules, "/kategori-x-c1?q=a")).toBe(false);
    expect(isAllowed(rules, "/sepetim")).toBe(false);
  });
  it("kategori ve urun yollarina izin verir", () => {
    expect(isAllowed(rules, "/iphone-x-c164462")).toBe(true);
    expect(isAllowed(rules, "/apple/iphone-16-p-1")).toBe(true);
  });
  it("en uzun eslesme kazanir (Allow > kisa Disallow)", () => {
    const r = parseRobots("User-agent: *\nDisallow: /a\nAllow: /a/b\n", "x");
    expect(isAllowed(r, "/a/b/c")).toBe(true);
    expect(isAllowed(r, "/a/z")).toBe(false);
  });
  it("kendi grubumuz varsa onu kullanir", () => {
    const r = parseRobots(
      "User-agent: *\nAllow: /\n\nUser-agent: TestBot\nDisallow: /\n",
      "TestBot/1.0",
    );
    expect(isAllowed(r, "/x")).toBe(false);
  });
});

describe("parsePrice", () => {
  it("kuruş tamsayisi uretir, float kullanmaz", () => {
    expect(parsePrice("149999.00")).toEqual({ price: "149999.00", kurus: 14_999_900 });
    expect(parsePrice("1.499,90")).toEqual({ price: "1499.90", kurus: 149_990 });
    expect(parsePrice("10.5")).toEqual({ price: "10.50", kurus: 1050 });
  });
  it("gecersiz ya da sifir fiyati reddeder", () => {
    expect(parsePrice("0")).toBeNull();
    expect(parsePrice("abc")).toBeNull();
    expect(parsePrice(undefined)).toBeNull();
  });
});

describe("match", () => {
  it("depolama belirtecini birlestirir", () => {
    expect(tokenize("iPhone 16 Pro 128 GB")).toEqual(["iphone", "16", "pro", "128gb"]);
  });
  it("model/depolama eslesir", () => {
    expect(matchTitle("Apple iPhone 16 Pro 128GB Siyah Titanyum", "iPhone 16 Pro 128 GB").ok).toBe(
      true,
    );
  });
  it("varyant kaymasini reddeder (Pro Max, farkli depolama, yenilenmis)", () => {
    const q = "iPhone 16 Pro 128 GB";
    expect(matchTitle("Apple iPhone 16 Pro Max 128GB", q).reason).toBe("variant:max");
    expect(matchTitle("Apple iPhone 16 Pro 256GB", q).reason).toBe("missing:128gb");
    expect(matchTitle("Apple iPhone 16 128GB", q).reason).toBe("missing:pro");
    expect(matchTitle("Apple iPhone 16 Pro 128GB Yenilio B Kalite", q).ok).toBe(false);
  });
});

describe("extract", () => {
  const ctx = {
    origin: ORIGIN,
    merchant: "Shop",
    checkedAt: "2026-01-01T00:00:00.000Z",
    pageUrl: `${ORIGIN}/a/x-p-1`,
  };

  it("JSON-LD Product alanlarini cikarir", () => {
    const html = ld(productNode("a/x", 1, "X Telefon", "1999.90"));
    const p = extractProductPage(html, ctx);
    expect(p).toMatchObject({
      title: "X Telefon",
      price: "1999.90",
      priceKurus: 199_990,
      currency: "TRY",
      imageUrl: "https://img.test/1.jpg",
      availability: "in_stock",
      condition: "new",
      source: "json-ld",
      missing: [],
    });
  });

  it("dogrulanamayan fiyat/gorseli uretmez ve eksik olarak isaretler", () => {
    const node = {
      "@type": "Product",
      url: `${ORIGIN}/a/x-p-1`,
      name: "X",
      offers: { "@type": "Offer", price: "abc" },
    };
    const p = extractProductPage(ld(node), ctx);
    expect(p?.price).toBeNull();
    expect(p?.imageUrl).toBeNull();
    expect(p?.missing).toEqual(
      expect.arrayContaining(["price", "currency", "imageUrl", "availability"]),
    );
  });

  it("para birimi yoksa fiyati gostermez", () => {
    const node = {
      "@type": "Product",
      url: `${ORIGIN}/a/x-p-1`,
      name: "X",
      offers: { price: "10.00" },
    };
    expect(extractProductPage(ld(node), ctx)?.price).toBeNull();
  });

  it("JSON-LD yoksa Open Graph'a duser, fiyat uydurmaz", () => {
    const html = `<meta property="og:title" content="OG Baslik" /><meta property="og:image" content="https://img.test/o.jpg" />`;
    const p = extractProductPage(html, ctx);
    expect(p).toMatchObject({ title: "OG Baslik", price: null, source: "open-graph" });
    expect(p?.missing).toContain("price");
  });

  it("ItemList'ten urunleri okur, urun olmayan adresleri atar", () => {
    const list = {
      "@type": "ItemList",
      itemListElement: [
        { "@type": "ListItem", item: productNode("a/x", 1, "X", "10.00") },
        {
          "@type": "ListItem",
          item: { "@type": "Product", url: `${ORIGIN}/kategori-x-c5`, name: "bozuk" },
        },
      ],
    };
    expect(extractListingProducts(ld(list), ctx).map((p) => p.productUrl)).toEqual([
      `${ORIGIN}/a/x-p-1`,
    ]);
  });

  it("bozuk JSON-LD blogunu yok sayar", () => {
    const html = `<script type="application/ld+json">{bozuk</script>${ld(productNode("a/x", 1, "X", "10.00"))}`;
    expect(extractProductPage(html, ctx)?.title).toBe("X");
  });
});

describe("PoliteFetcher", () => {
  it("robots yuklenmeden ve izin yoksa istek atmaz", async () => {
    const { fn, calls } = fakeFetch({ [`${ORIGIN}/robots.txt`]: { body: ROBOTS } });
    const f = mkFetcher(fn);
    expect((await f.get(`${ORIGIN}/x`)).ok).toBe(false);
    await f.loadRobots();
    const res = await f.get(`${ORIGIN}/sr?q=iphone`);
    expect(res).toMatchObject({ ok: false, reason: "robots-disallowed" });
    expect(calls).toEqual([`${ORIGIN}/robots.txt`]);
  });

  it("403'te durur ve sonraki hicbir istegi atmaz", async () => {
    const { fn, calls } = fakeFetch({
      [`${ORIGIN}/robots.txt`]: { body: ROBOTS },
      [`${ORIGIN}/a`]: { status: 403, body: "" },
      [`${ORIGIN}/b`]: { body: "ok" },
    });
    const f = mkFetcher(fn);
    await f.loadRobots();
    expect(await f.get(`${ORIGIN}/a`)).toMatchObject({ ok: false, reason: "blocked", status: 403 });
    expect(await f.get(`${ORIGIN}/b`)).toMatchObject({ ok: false, reason: "blocked" });
    expect(calls).toEqual([`${ORIGIN}/robots.txt`, `${ORIGIN}/a`]);
  });

  it("429'da da durur", async () => {
    const { fn } = fakeFetch({
      [`${ORIGIN}/robots.txt`]: { body: ROBOTS },
      [`${ORIGIN}/a`]: { status: 429, body: "" },
    });
    const f = mkFetcher(fn);
    await f.loadRobots();
    await f.get(`${ORIGIN}/a`);
    expect(f.blockedBy?.status).toBe(429);
  });

  it("bot-dogrulama sayfasini engel sayar (asmaya calismaz)", async () => {
    const { fn } = fakeFetch({
      [`${ORIGIN}/robots.txt`]: { body: ROBOTS },
      [`${ORIGIN}/a`]: { body: "<html>Please solve the CAPTCHA</html>" },
    });
    const f = mkFetcher(fn);
    await f.loadRobots();
    expect(await f.get(`${ORIGIN}/a`)).toMatchObject({ ok: false, reason: "blocked" });
  });

  it("istek butcesini asmaz", async () => {
    const { fn, calls } = fakeFetch({
      [`${ORIGIN}/robots.txt`]: { body: ROBOTS },
      [`${ORIGIN}/a`]: { body: "ok" },
    });
    const f = mkFetcher(fn, 2);
    await f.loadRobots();
    await f.get(`${ORIGIN}/a`);
    expect(await f.get(`${ORIGIN}/a`)).toMatchObject({ ok: false, reason: "budget-exhausted" });
    expect(calls).toHaveLength(2);
  });

  it("istekler arasi bekleme uygular", async () => {
    const waits: number[] = [];
    let t = 1000;
    const { fn } = fakeFetch({
      [`${ORIGIN}/robots.txt`]: { body: ROBOTS },
      [`${ORIGIN}/a`]: { body: "ok" },
    });
    const f = new PoliteFetcher({
      userAgent: "T",
      origin: ORIGIN,
      maxRequests: 5,
      minIntervalMs: 2500,
      fetchImpl: fn,
      now: () => t,
      sleep: async (ms) => {
        waits.push(ms);
        t += ms;
      },
    });
    await f.loadRobots();
    await f.get(`${ORIGIN}/a`);
    expect(waits).toEqual([2500]);
  });
});

describe("pickCategory", () => {
  const xml = ["iphone-ios-cep-telefonlari-x-c1", "cep-telefonu-x-c2", "kadin-giyim-x-c3"]
    .map((s) => `<url><loc>${ORIGIN}/${s}</loc></url>`)
    .join("");
  it("sorgu sozcuklerine en cok uyan kategoriyi secer", () => {
    expect(pickCategory(xml, "iPhone 16 Pro 128 GB", ORIGIN)).toBe(
      `${ORIGIN}/iphone-ios-cep-telefonlari-x-c1`,
    );
  });
  it("uyan kategori yoksa null doner", () => {
    expect(pickCategory(xml, "buzdolabi", ORIGIN)).toBeNull();
  });
});

describe("discoverProducts (sentetik site)", () => {
  const cat = `${ORIGIN}/iphone-x-c1`;
  const target = productNode(
    "apple/iphone-16-pro-128gb-siyah",
    10,
    "Apple iPhone 16 Pro 128GB Siyah",
    "64999.00",
  );
  const listing = ld({
    "@type": "ItemList",
    itemListElement: [
      {
        item: productNode("apple/iphone-15-128gb", 2, "Apple iPhone 15 128GB", "40000.00", [
          target.url,
        ]),
      },
      {
        item: productNode(
          "apple/iphone-16-pro-max-128gb",
          3,
          "Apple iPhone 16 Pro Max 128GB",
          "80000.00",
        ),
      },
    ],
  });
  const sitemap = `<url><loc>${cat}</loc></url>`;
  const base = {
    [`${ORIGIN}/robots.txt`]: { body: ROBOTS },
    [`${ORIGIN}/sitemap_categories.xml`]: { body: sitemap },
    [cat]: { body: listing },
  };

  it("listede olmayan urunu isRelatedTo uzerinden bulur ve dogrular", async () => {
    const { fn } = fakeFetch({ ...base, [target.url]: { body: ld(target) } });
    const res = await discoverProducts(mkFetcher(fn), { query: "iPhone 16 Pro 128 GB" });
    expect(res.products.map((p) => p.title)).toEqual(["Apple iPhone 16 Pro 128GB Siyah"]);
    expect(res.products[0]?.priceKurus).toBe(6_499_900);
    expect(res.trace.rejected).toMatchObject({ variant: expect.any(Number) });
  });

  it("hic eslesme yoksa bos doner; uydurma urun koymaz", async () => {
    const { fn } = fakeFetch(base);
    const res = await discoverProducts(mkFetcher(fn), { query: "iPhone 16 Pro 1 TB" });
    expect(res.products).toEqual([]);
    expect(res.trace.stoppedBecause).toBeTruthy();
  });

  it("kategori sayfasi 403 verirse durur", async () => {
    const { fn, calls } = fakeFetch({ ...base, [cat]: { status: 403, body: "" } });
    const res = await discoverProducts(mkFetcher(fn), { query: "iPhone 16 Pro 128 GB" });
    expect(res.products).toEqual([]);
    expect(res.trace.blocked?.status).toBe(403);
    expect(calls.at(-1)).toBe(cat);
  });

  it("arama adresini (/sr?q=) asla istemez", async () => {
    const { fn, calls } = fakeFetch({ ...base, [target.url]: { body: ld(target) } });
    await discoverProducts(mkFetcher(fn), { query: "iPhone 16 Pro 128 GB" });
    expect(calls.some((u) => u.includes("/sr") || u.includes("?q="))).toBe(false);
  });
});
