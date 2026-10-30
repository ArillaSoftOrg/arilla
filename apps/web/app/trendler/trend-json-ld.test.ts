import { serializeJsonLd } from "@arilla/core";
import { describe, expect, it } from "vitest";
import { trendJsonLd, trendPath } from "./trend-json-ld.ts";

const SITE = "https://manicepte.com";
const INPUT = {
  siteUrl: SITE,
  trend: { slug: "kis-montlari", title: "Kış montları" },
  products: [
    { slug: "uzun-mont", title: "Uzun mont" },
    { slug: "sisme-yelek", title: "Şişme yelek" },
    { slug: "kapusonlu-parka", title: "Kapüşonlu parka" },
  ],
};

describe("trendJsonLd", () => {
  const [breadcrumb, itemList] = trendJsonLd(INPUT);

  it("BreadcrumbList: site → Trendler → trend, mutlak adreslerle", () => {
    expect(breadcrumb).toEqual({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "ManiCepte", item: `${SITE}/` },
        { "@type": "ListItem", position: 2, name: "Trendler", item: `${SITE}/trendler` },
        {
          "@type": "ListItem",
          position: 3,
          name: "Kış montları",
          item: `${SITE}/trendler/kis-montlari`,
        },
      ],
    });
  });

  it("ItemList: yalnız verilen ürünler, aynı sırayla, konum/ad/adres", () => {
    expect(itemList).toMatchObject({
      "@type": "ItemList",
      name: "Kış montları",
      url: `${SITE}/trendler/kis-montlari`,
      numberOfItems: 3,
    });
    expect(itemList?.itemListElement).toEqual([
      { "@type": "ListItem", position: 1, name: "Uzun mont", url: `${SITE}/urun/uzun-mont` },
      { "@type": "ListItem", position: 2, name: "Şişme yelek", url: `${SITE}/urun/sisme-yelek` },
      {
        "@type": "ListItem",
        position: 3,
        name: "Kapüşonlu parka",
        url: `${SITE}/urun/kapusonlu-parka`,
      },
    ]);
  });

  it("fiyat, marka, stok, puan ya da değerlendirme uydurulmaz", () => {
    const text = JSON.stringify(trendJsonLd(INPUT));
    for (const key of [
      "offers",
      "price",
      "brand",
      "availability",
      "aggregateRating",
      "review",
      "Product",
    ]) {
      expect(text).not.toContain(`"${key}`);
    }
  });

  it("site adresi yoksa hiç veri üretilmez (göreli adres yazılmaz)", () => {
    expect(trendJsonLd({ ...INPUT, siteUrl: undefined })).toEqual([]);
  });

  it("adres kesimleri yüzde-kodlanır; başlık betik bloğunu kapatamaz", () => {
    const [, list] = trendJsonLd({
      ...INPUT,
      trend: { slug: "kis", title: "</script><script>alert(1)</script>" },
      products: [{ slug: "a/../../yonetim?x=1#y", title: "Ürün" }],
    });
    expect(list?.itemListElement).toEqual([
      expect.objectContaining({ url: `${SITE}/urun/a%2F..%2F..%2Fyonetim%3Fx%3D1%23y` }),
    ]);
    const html = serializeJsonLd(list);
    expect(html).not.toContain("</script>");
    expect(JSON.parse(html).name).toBe("</script><script>alert(1)</script>");
  });

  it("trendPath kanonik adresle aynı biçim", () => {
    expect(trendPath("kis-montlari")).toBe("/trendler/kis-montlari");
  });
});
