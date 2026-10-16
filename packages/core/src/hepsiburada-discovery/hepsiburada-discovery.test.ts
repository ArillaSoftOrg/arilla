/**
 * Not: buradaki HTML'ler SENTETIK test girdileridir (canli Hepsiburada verisi
 * degil). Canli kesfin calistigini kanitlamazlar; yalnizca cikarici ve engel
 * davranisinin kodunu sinarlar.
 */

import { describe, expect, it } from "vitest";
import { discoverHepsiburada, matchesQuery } from "./discover.ts";
import { extractProductFromHtml, extractProductLinks, parsePriceToKurus } from "./extract.ts";
import { type FetchLike, PoliteFetcher } from "./polite-fetcher.ts";
import { isAllowed, parseRobots } from "./robots.ts";

const ORIGIN = "https://www.hepsiburada.com";
const NOW = "2026-10-12T10:00:00.000Z";

const jsonLd = (obj: unknown) =>
  `<html><script type="application/ld+json">${JSON.stringify(obj)}</script></html>`;

const productHtml = jsonLd({
  "@context": "https://schema.org",
  "@type": "Product",
  name: "Test Telefon 16 Pro 128 GB",
  image: ["https://images.example-cdn.test/a.jpg"],
  offers: {
    "@type": "Offer",
    price: "54.999,90",
    priceCurrency: "try",
    availability: "https://schema.org/InStock",
    seller: { "@type": "Organization", name: "Test Satici" },
  },
});

function fakeFetch(routes: Record<string, { status: number; body: string }>): FetchLike {
  return async (url) => {
    const r = routes[url] ?? { status: 404, body: "" };
    return { status: r.status, headers: { get: () => null }, text: async () => r.body };
  };
}

function makeFetcher(fetchImpl: FetchLike) {
  const sleeps: number[] = [];
  const fetcher = new PoliteFetcher({
    userAgent: "TestBot/1.0",
    origin: ORIGIN,
    maxRequests: 10,
    minIntervalMs: 1000,
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { fetcher, sleeps };
}

describe("robots", () => {
  it("izin ve yasaklari en uzun eslesmeyle degerlendirir, sitemap'i okur", () => {
    const r = parseRobots(
      "User-agent: *\nDisallow: /ara\nAllow: /ara/ozel\nSitemap: https://x.test/s.xml\n",
      "TestBot",
    );
    expect(isAllowed(r, "/ara?q=a")).toBe(false);
    expect(isAllowed(r, "/ara/ozel")).toBe(true);
    expect(isAllowed(r, "/urun-p-1")).toBe(true);
    expect(r.sitemaps).toEqual(["https://x.test/s.xml"]);
  });
});

describe("fiyat", () => {
  it("kurusa tamsayi cevirir, gecersizi reddeder", () => {
    expect(parsePriceToKurus("54.999,90")).toBe(5499990);
    expect(parsePriceToKurus("1299.90")).toBe(129990);
    expect(parsePriceToKurus(1299.9)).toBe(129990);
    expect(parsePriceToKurus("1.299")).toBe(129900);
    expect(parsePriceToKurus("0")).toBeNull();
    expect(parsePriceToKurus("abc")).toBeNull();
  });
});

describe("extractProductFromHtml", () => {
  it("JSON-LD'den tum alanlari cikarir", () => {
    const p = extractProductFromHtml(productHtml, `${ORIGIN}/test-telefon-p-HBC1`, NOW);
    expect(p).toEqual({
      title: "Test Telefon 16 Pro 128 GB",
      priceKurus: 5499990,
      currency: "TRY",
      imageUrl: "https://images.example-cdn.test/a.jpg",
      productUrl: `${ORIGIN}/test-telefon-p-HBC1`,
      merchant: "Test Satici",
      availability: "in_stock",
      lastCheckedAt: NOW,
    });
  });

  it("@graph icindeki Product'i bulur; fiyat yoksa fiyat/para birimi null kalir", () => {
    const html = jsonLd({ "@graph": [{ "@type": "Product", name: "X", offers: {} }] });
    const p = extractProductFromHtml(html, `${ORIGIN}/x-p-1`, NOW);
    expect(p?.priceKurus).toBeNull();
    expect(p?.currency).toBeNull();
    expect(p?.availability).toBe("unknown");
    expect(p?.merchant).toBe("Hepsiburada");
  });

  it("Product yoksa ya da adres baska alan adindaysa null doner", () => {
    expect(extractProductFromHtml("<html></html>", `${ORIGIN}/x-p-1`, NOW)).toBeNull();
    expect(extractProductFromHtml(productHtml, "https://evil.example/x-p-1", NOW)).toBeNull();
  });
});

describe("extractProductLinks", () => {
  it("yalnizca hepsiburada urun yollarini alir, tekrarlari ve izlemeyi atar", () => {
    const html = `<a href="/a-telefon-p-HBC1?utm_source=x">1</a>
      <a href="/a-telefon-p-HBC1">dup</a>
      <a href="https://www.hepsiburada.com/b-pm-HBC2">2</a>
      <a href="https://baska.test/c-p-3">3</a><a href="/kategori">4</a>`;
    expect(extractProductLinks(html, `${ORIGIN}/ara?q=x`, 10)).toEqual([
      `${ORIGIN}/a-telefon-p-HBC1`,
      `${ORIGIN}/b-pm-HBC2`,
    ]);
  });
});

describe("matchesQuery", () => {
  it("tum sorgu sozcukleri basliktaysa eslesir", () => {
    expect(matchesQuery("Apple iPhone 16 Pro 128 GB Siyah", "iPhone 16 Pro 128 GB")).toBe(true);
    expect(matchesQuery("Apple iPhone 16 Pro Max 256 GB", "iPhone 16 Pro 128 GB")).toBe(false);
  });
});

describe("PoliteFetcher", () => {
  it("robots.txt 403 ise engellenir ve hicbir sayfa istenmez", async () => {
    const calls: string[] = [];
    const { fetcher } = makeFetcher(async (url) => {
      calls.push(url);
      return {
        status: 403,
        headers: { get: () => null },
        text: async () => "<html>captcha</html>",
      };
    });
    const report = await discoverHepsiburada("iPhone 16 Pro 128 GB", fetcher, { maxProducts: 3 });
    expect(report.status).toBe("blocked");
    expect(report.products).toEqual([]);
    expect(calls).toEqual([`${ORIGIN}/robots.txt`]);
  });

  it("200 donse bile kisa captcha sayfasini engel sayar", async () => {
    const { fetcher } = makeFetcher(
      fakeFetch({ [`${ORIGIN}/robots.txt`]: { status: 200, body: "<html>px-captcha</html>" } }),
    );
    expect((await fetcher.loadRobots()).ok).toBe(false);
    expect(fetcher.blockedBy?.status).toBe(200);
  });

  it("429 sonrasi sonraki tum istekler reddedilir", async () => {
    const { fetcher } = makeFetcher(
      fakeFetch({
        [`${ORIGIN}/robots.txt`]: { status: 200, body: "User-agent: *\nAllow: /\n" },
        [`${ORIGIN}/a`]: { status: 429, body: "" },
      }),
    );
    await fetcher.loadRobots();
    const a = await fetcher.get(`${ORIGIN}/a`);
    const b = await fetcher.get(`${ORIGIN}/b`);
    expect(a).toMatchObject({ ok: false, reason: "blocked", status: 429 });
    expect(b).toMatchObject({ ok: false, reason: "blocked" });
    expect(fetcher.requestCount).toBe(2);
  });

  it("robots yasakladigi yola istek atmaz ve istekler arasinda bekler", async () => {
    const { fetcher, sleeps } = makeFetcher(
      fakeFetch({
        [`${ORIGIN}/robots.txt`]: { status: 200, body: "User-agent: *\nDisallow: /gizli\n" },
        [`${ORIGIN}/acik`]: { status: 200, body: "ok" },
      }),
    );
    await fetcher.loadRobots();
    expect(await fetcher.get(`${ORIGIN}/gizli/x`)).toMatchObject({ reason: "robots-disallowed" });
    expect(fetcher.requestCount).toBe(1);
    await fetcher.get(`${ORIGIN}/acik`);
    expect(sleeps.length).toBeGreaterThanOrEqual(0);
    expect(fetcher.requestCount).toBe(2);
  });

  it("istek butcesi dolunca durur", async () => {
    const fetcher = new PoliteFetcher({
      userAgent: "TestBot/1.0",
      origin: ORIGIN,
      maxRequests: 1,
      minIntervalMs: 0,
      fetchImpl: fakeFetch({ [`${ORIGIN}/robots.txt`]: { status: 200, body: "" } }),
    });
    await fetcher.loadRobots();
    expect(await fetcher.get(`${ORIGIN}/x`)).toMatchObject({ reason: "budget-exhausted" });
  });
});

describe("discoverHepsiburada (sentetik sayfalarla uctan uca)", () => {
  it("arama -> urun sayfasi -> ilgili urunleri dondurur, ilgisizi eler", async () => {
    const q = encodeURIComponent("Telefon 16 Pro 128 GB");
    const { fetcher } = makeFetcher(
      fakeFetch({
        [`${ORIGIN}/robots.txt`]: { status: 200, body: "User-agent: *\nAllow: /\n" },
        [`${ORIGIN}/ara?q=${q}`]: {
          status: 200,
          body: `<a href="/test-telefon-p-HBC1">1</a><a href="/kilif-p-HBC2">2</a>`,
        },
        [`${ORIGIN}/test-telefon-p-HBC1`]: { status: 200, body: productHtml },
        [`${ORIGIN}/kilif-p-HBC2`]: {
          status: 200,
          body: jsonLd({ "@type": "Product", name: "Telefon Kilifi" }),
        },
      }),
    );
    const report = await discoverHepsiburada("Telefon 16 Pro 128 GB", fetcher, { maxProducts: 5 });
    expect(report.status).toBe("ok");
    expect(report.products).toHaveLength(1);
    expect(report.products[0]?.title).toBe("Test Telefon 16 Pro 128 GB");
  });
});
