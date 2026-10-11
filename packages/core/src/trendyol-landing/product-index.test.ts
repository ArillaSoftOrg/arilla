import { describe, expect, it } from "vitest";

import { ProductIndex, parseProductSitemap, slugTitle } from "./product-index.ts";

// Sentetik; bicim sitemap_products337.xml (2026-10-12) ile ayni.
const url = (path: string, img = true) =>
  `<url><loc>https://www.trendyol.com/${path}</loc>${
    img
      ? `<image:image><image:loc>https://cdn.dsmcdn.com/ty1/${path.length}.jpg</image:loc><image:title>x</image:title></image:image>`
      : ""
  }</url>`;

const XML = `<urlset>${[
  url("apple/iphone-16-pro-128gb-col-titanyum-p-857296094"),
  url("apple/iphone-16-pro-max-256gb-siyah-p-857296077"),
  url("apple/iphone-16-pro-128gb-siyah-titanyum-p-857296083", false),
  url("kvk-privacy/iphone-16-pro-uyumlu-silikon-kilif-p-1164848392"),
  url("adidas/samba-og-unisex-beyaz-spor-ayakkabi-p-123"),
  url("samba/kadin-terlik-p-456"),
  url("nike/air-force-1-07-erkek-beyaz-sneaker-p-789"),
  url("air-force/erkek-mont-p-790"),
].join("")}</urlset>`;

describe("parseProductSitemap", () => {
  it("adres ve ilk CDN gorselini okur, gecersiz adresleri atar", () => {
    const items = parseProductSitemap(
      `${XML}<url><loc>https://www.trendyol.com/kategori-x-c1</loc></url>`,
    );
    expect(items).toHaveLength(8);
    expect(items[0]?.imageUrl).toMatch(/^https:\/\/cdn\.dsmcdn\.com\//);
    expect(items[2]?.imageUrl).toBeNull();
  });
});

describe("slugTitle", () => {
  it("slug'dan baslik uretir", () => {
    expect(slugTitle("apple/iphone-16-pro-128gb-col-titanyum-p-857296094")).toEqual({
      brand: "Apple",
      title: "Iphone 16 Pro 128GB Col Titanyum",
    });
  });
});

describe("ProductIndex.search", () => {
  const index = new ProductIndex();
  index.add(parseProductSitemap(XML));

  it("model + depolama eslesir; Pro Max ve aksesuar elenir; fiyat uydurulmaz", () => {
    const r = index.search("iPhone 16 Pro 128 GB");
    expect(r.map((p) => p.productUrl)).toEqual([
      "https://www.trendyol.com/apple/iphone-16-pro-128gb-col-titanyum-p-857296094",
      "https://www.trendyol.com/apple/iphone-16-pro-128gb-siyah-titanyum-p-857296083",
    ]);
    expect(r[0]).toMatchObject({ price: null, currency: null });
    expect(r[0]?.missing).toContain("price");
    expect(r[1]?.missing).toContain("imageUrl");
  });

  it("marka + model: baska markanin ayni adli urunu gelmez", () => {
    expect(index.search("Adidas Samba").map((p) => p.brand)).toEqual(["Adidas"]);
    expect(index.search("Nike Air Force 1").map((p) => p.brand)).toEqual(["Nike"]);
  });

  it("eslesme yoksa bos doner", () => {
    expect(index.search("Sony WH-1000XM5")).toEqual([]);
  });
});
