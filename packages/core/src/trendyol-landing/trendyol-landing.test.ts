import { describe, expect, it } from "vitest";

import { discoverTrendyol, type Transport } from "./discover.ts";
import { parseLandingSitemap, resolveLandings } from "./landing-index.ts";
import { findSearchProps, listingProducts, priceTextToKurus } from "./listing.ts";
import { matchProduct } from "./match.ts";
import { parseRobots } from "./robots.ts";

// Sentetik veri; adres ve baslik bicimleri 2026-10-12 canli gozlemlerinden alindi.
const TY = "https://www.trendyol.com";
const sitemap = (paths: string[]) =>
  `<urlset>${paths.map((p) => `<url><loc>${TY}${p}</loc></url>`).join("")}</urlset>`;

const INDEX = parseLandingSitemap(
  sitemap([
    "/iphone-16-pro-cep-telefonu-x-c103498-a292-v10577551",
    "/iphone-16-pro-max-cep-telefonu-x-c103498-a292-v10577513",
    "/iphone-16-pro-ekran-koruyucu-x-c108663-a292-v10577551",
    "/iphone-14-pro-telefon-x-c104025-a292-v1195066",
    "/siyah-kadin-elbise-x-r14-g1-c56",
    "/siyah-elbise-x-r14-c56",
    "/adidas-x-b33",
    "/adidas-gri-x-b33-r4",
    "/samba-x-b187214",
  ]),
);

const ROBOTS = parseRobots(
  "User-agent: *\nDisallow: /sr?\nDisallow: /*-x-*-a*-v*?pi=\nAllow: /*-x-b*-c*-a*-v*\n",
  "ManiCepteBot",
);

function propsHtml(products: unknown[]): string {
  return `<html><script>window["__single-search-result__PROPS"]=${JSON.stringify({ data: { products } })};</script></html>`;
}

const item = (brand: string, name: string, price: string, path: string, category: string) => ({
  brand,
  name,
  price: { currency: "TL", currentText: price, discountedPriceText: price },
  image: `https://cdn.dsmcdn.com/x${path}.jpg`,
  url: `${path}?boutiqueId=61&merchantId=1`,
  category: { name: category },
});

describe("resolveLandings", () => {
  it("model ozniteligi sayfasini secer; Pro Max, aksesuar ve celisen sayi elenir", () => {
    const r = resolveLandings(INDEX, "iPhone 16 Pro 128 GB").map((c) => c.entry.path);
    expect(r[0]).toBe("/iphone-16-pro-cep-telefonu-x-c103498-a292-v10577551");
    expect(r.join(" ")).not.toMatch(/pro-max|ekran-koruyucu|iphone-14/);
  });
  it("renk + cinsiyet + kategori sayfasini secer", () => {
    expect(resolveLandings(INDEX, "Siyah kadın elbise")[0]?.entry.path).toBe(
      "/siyah-kadin-elbise-x-r14-g1-c56",
    );
  });
  it("model sayfasi yoksa marka sayfasina duser", () => {
    const r = resolveLandings(INDEX, "Adidas Samba").map((c) => c.entry.path);
    expect(r).toContain("/adidas-x-b33");
  });
  it("sorgu aksesuar istiyorsa aksesuar sayfasina izin verir", () => {
    expect(resolveLandings(INDEX, "iPhone 16 Pro ekran koruyucu")[0]?.entry.path).toBe(
      "/iphone-16-pro-ekran-koruyucu-x-c108663-a292-v10577551",
    );
  });
});

describe("matchProduct", () => {
  it("sayfanin kapsadigi sozcukler baslikta aranmaz", () => {
    const covered = ["siyah", "kadin", "elbise"];
    expect(
      matchProduct("Modafeminen Straplez Elbise Siyah", "Siyah kadın elbise", "Elbise", covered),
    ).toBe(true);
    expect(
      matchProduct("iPhone 16 Pro 256GB", "iPhone 16 Pro 128 GB", null, ["iphone", "16", "pro"]),
    ).toBe(false);
  });
  it("yenilenmis kategori, Turkce ekli aksesuar ve varyant elenir", () => {
    const q = "iPhone 16 Pro";
    expect(matchProduct("Apple iPhone 16 Pro 128GB", q, "Yenilenmiş Cep Telefonu")).toBe(false);
    expect(matchProduct("iPhone 16 Pro Desenli Silikon Telefon Kılıfı", q)).toBe(false);
    expect(matchProduct("Apple iPhone 16 Pro Max 256GB", q)).toBe(false);
  });
});

describe("listing", () => {
  it("gomulu nesneden fiyat (kurus), gorsel, temiz adres cikarir", () => {
    const html = propsHtml([
      item(
        "Apple",
        "iPhone 16 Pro 128GB Çöl Titanyum",
        "124.999",
        "/apple/iphone-16-pro-128gb-col-titanyum-p-857296094",
        "IOS Cep Telefonları",
      ),
    ]);
    const [p] = listingProducts(findSearchProps(html), "2026-10-12T00:00:00.000Z");
    expect(p).toMatchObject({
      title: "Apple iPhone 16 Pro 128GB Çöl Titanyum",
      priceKurus: 12_499_900,
      price: "124.999,00",
      currency: "TRY",
      productUrl: `${TY}/apple/iphone-16-pro-128gb-col-titanyum-p-857296094`,
      availability: "unknown",
    });
  });
  it("Turkce fiyat bicimleri", () => {
    expect(priceTextToKurus("187,64")).toBe(18_764);
    expect(priceTextToKurus("106.090,41")).toBe(10_609_041);
    expect(priceTextToKurus("yok")).toBeNull();
  });
  it("gomulu nesne yoksa bos doner", () => {
    expect(listingProducts(findSearchProps("<html></html>"), "t")).toEqual([]);
  });
});

describe("discoverTrendyol", () => {
  const pages: Record<string, string> = {
    [`${TY}/iphone-16-pro-cep-telefonu-x-c103498-a292-v10577551`]: propsHtml([
      item(
        "Apple",
        "iPhone 16 Pro 128GB Çöl Titanyum",
        "124.999",
        "/apple/a-p-1",
        "IOS Cep Telefonları",
      ),
      item("Apple", "iPhone 16 Pro 256GB Siyah", "130.000", "/apple/b-p-2", "IOS Cep Telefonları"),
      item("Apple", "iPhone 16 Pro 128GB", "90.000", "/apple/c-p-3", "Yenilenmiş Cep Telefonu"),
    ]),
  };
  const ok: Transport = async (url) => ({ status: pages[url] ? 200 : 404, body: pages[url] ?? "" });

  it("dogru sayfadan dogru urunu dondurur", async () => {
    const r = await discoverTrendyol({
      query: "iPhone 16 Pro 128 GB",
      index: INDEX,
      robots: ROBOTS,
      transport: ok,
    });
    expect(r.products.map((p) => p.productUrl)).toEqual([`${TY}/apple/a-p-1`]);
  });

  it("403'te durur ve baska istek atmaz", async () => {
    const calls: string[] = [];
    const blocked: Transport = async (url) => {
      calls.push(url);
      return { status: 403, body: "" };
    };
    const r = await discoverTrendyol({
      query: "Adidas Samba",
      index: INDEX,
      robots: ROBOTS,
      transport: blocked,
    });
    expect(r.products).toEqual([]);
    expect(r.stoppedBecause).toMatch(/403/);
    expect(calls).toHaveLength(1);
  });

  it("arama yolunu (/sr) asla istemez", async () => {
    const calls: string[] = [];
    await discoverTrendyol({
      query: "Siyah kadın elbise",
      index: INDEX,
      robots: ROBOTS,
      transport: async (u) => {
        calls.push(u);
        return { status: 404, body: "" };
      },
    });
    expect(calls.some((u) => u.includes("/sr"))).toBe(false);
  });
});

describe("canli testte (2026-10-12) gorulen hatalar", () => {
  it("-li/-suz sifatlari aksesuar sayilmaz", () => {
    const sony = "Sony Wh-1000xm5 Tamamen Kablosuz Gürültü Engelleme Özellikli";
    expect(matchProduct(sony, "Sony WH-1000XM5", "Kulak üstü Bluetooth Kulaklık")).toBe(true);
    expect(matchProduct("Dyson V15 Şarjlı Dikey Süpürge", "Dyson V15")).toBe(true);
    expect(matchProduct("Bosch Çamaşır Makinesi 9 kg", "Bosch çamaşır makinesi")).toBe(true);
    expect(matchProduct("Sony WH-1000XM5 Şarj Kablosu", "Sony WH-1000XM5")).toBe(false);
  });
  it("arama terimi sayfasi (-y-s) sayfa kapsami vermez", async () => {
    const index = parseLandingSitemap(sitemap(["/sony-wh-1000xm5-kulaklik-y-s76666"]));
    const page = `${TY}/sony-wh-1000xm5-kulaklik-y-s76666`;
    const html = propsHtml([
      item(
        "Sony",
        "WF-1000XM5 Kulak İçi Bluetooth Kulaklık",
        "9.999",
        "/sony/wf-p-1",
        "Kulak İçi Bluetooth Kulaklık",
      ),
      item(
        "Sony",
        "Wh-1000xm5 Kablosuz Kulaklık",
        "12.999",
        "/sony/wh-p-2",
        "Kulak üstü Bluetooth Kulaklık",
      ),
    ]);
    const r = await discoverTrendyol({
      query: "Sony WH-1000XM5",
      index,
      robots: ROBOTS,
      transport: async (u) => ({ status: u === page ? 200 : 404, body: u === page ? html : "" }),
    });
    expect(r.products.map((p) => p.productUrl)).toEqual([`${TY}/sony/wh-p-2`]);
  });
});

describe("listing kimlik hiyerarsisi (canli bicim 2026-10-12)", () => {
  it("contentId, groupId, supplierId ve varyanti tasir", () => {
    const html = propsHtml([
      {
        ...item(
          "Apple",
          "iPhone 16 Pro 128GB Çöl Titanyum",
          "124.999",
          "/apple/iphone-16-pro-128gb-col-titanyum-p-857296094",
          "IOS Cep Telefonları",
        ),
        url: "/apple/iphone-16-pro-128gb-col-titanyum-p-857296094?boutiqueId=61&merchantId=724838",
        groupId: 653969108,
        variantValue: "Tek Ebat",
      },
    ]);
    const [p] = listingProducts(findSearchProps(html), "t");
    expect(p).toMatchObject({
      contentId: "857296094",
      groupId: "653969108",
      supplierId: "724838",
      variant: "Tek Ebat",
    });
  });
});
