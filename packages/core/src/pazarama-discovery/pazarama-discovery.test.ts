/**
 * HTML/XML girdileri SENTETIKTIR: canli Pazarama sayfalarinda (2026-10-12) gozlenen
 * YAPIYI taklit eder; gercek urun verisi icermez ve canli calistigini kanitlamaz.
 */

import { describe, expect, it } from "vitest";
import { discoverPazarama, normalizeProductId } from "./combined.ts";
import {
  isAllowedPazaramaUrl,
  lookupByBarcodes,
  PazaramaClient,
  searchSeoPages,
  verifyCards,
} from "./discover.ts";
import {
  barcodeProductUrl,
  DETAIL_STOP,
  LISTING_STOP,
  parseBasketPrice,
  parseColor,
  parseListingCards,
  parseListingTotal,
  parseProductPage,
  trPriceToKurus,
} from "./parse.ts";
import { buildEvidence, loadSeoIndex, rankSeoPages, sitemapPaths } from "./seo-index.ts";

describe("Faz 2: guvenlik", () => {
  it("yalnizca pazarama.com ve robots'un izin verdigi yollar", () => {
    expect(isAllowedPazaramaUrl("https://www.pazarama.com/x-p-1")).toBe(true);
    expect(
      isAllowedPazaramaUrl("https://www.pazarama.com/apple/cep-telefonu-k-K03043?sayfa=2"),
    ).toBe(true);
    for (const bad of [
      "https://www.pazarama.com/arama?q=x",
      "https://www.pazarama.com/search/x",
      "https://www.pazarama.com/developer/a",
      "https://www.pazarama.com/a-k-K1?isplus=1",
      "http://www.pazarama.com/x",
      "https://user:pw@www.pazarama.com/x",
      "https://www.pazarama.com:8443/x",
      "https://evil.example/x",
      "https://www.pazarama.com.evil.example/x",
    ]) {
      expect(isAllowedPazaramaUrl(bad), bad).toBe(false);
    }
  });

  it("baska alan adina yonlendirme izlenmez; ayni alan adi icinde en cok 3 adim", async () => {
    const calls: string[] = [];
    const client = new PazaramaClient({
      userAgent: "TestBot/1.0",
      minIntervalMs: 0,
      maxRequests: 10,
      fetchImpl: async (url) => {
        calls.push(url);
        const loc = url.endsWith("/-p-1")
          ? "/canonical-p-1"
          : url.endsWith("/-p-2")
            ? "https://evil.example/x"
            : null;
        return {
          status: loc ? 301 : 200,
          headers: { get: (n: string) => (n === "location" ? loc : null) },
          text: async () => "ok",
        };
      },
    });
    const ok = await client.get("https://www.pazarama.com/-p-1");
    expect(ok).toMatchObject({ status: 200, finalUrl: "https://www.pazarama.com/canonical-p-1" });
    const off = await client.get("https://www.pazarama.com/-p-2");
    expect(off).toMatchObject({ status: 301, body: "" });
    expect(calls).not.toContain("https://evil.example/x");
  });
});

describe("Faz 2: kanitla SEO sayfasi secimi (canli dizinden ornek yollar)", () => {
  const paths = loadSeoIndex(
    [
      "# pazarama-seo-index v1",
      "/apple/cep-telefonu-k-K03043",
      "/apple/yenilenmis-cep-telefonu-k-K03046",
      "/apple/cep-telefonu-aksesuar-yedek-parca-k-K03053",
      "/apple/bluetooth-kulaklik-k-K03009",
      "/sony/sony-k-K09195",
      "/sony/kulaklik-k-K03029",
      "/sony/bluetooth-kulaklik-k-K03009",
      "/sony/oyun-konsolu-k-K04011",
      "/nike/erkek-sneaker-ayakkabi-k-K02021",
      "/nike/kadin-sneaker-ayakkabi-k-K02045",
      "/air/kadin-sneaker-ayakkabi-k-K02045",
      "/dyson/dikey-supurge-k-K05001",
      "/dyson/supurge-yedek-parca-k-K05002",
      "/elbise-k-K08100",
      "/elbise-k-K08100?renk=siyah&ft",
      "/elbise-k-K08100?renk=kirmizi&ft",
      "/kilif-k-K03028?model=iphone-16-pro&ft",
      // Canli dizindeki tuzaklar: "pro" ve "siyah" ayri markalardir.
      "/pro/cep-telefonu-k-K03043",
      "/siyah/kadin-elbise-k-K08101",
    ].join("\n"),
  );

  it("marka eslesen basliklardan cikar (takma ad gerekmez), aksesuar/yenilenmis elenir", () => {
    const ev = buildEvidence(
      "iPhone 16 Pro 128 GB",
      ["Apple iPhone 16 Pro 128GB Çöl Titanyum", "Apple iPhone 16 Pro 128GB Siyah"],
      ["Cep Telefonu"],
    );
    expect(rankSeoPages("iPhone 16 Pro 128 GB", paths, ev).map((c) => c.path)).toEqual([
      "/apple/cep-telefonu-k-K03043",
    ]);
  });

  it("kulaklik kaniti Sony'de kulaklik sayfalarini secer, konsolu secmez", () => {
    const ev = buildEvidence(
      "Sony WH-1000XM5",
      ["Sony WH-1000XM5 Kulak Üstü Bluetooth Kulaklık"],
      [],
    );
    expect(rankSeoPages("Sony WH-1000XM5", paths, ev).map((c) => c.path)).toEqual([
      "/sony/bluetooth-kulaklik-k-K03009",
      "/sony/kulaklik-k-K03029",
    ]);
  });

  it("PlayStation: oyun konsolu kaniti ile Sony konsol sayfasi", () => {
    const ev = buildEvidence(
      "PlayStation 5",
      ["Sony Playstation 5 Slim Digital Oyun Konsolu", "Sony PlayStation 5 Oyun Konsolu"],
      ["Oyun Konsolları"],
    );
    expect(rankSeoPages("PlayStation 5", paths, ev)[0]?.path).toBe("/sony/oyun-konsolu-k-K04011");
  });

  it("Dyson: yedek parca kategorisi elenir", () => {
    const ev = buildEvidence("Dyson V15", ["Dyson V15 Detect Absolute Kablosuz Süpürge"], []);
    expect(rankSeoPages("Dyson V15", paths, ev).map((c) => c.path)).toEqual([
      "/dyson/dikey-supurge-k-K05001",
    ]);
  });

  it("markasiz sorgu: kategori + sorguda gecen filtre degeri", () => {
    const ev = buildEvidence("Siyah kadın elbise", ["Avver Kadın Siyah Şifon Elbise"], ["Elbise"]);
    expect(rankSeoPages("Siyah kadın elbise", paths, ev)[0]?.path).toBe(
      "/elbise-k-K08100?renk=siyah&ft",
    );
  });

  it("cocuk kategorisi sorguda istenmedikce yetiskin sneaker sayfalarinin onune gecmez", () => {
    const samba = [
      "/adidas/kadin-sneaker-ayakkabi-k-K02045",
      "/adidas/erkek-sneaker-ayakkabi-k-K02021",
      "/adidas/kiz-cocuk-spor-ayakkabi-sneaker-k-K02057",
    ];
    const ev = buildEvidence(
      "Adidas Samba",
      ["adidas Samba OG FA24 Kadın Spor Ayakkabı", "adidas Samba OG Unisex Siyah Spor Ayakkabı"],
      ["Spor ve Outdoor", "Spor Ayakkabı", "Sneaker"],
    );
    const ranked = rankSeoPages("Adidas Samba", samba, ev).map((c: { path: string }) => c.path);
    // Faz 3: cinsiyet sozcukleri notr -> kadin ve erkek esit, ikisi de cocuktan once.
    expect(ranked.slice(0, 2).sort()).toEqual([
      "/adidas/erkek-sneaker-ayakkabi-k-K02021",
      "/adidas/kadin-sneaker-ayakkabi-k-K02045",
    ]);
    expect(ranked.indexOf("/adidas/kiz-cocuk-spor-ayakkabi-sneaker-k-K02057")).not.toBeLessThan(2);
  });

  it("HB ust duzey faseti yalnizca derin kategori yoksa ve zayif kanit olarak kullanilir", () => {
    const shoes = [
      "/adidas/kadin-sneaker-ayakkabi-k-K02045",
      "/adidas/erkek-sneaker-ayakkabi-k-K02021",
      "/adidas/outdoor-ayakkabi-k-K10273",
    ];
    const samba = buildEvidence(
      "Adidas Samba",
      ["adidas Samba OG Kadın Spor Ayakkabı", "adidas Samba OG Unisex Spor Ayakkabı"],
      ["Spor Ayakkabı", "Sneaker"],
      ["Spor / Outdoor"],
    );
    expect(
      rankSeoPages("Adidas Samba", shoes, samba)
        .slice(0, 2)
        .map((c) => c.path),
    ).not.toContain("/adidas/outdoor-ayakkabi-k-K10273");
    const phones = ["/apple/cep-telefonu-k-K03043", "/apple/akilli-saat-k-K03004"];
    const iphone = buildEvidence(
      "iPhone 16 Pro 128 GB",
      ["Apple iPhone 16 Pro 128GB Çöl Titanyum", "Apple iPhone 16 Pro 128GB Siyah"],
      [],
      ["Telefon"],
    );
    expect(rankSeoPages("iPhone 16 Pro 128 GB", phones, iphone)[0]?.path).toBe(
      "/apple/cep-telefonu-k-K03043",
    );
  });

  it("2. canli tur hatalari: sayi, tur niteleyicisi, bos filtre, marka tercihi, secenek listesi", () => {
    const live = [
      "/sony/playstation-4-konsol-k-K09021",
      "/sony/playstation-5-konsol-k-K09018",
      "/playstation-5-konsol-k-K09018?urun-turu=playstation-5&ft",
      "/kadin-takim-elbise-k-K08187?renk=siyah&ft",
      "/abiye-elbise-k-K08109?mevsim=elbise&ft",
      "/abiye-elbise-k-K08109?renk=siyah&ft",
      "/gunluk-elbise-k-K08110?renk=siyah&ft",
      "/elektronova-k-K12524",
      "/dyson/supurge-k-K04134",
    ];
    const ps5 = buildEvidence(
      "PlayStation 5",
      ["Sony Playstation 5 Slim Digital Oyun Konsolu", "Sony PlayStation 5 Slim Oyun Konsolu"],
      ["Oyun Konsolları"],
    );
    expect(rankSeoPages("PlayStation 5", live, ps5).map((c) => c.path)).not.toContain(
      "/sony/playstation-4-konsol-k-K09021",
    );
    const dress = buildEvidence(
      "Siyah kadın elbise",
      ["Avver Kadın Siyah Şifon Elbise", "Kadın Siyah Mini Elbise"],
      ["Elbise, Tunik, Abiye"],
    );
    const dressPages = rankSeoPages("Siyah kadın elbise", live, dress).map((c) => c.path);
    expect(dressPages.some((p) => p.includes("takim"))).toBe(false);
    expect(dressPages).not.toContain("/abiye-elbise-k-K08109?mevsim=elbise&ft");
    expect(new Set(dressPages.map((p) => p.split("?")[0])).size).toBe(dressPages.length);
    const dyson = buildEvidence(
      "Dyson V15",
      ["Dyson V15 Detect Absolute Kablosuz Süpürge", "Dyson V15 Detect Kablosuz Süpürge"],
      ["Ev Elektroniği"],
    );
    expect(rankSeoPages("Dyson V15", live, dyson)[0]?.path).toBe("/dyson/supurge-k-K04134");
  });

  it("eslesen baslik yoksa CS sayfa kategorileri kanit sayilmaz (canli: 'Akilli Saat' secilmisti)", () => {
    const withAkilliSaat = [...paths, "/akilli-saat-k-K03004", "/cep-telefonu-k-K03043"];
    const ev = buildEvidence(
      "iPhone 16 Pro 128 GB",
      [],
      ["Elektronik", "Cep Telefonu & Aksesuar", "Giyilebilir Teknoloji", "Akıllı Saat"],
    );
    expect(rankSeoPages("iPhone 16 Pro 128 GB", withAkilliSaat, ev)).toEqual([]);
  });
});

describe("Faz 2: birlesik kesif", () => {
  const O2 = "https://www.pazarama.com";
  const page = (name: string, price: number | null, stock = true) =>
    `<script type="application/ld+json">${JSON.stringify({
      "@type": "Product",
      name,
      image: "https://img.pzrmcdn.com/a.png",
      offers: {
        price,
        priceCurrency: "TRY",
        seller: "S",
        availability: `https://schema.org/${stock ? "InStock" : "OutOfStock"}`,
      },
    })}</script>`;

  function clientFor(routes: Record<string, { status: number; body: string; location?: string }>) {
    return new PazaramaClient({
      userAgent: "TestBot/1.0",
      minIntervalMs: 0,
      maxRequests: 30,
      fetchImpl: async (url) => {
        const r = routes[url] ?? { status: 404, body: "" };
        return {
          status: r.status,
          headers: { get: () => r.location ?? null },
          text: async () => r.body,
        };
      },
    });
  }

  it("barkod + SEO birlesir, tekrar kaldirilir; yanlis varyant ve stoksuz elenir", async () => {
    const client = clientFor({
      [`${O2}/-p-11111111`]: { status: 301, body: "", location: "/ornek-siyah-p-11111111" },
      [`${O2}/ornek-siyah-p-11111111`]: {
        status: 200,
        body: page("Ornek Telefon 16 Pro 128 GB Siyah", 1000),
      },
      [`${O2}/-p-22222222`]: { status: 200, body: page("Ornek Telefon 16 Pro Max 128 GB", 1200) },
      [`${O2}/-p-33333333`]: {
        status: 200,
        body: page("Ornek Telefon 16 Pro 128 GB Beyaz", 900, false),
      },
      [`${O2}/ornek/cep-telefonu-k-K1`]: {
        status: 200,
        body:
          `<a href="/ornek-siyah-p-11111111" title="Ornek Telefon 16 Pro 128 GB Siyah">x</a><span>9,00 TL</span>` +
          `<a href="/ornek-mavi-p-44444444" title="Ornek Telefon 16 Pro 128 GB Mavi">x</a><span>11,00 TL</span>`,
      },
      [`${O2}/ornek-mavi-p-44444444`]: {
        status: 200,
        body: page("Ornek Telefon 16 Pro 128 GB Mavi", 1100),
      },
    });
    const report = await discoverPazarama(
      client,
      {
        query: "Ornek Telefon 16 Pro 128 GB",
        gtins: ["11111111", "22222222", "33333333"],
        matchedTitles: ["Ornek Telefon 16 Pro 128 GB"],
        categoryNames: ["Cep Telefonu"],
      },
      ["/ornek/cep-telefonu-k-K1", "/ornek/cep-telefonu-yedek-parca-k-K2"],
    );
    expect(report.seoPages.map((p) => p.path)).toEqual(["/ornek/cep-telefonu-k-K1"]);
    expect(report.results.map((r) => [r.productId, r.priceKurus, r.via.join("+")])).toEqual([
      ["11111111", 100000, "barcode+seo"],
      ["44444444", 110000, "seo"],
    ]);
    expect(report.results[0]?.productUrl).toBe(`${O2}/ornek-siyah-p-11111111`);
    expect(report.barcode.rejected.map((r) => r.gtin)).toEqual(["22222222", "33333333"]);
    // Liste karti fiyati (9,00 / 11,00 TL) hicbir sonuca gecmedi.
    expect(report.results.every((r) => r.priceKurus >= 100000)).toBe(true);
  });

  it("403 gelirse iki yol da durur, o ana kadarki dogrulanmis sonuc korunur", async () => {
    const client = clientFor({
      [`${O2}/-p-11111111`]: { status: 200, body: page("Ornek Telefon 16 Pro 128 GB Siyah", 1000) },
      [`${O2}/-p-22222222`]: { status: 403, body: "" },
    });
    const report = await discoverPazarama(
      client,
      {
        query: "Ornek Telefon 16 Pro 128 GB",
        gtins: ["11111111", "22222222", "33333333"],
        matchedTitles: [],
        categoryNames: [],
      },
      ["/ornek/cep-telefonu-k-K1"],
    );
    expect(report.blockedBy).toBe(403);
    expect(report.results.map((r) => r.productId)).toEqual(["11111111"]);
    // Faz 3: A ve B eszamanli; 403'ten once baslamis istek olabilir, ama 403'ten SONRA
    // hicbir yeni istek baslamaz (ucuncu barkod hic istenmez).
    expect(client.log.map((l) => l.url)).not.toContain(`${O2}/-p-33333333`);
    expect(client.log.length).toBeLessThanOrEqual(3);
  });
});
const O = "https://www.pazarama.com";

function card(path: string, title: string, prices: string[], img = true): string {
  return `<a href="${path}" title="${title}" class="flex"><div class="relative">${
    img ? `<img src="https://img.pzrmcdn.com/mnresize/452/448/asset/x/a.jpg" alt="">` : ""
  }</div>${prices.map((p) => `<span>${p} TL</span>`).join("")}</a>`;
}

function productPage(
  offers: Record<string, unknown>,
  name = "Ornek Telefon 16 Pro 128 GB",
): string {
  const ld = {
    "@context": "https://schema.org",
    "@type": "Product",
    name,
    image: ["https://img.pzrmcdn.com/a.png"],
    offers,
  };
  return `<html><script type="application/ld+json">${JSON.stringify(ld)}</script></html>`;
}

describe("parse", () => {
  it("TR fiyat metnini kurusa cevirir", () => {
    expect(trPriceToKurus("73.329,00")).toBe(7332900);
    expect(trPriceToKurus("247,19")).toBe(24719);
    expect(trPriceToKurus("1.2,00")).toBeNull();
  });

  it("liste kartlarini okur; son fiyat satis fiyatidir, tekrarlar atlanir", () => {
    const html =
      card("/ornek-telefon-p-195900000001", "Ornek Telefon 16 Pro 128 GB", [
        "73.329,00",
        "73.000,00",
      ]) +
      card("/ornek-telefon-p-195900000001", "Ornek Telefon 16 Pro 128 GB", ["73.000,00"]) +
      card("/kilif-p-ABC12", "Ornek Kilif &amp; Kapak", [], false);
    expect(parseListingCards(html)).toEqual([
      {
        title: "Ornek Telefon 16 Pro 128 GB",
        priceKurus: 7300000,
        imageUrl: "https://img.pzrmcdn.com/mnresize/452/448/asset/x/a.jpg",
        productUrl: `${O}/ornek-telefon-p-195900000001`,
        productId: "195900000001",
      },
      {
        title: "Ornek Kilif & Kapak",
        priceKurus: null,
        imageUrl: null,
        productUrl: `${O}/kilif-p-ABC12`,
        productId: "ABC12",
      },
    ]);
  });

  it("urun sayfasi: stoktaysa fiyat, stokta degilse fiyat null", () => {
    const inStock = parseProductPage(
      productPage({
        price: 126500,
        priceCurrency: "TRY",
        availability: "https://schema.org/InStock",
        seller: "Ornek Satici",
      }),
    );
    expect(inStock).toMatchObject({
      priceKurus: 12650000,
      availability: "in_stock",
      seller: "Ornek Satici",
    });
    const oos = parseProductPage(
      productPage({
        price: 76499,
        priceCurrency: "TRY",
        availability: "https://schema.org/OutOfStock",
      }),
    );
    expect(oos).toMatchObject({ priceKurus: null, availability: "out_of_stock" });
    expect(parseProductPage("<html></html>")).toBeNull();
  });

  it("barkod adresi: gecerli barkod, uydurma/doldurma barkod reddedilir", () => {
    expect(barcodeProductUrl("0195949771569")).toBe(`${O}/-p-0195949771569`);
    expect(barcodeProductUrl("4548736132597")).toBe(`${O}/-p-4548736132597`);
    expect(barcodeProductUrl("0000659455656")).toBeNull();
    expect(barcodeProductUrl("934583809031482")).toBeNull();
    expect(barcodeProductUrl("abc")).toBeNull();
  });
});

describe("seo-index", () => {
  const paths = sitemapPaths(
    `<urlset><url><loc>${O}/apple/cep-telefonu-k-K03043</loc></url>
     <url><loc>${O}/apple/cep-telefonu-yedek-parcalari-k-K03013</loc></url>
     <url><loc>${O}/apple/kulaklik-k-K03029</loc></url>
     <url><loc>${O}/sony/bluetooth-kulaklik-k-K03009</loc></url>
     <url><loc>${O}/adidas/erkek-sneaker-ayakkabi-k-K02021</loc></url>
     <url><loc>${O}/kilif-k-K03028?model=iphone-16-pro&amp;ft</loc></url>
     <url><loc>https://baska.example/x</loc></url></urlset>`,
    O,
  );

  it("sitemap yollarini ayiklar", () => {
    expect(paths).toContain("/kilif-k-K03028?model=iphone-16-pro&ft");
    expect(paths).not.toContain("https://baska.example/x");
  });

  it("eski elle-ipucu testlerinin kanitli karsiligi: marka sozcugu puanlanmaz, durum kategorisi atlanir", () => {
    const live = [
      "/sony/sony-k-K09195",
      "/sony/kulaklik-k-K03029",
      "/sony/bluetooth-kulaklik-k-K03009",
      "/air/kadin-sneaker-ayakkabi-k-K02045",
      "/nike/erkek-sneaker-ayakkabi-k-K02021",
      "/apple/yenilenmis-cep-telefonu-k-K03046",
      "/apple/cep-telefonu-k-K03043",
    ];
    const sony = buildEvidence(
      "Sony WH-1000XM5",
      ["Sony WH-1000XM5 Bluetooth Kulaklık", "Sony WH-1000XM5 Kulaklık"],
      [],
    );
    expect(rankSeoPages("Sony WH-1000XM5", live, sony).map((c) => c.path)).toEqual([
      "/sony/bluetooth-kulaklik-k-K03009",
      "/sony/kulaklik-k-K03029",
    ]);
    const nike = buildEvidence(
      "Nike Air Force 1",
      ["Nike Air Force 1 Sneaker", "Nike Air Force 1 07 Sneaker"],
      [],
    );
    expect(rankSeoPages("Nike Air Force 1", live, nike).map((c) => c.path)).toEqual([
      "/nike/erkek-sneaker-ayakkabi-k-K02021",
    ]);
    const iphone = buildEvidence(
      "iPhone 16 Pro",
      ["Apple iPhone 16 Pro Cep Telefonu", "Apple iPhone 16 Pro"],
      [],
    );
    expect(rankSeoPages("iPhone 16 Pro", live, iphone).map((c) => c.path)).toEqual([
      "/apple/cep-telefonu-k-K03043",
    ]);
  });
});

describe("PazaramaClient ve kesif", () => {
  function fakeClient(routes: Record<string, { status: number; body: string }>) {
    const calls: string[] = [];
    const client = new PazaramaClient({
      userAgent: "TestBot/1.0",
      minIntervalMs: 1000,
      maxRequests: 10,
      sleep: async () => {},
      fetchImpl: async (url) => {
        calls.push(url);
        const r = routes[url] ?? { status: 404, body: "" };
        return { status: r.status, text: async () => r.body };
      },
    });
    return { client, calls };
  }

  it("barkodla bulur, 404'u ve uydurma barkodu atlar", async () => {
    const { client, calls } = fakeClient({
      [`${O}/-p-0195949771187`]: {
        status: 200,
        body: productPage({
          price: 126500,
          priceCurrency: "TRY",
          availability: "https://schema.org/InStock",
        }),
      },
    });
    const hits = await lookupByBarcodes(client, [
      "0195949771187",
      "4548736134294",
      "0000659455656",
    ]);
    expect(hits.map((h) => h.gtin)).toEqual(["0195949771187"]);
    expect(calls).toHaveLength(2);
  });

  it("403 sonrasi durur ve baska istek atmaz", async () => {
    const { client, calls } = fakeClient({ [`${O}/-p-4548736132597`]: { status: 403, body: "" } });
    await lookupByBarcodes(client, ["4548736132597", "4548736132580"]);
    expect(calls).toHaveLength(1);
    expect(client.blockedBy).toBe(403);
  });

  it("robots'un yasakladigi arama yoluna istek atmaz", async () => {
    const { client } = fakeClient({});
    await expect(client.get(`${O}/arama?q=x`)).rejects.toThrow(/robots/);
  });

  it("SEO sayfasi + izinli sayfalama: yalnizca fiyatli ve kati eslesen kartlar", async () => {
    const path = "/sony/bluetooth-kulaklik-k-K03009";
    const { client, calls } = fakeClient({
      [`${O}${path}`]: {
        status: 200,
        body:
          card("/sony-xm5-p-4548736132597", "Sony WH-1000XM5 Kablosuz Kulaklık", [
            "17.900,00",
            "16.900,00",
          ]) + card("/sony-xm4-p-4548736112345", "Sony WH-1000XM4 Kulaklık", ["9.999,00"]),
      },
      [`${O}${path}?sayfa=2`]: {
        status: 200,
        body: card("/xm5-ped-p-ABC", "Sony WH-1000XM5 Uyumlu Kulaklık Pedi", ["399,00"]),
      },
    });
    const out = await searchSeoPages(client, "Sony WH-1000XM5", [path], { pagesPerPath: 2 });
    expect(out.map((c) => c.title)).toEqual(["Sony WH-1000XM5 Kablosuz Kulaklık"]);
    expect(out[0]?.priceKurus).toBe(1690000);
    expect(calls).toEqual([`${O}${path}`, `${O}${path}?sayfa=2`]);
  });

  it("kart fiyati urun sayfasiyla dogrulanir; stoksuz kart elenir, fiyat sayfadan gelir", async () => {
    const { client } = fakeClient({
      [`${O}/a-p-111`]: {
        status: 200,
        body: productPage({
          price: 4799.4,
          priceCurrency: "TRY",
          availability: "https://schema.org/InStock",
        }),
      },
      [`${O}/b-p-222`]: {
        status: 200,
        body: productPage({ availability: "https://schema.org/OutOfStock" }),
      },
    });
    const cards = [
      {
        title: "A",
        priceKurus: 799900,
        imageUrl: null,
        productUrl: `${O}/a-p-111`,
        productId: "111",
      },
      {
        title: "B",
        priceKurus: 1690000,
        imageUrl: null,
        productUrl: `${O}/b-p-222`,
        productId: "222",
      },
    ];
    const out = await verifyCards(client, cards);
    expect(out.map((v) => [v.card.productId, v.page.priceKurus])).toEqual([["111", 479940]]);
  });
});

describe("Faz 3: sayfalama, erken durma, onbellek, hiz siniri", () => {
  const O3 = "https://www.pazarama.com";
  const detail = (name: string, price: number) =>
    `<script type="application/ld+json">${JSON.stringify({
      "@type": "Product",
      name,
      image: "https://img.pzrmcdn.com/a.png",
      offers: {
        price,
        priceCurrency: "TRY",
        seller: "S",
        availability: "https://schema.org/InStock",
      },
    })}</script>`;
  const card = (id: string, title: string) =>
    `<a href="/u-p-${id}" title="${title}">x</a><span>1,00 TL</span>`;

  function client(routes: Record<string, string>, calls: string[], minIntervalMs = 0) {
    return new PazaramaClient({
      userAgent: "TestBot/1.0",
      minIntervalMs,
      maxRequests: 40,
      fetchImpl: async (url) => {
        calls.push(url);
        const body = routes[url];
        return {
          status: body === undefined ? 404 : 200,
          headers: { get: () => null },
          text: async () => body ?? "",
        };
      },
    });
  }

  it("tum adaylarin 1. sayfasi okunur; hedef dolmadiysa izinli ?sayfa=2'ye inilir", async () => {
    const calls: string[] = [];
    const c = client(
      {
        [`${O3}/ornek/model-k-K1`]: card("10000001", "Diger Urun"),
        [`${O3}/ornek/modeller-k-K2`]: card("10000002", "Ornek Model X Siyah"),
        [`${O3}/ornek/model-k-K1?sayfa=2`]: card("10000003", "Ornek Model X Beyaz"),
        [`${O3}/ornek/modeller-k-K2?sayfa=2`]: "",
        [`${O3}/u-p-10000002`]: detail("Ornek Model X Siyah", 100),
        [`${O3}/u-p-10000003`]: detail("Ornek Model X Beyaz", 120),
      },
      calls,
    );
    const report = await discoverPazarama(
      c,
      { query: "Ornek Model X", gtins: [], matchedTitles: ["Ornek Model X"], categoryNames: [] },
      ["/ornek/model-k-K1", "/ornek/modeller-k-K2"],
      { targetResults: 4, maxPagesPerPath: 2 },
    );
    // 1. sayfalar: ilk basari (b) diger adayi (a) elemedi; a'nin 2. sayfasinda da urun bulundu.
    expect(report.results.map((r) => r.productId).sort()).toEqual(["10000002", "10000003"]);
    expect(report.seo.listPagesRead).toBe(4);
    expect(report.stoppedEarly).toBe(false);
  });

  it("hedef doluysa derin sayfalara inilmez (erken durma)", async () => {
    const calls: string[] = [];
    const c = client(
      {
        [`${O3}/ornek/model-k-K1`]: card("10000002", "Ornek Model X Siyah"),
        [`${O3}/u-p-10000002`]: detail("Ornek Model X Siyah", 100),
      },
      calls,
    );
    const report = await discoverPazarama(
      c,
      { query: "Ornek Model X", gtins: [], matchedTitles: ["Ornek Model X"], categoryNames: [] },
      ["/ornek/model-k-K1"],
      { targetResults: 1, maxPagesPerPath: 3 },
    );
    expect(report.stoppedEarly).toBe(true);
    expect(calls.filter((u) => u.includes("sayfa="))).toEqual([]);
  });

  it("ayni urun sayfasi barkod ve SEO yolunda bir kez indirilir (onbellek)", async () => {
    const calls: string[] = [];
    const c = client(
      {
        [`${O3}/-p-10000002`]: detail("Ornek Model X Siyah", 100),
        [`${O3}/ornek/model-k-K1`]: `<a href="/-p-10000002" title="Ornek Model X Siyah">x</a><span>1,00 TL</span>`,
      },
      calls,
    );
    const report = await discoverPazarama(
      c,
      {
        query: "Ornek Model X",
        gtins: ["10000002"],
        matchedTitles: ["Ornek Model X"],
        categoryNames: [],
      },
      ["/ornek/model-k-K1"],
      { maxPagesPerPath: 1 },
    );
    expect(calls.filter((u) => u === `${O3}/-p-10000002`)).toHaveLength(1);
    expect(report.results).toHaveLength(1);
    expect(report.results[0]?.via.sort()).toEqual(["barcode", "seo"]);
  });

  it("eszamanli cagrilarda da istek BASLANGICLARI arasinda en az minIntervalMs (slot)", async () => {
    // Saat sabit: esanli uc cagri ardisik slot ayirmali -> bekleme 0, 1000, 2000 ms.
    const waits: number[] = [];
    const c = new PazaramaClient({
      userAgent: "TestBot/1.0",
      minIntervalMs: 1000,
      maxRequests: 10,
      now: () => 0,
      sleep: async (ms) => {
        waits.push(ms);
      },
      fetchImpl: async () => ({ status: 404, headers: { get: () => null }, text: async () => "" }),
    });
    await Promise.all([c.get(`${O3}/a-p-1`), c.get(`${O3}/b-p-2`), c.get(`${O3}/c-p-3`)]);
    expect(waits.sort((x, y) => x - y)).toEqual([1000, 2000]);
    expect(c.log).toHaveLength(3);
  });
});

describe("Faz 4: akis kesme, kimlik normalizasyonu, erken barkod durdurma, istek analizi", () => {
  const O4 = "https://www.pazarama.com";
  const enc = new TextEncoder();
  /** Govdeyi parca parca veren akis; kac parca okundugunu sayar. */
  function stream(parts: string[], counter: { read: number; cancelled: boolean }) {
    let i = 0;
    return new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (i >= parts.length) return ctrl.close();
        counter.read += 1;
        ctrl.enqueue(enc.encode(parts[i++] as string));
      },
      cancel() {
        counter.cancelled = true;
      },
    });
  }
  const ld = (name: string, price: number, stock = true) =>
    `<script type="application/ld+json">${JSON.stringify({
      "@type": "Product",
      name,
      image: "https://img.pzrmcdn.com/a.png",
      offers: {
        price,
        priceCurrency: "TRY",
        seller: "S",
        availability: `https://schema.org/${stock ? "InStock" : "OutOfStock"}`,
      },
    })}</script>`;

  it("liste sayfasi Nuxt durumundan once, urun sayfasi JSON-LD Product sonrasi kesilir", async () => {
    const listCounter = { read: 0, cancelled: false };
    const detailCounter = { read: 0, cancelled: false };
    const c = new PazaramaClient({
      userAgent: "TestBot/1.0",
      minIntervalMs: 0,
      maxRequests: 10,
      fetchImpl: async (url) => {
        const isList = url.includes("-k-");
        const parts = isList
          ? ['<a href="/x-p-1" title="A">x</a>', "<script>window.__NUXT__=", "x".repeat(1000), "y"]
          : [
              "<html>",
              ld("Urun", 10),
              "<div>window.__NUXT__=",
              "z".repeat(1000),
              "w".repeat(1000),
              "v",
            ];
        const counter = isList ? listCounter : detailCounter;
        return {
          status: 200,
          headers: { get: () => null },
          text: async () => parts.join(""),
          body: stream(parts, counter),
        };
      },
    });
    const list = await c.get(`${O4}/a-k-K1`, { kind: "list", stopWhen: LISTING_STOP });
    const detail = await c.get(`${O4}/u-p-1`, { kind: "detail", stopWhen: DETAIL_STOP });
    // Akis bir parca onden cekebilir (highWaterMark); onemli olan: iptal edildi ve son parcalar okunmadi.
    expect(listCounter.cancelled).toBe(true);
    expect(listCounter.read).toBeLessThan(4);
    expect(detailCounter.cancelled).toBe(true);
    expect(detailCounter.read).toBeLessThan(6);
    expect("body" in list && parseListingCards(list.body)).toHaveLength(1);
    expect("body" in detail && parseProductPage(detail.body)?.priceKurus).toBe(1000);
    expect(c.log.map((l) => [l.kind, l.truncated])).toEqual([
      ["list", true],
      ["detail", true],
    ]);
  });

  it("kural saglanmazsa sayfa TAM okunur (yapi degisirse veri kaybi yok)", async () => {
    const counter = { read: 0, cancelled: false };
    const parts = ['<a href="/x-p-1" title="A">x</a>', "<footer>son</footer>"];
    const c = new PazaramaClient({
      userAgent: "TestBot/1.0",
      minIntervalMs: 0,
      maxRequests: 10,
      fetchImpl: async () => ({
        status: 200,
        headers: { get: () => null },
        text: async () => parts.join(""),
        body: stream(parts, counter),
      }),
    });
    const r = await c.get(`${O4}/a-k-K1`, { kind: "list", stopWhen: LISTING_STOP });
    expect(counter).toEqual({ read: 2, cancelled: false });
    expect("body" in r && r.body).toBe(parts.join(""));
    expect(c.log[0]?.truncated).toBe(false);
  });

  it("cutoff=false iken kural yok sayilir (kiyaslama icin)", async () => {
    const counter = { read: 0, cancelled: false };
    const parts = ["a", "window.__NUXT__", "b"];
    const c = new PazaramaClient({
      userAgent: "TestBot/1.0",
      minIntervalMs: 0,
      maxRequests: 10,
      cutoff: false,
      fetchImpl: async () => ({
        status: 200,
        headers: { get: () => null },
        text: async () => parts.join(""),
        body: stream(parts, counter),
      }),
    });
    const r = await c.get(`${O4}/a-k-K1`, { kind: "list", stopWhen: LISTING_STOP });
    expect("body" in r && r.body).toBe("awindow.__NUXT__b");
  });

  it("GTIN bastaki sifir ile Pazarama kimligi ayni urundur", () => {
    expect(normalizeProductId("0195949771569")).toBe("195949771569");
    expect(normalizeProductId("195949771569")).toBe("195949771569");
    expect(normalizeProductId("pz4373487")).toBe("pz4373487");
    expect(normalizeProductId("0")).toBe("0");
  });

  it("SEO yolunun dogruladigi urunun bastaki sifirli GTIN'i tekrar istenmez (erken birlestirme)", async () => {
    const calls: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const routes: Record<string, string> = {
      [`${O4}/ornek/model-k-K1`]: `<a href="/m1-p-10000001" title="Ornek Model X 1">x</a><span>1,00 TL</span>`,
      [`${O4}/m1-p-10000001`]: ld("Ornek Model X 1", 101),
    };
    const c = new PazaramaClient({
      userAgent: "TestBot/1.0",
      minIntervalMs: 0,
      maxRequests: 30,
      fetchImpl: async (url) => {
        calls.push(url);
        if (url.endsWith("/-p-99999991")) await gate; // ilk barkod SEO bitene kadar bekler
        const body = routes[url];
        return {
          status: body === undefined ? 404 : 200,
          headers: { get: () => null },
          text: async () => body ?? "",
        };
      },
    });
    const run = discoverPazarama(
      c,
      {
        query: "Ornek Model X",
        gtins: ["99999991", "010000001"],
        matchedTitles: ["Ornek Model X"],
        categoryNames: [],
      },
      ["/ornek/model-k-K1"],
      { targetResults: 10, maxVerify: 6, maxPagesPerPath: 1 },
    );
    for (let i = 0; i < 50 && !calls.includes(`${O4}/m1-p-10000001`); i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    await new Promise((r) => setTimeout(r, 0));
    release();
    const report = await run;
    expect(report.results.map((r) => r.productId)).toEqual(["10000001"]);
    expect(calls).not.toContain(`${O4}/-p-010000001`);
  });

  it("paralel kipte: SEO 4 sonucu bulduktan sonra baslayan barkod istegi yapilmaz", async () => {
    const calls: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const routes: Record<string, string> = {
      [`${O4}/ornek/model-k-K1`]: [1, 2, 3, 4]
        .map(
          (n) =>
            `<a href="/m${n}-p-1000000${n}" title="Ornek Model X ${n}">x</a><span>1,00 TL</span>`,
        )
        .join(""),
    };
    for (const n of [1, 2, 3, 4])
      routes[`${O4}/m${n}-p-1000000${n}`] = ld(`Ornek Model X ${n}`, 100 + n);
    const c = new PazaramaClient({
      userAgent: "TestBot/1.0",
      minIntervalMs: 0,
      maxRequests: 30,
      fetchImpl: async (url) => {
        calls.push(url);
        // Ilk barkod istegi SEO bitene kadar bekletilir (siralamayi belirler).
        if (url.endsWith("/-p-99999991")) await gate;
        const body = routes[url];
        return {
          status: body === undefined ? 404 : 200,
          headers: { get: () => null },
          text: async () => body ?? "",
        };
      },
    });
    const run = discoverPazarama(
      c,
      {
        query: "Ornek Model X",
        gtins: ["99999991", "99999992", "99999993"],
        matchedTitles: ["Ornek Model X"],
        categoryNames: [],
      },
      ["/ornek/model-k-K1"],
      { targetResults: 4, maxVerify: 6 },
    );
    // SEO yolunun 4 urunu dogrulamasini bekle, sonra ilk barkodu birak.
    for (let i = 0; i < 50 && calls.filter((u) => /\/m\d-p-/.test(u)).length < 4; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    release();
    const report = await run;
    expect(report.results).toHaveLength(4);
    expect(calls).not.toContain(`${O4}/-p-99999992`);
    expect(calls).not.toContain(`${O4}/-p-99999993`);
  });
});

describe("Faz 4: toplam sayiya gore sayfalama ve barkod iska siniri", () => {
  const O5 = "https://www.pazarama.com";
  const ld5 = (name: string, stock: boolean) =>
    `<script type="application/ld+json">${JSON.stringify({
      "@type": "Product",
      name,
      offers: {
        price: 10,
        priceCurrency: "TRY",
        availability: `https://schema.org/${stock ? "InStock" : "OutOfStock"}`,
      },
    })}</script>`;
  function client(routes: Record<string, string>, calls: string[]) {
    return new PazaramaClient({
      userAgent: "TestBot/1.0",
      minIntervalMs: 0,
      maxRequests: 40,
      fetchImpl: async (url) => {
        calls.push(url);
        const body = routes[url];
        return {
          status: body === undefined ? 404 : 200,
          headers: { get: () => null },
          text: async () => body ?? "",
        };
      },
    });
  }

  it("parseListingTotal: '1.215 ürün' -> 1215; yoksa null", () => {
    expect(parseListingTotal("<h1>Adidas</h1><span>1.215 ürün</span>")).toBe(1215);
    expect(parseListingTotal("<span>9 ürün</span>")).toBe(9);
    expect(parseListingTotal("<span>sonuc yok</span>")).toBeNull();
  });

  it("'9 ürün' yazan yolun 2. sayfasi istenmez (fazla kartlar oneri blogu)", async () => {
    const calls: string[] = [];
    const c = client(
      {
        [`${O5}/ornek/model-k-K1`]: `<span>9 ürün</span>${'<a href="/x-p-1" title="Diger">x</a><span>1,00 TL</span>'.repeat(1)}`,
        [`${O5}/ornek/model-k-K1?sayfa=2`]:
          '<a href="/y-p-2" title="Ornek Model X">x</a><span>1,00 TL</span>',
      },
      calls,
    );
    const report = await discoverPazarama(
      c,
      { query: "Ornek Model X", gtins: [], matchedTitles: ["Ornek Model X"], categoryNames: [] },
      ["/ornek/model-k-K1"],
      { maxPagesPerPath: 3 },
    );
    expect(calls).not.toContain(`${O5}/ornek/model-k-K1?sayfa=2`);
    expect(report.seo.pagesSkippedByTotal).toBe(1);
  });

  it("art arda 2 iska sonrasi kalan barkodlar istenmez; basari sayaci sifirlar", async () => {
    const calls: string[] = [];
    const c = client(
      {
        [`${O5}/-p-11111111`]: ld5("Ornek Model X", false), // iska 1 (stoksuz)
        [`${O5}/-p-22222222`]: ld5("Ornek Model X Siyah", true), // basari -> sayac 0
        [`${O5}/-p-33333333`]: ld5("Baska Urun", true), // iska 1 (yanlis varyant)
        // 44444444 -> 404: iska 2
        [`${O5}/-p-55555555`]: ld5("Ornek Model X Mavi", true), // istenmemeli
      },
      calls,
    );
    const report = await discoverPazarama(
      c,
      {
        query: "Ornek Model X",
        gtins: ["11111111", "22222222", "33333333", "44444444", "55555555"],
        matchedTitles: [],
        categoryNames: [],
      },
      [],
      { maxBarcodes: 5, barcodeMaxConsecutiveMisses: 2, barcodeStopAtTarget: false },
    );
    expect(calls).not.toContain(`${O5}/-p-55555555`);
    expect(report.results.map((r) => r.productId)).toEqual(["22222222"]);
    expect(report.barcode.rejected.map((r) => r.reason)).toContain("skipped-after-misses");
  });
});

describe("Faz 4: fiyat ve varyant dogrulugu (gercek HTML yapisindan modellenmis)", () => {
  // Canli urun sayfasindaki fiyat blogu ve "Renk" yapisinin sadelestirilmis hali.
  const priceBlock =
    '<div class="line-through">7.999,00 TL</div><div class="flex"><span>Sepette</span><span class="text-xl">4.799,40 TL</span></div>';
  const colorBlock =
    '<div class="spec"><span class="label">Renk</span><span class="value"> Siyah </span></div>';
  const page = (price: number, extra: string) =>
    `<script type="application/ld+json">${JSON.stringify({
      "@type": "Product",
      name: "adidas SAMBA OG B75807",
      offers: {
        price,
        priceCurrency: "TRY",
        seller: "Northsport",
        availability: "https://schema.org/InStock",
      },
    })}</script>${extra}`;

  it("JSON-LD fiyati Sepette fiyatina esitse etiketlenir, liste fiyati tasinir; renk okunur", () => {
    const p = parseProductPage(page(4799.4, priceBlock + colorBlock));
    expect(p).toMatchObject({
      priceKurus: 479940,
      priceKind: "basket",
      basketPriceKurus: 479940,
      regularPriceKurus: 799900,
      basketConditionsVerified: false,
      color: "Siyah",
      seller: "Northsport",
    });
  });

  it("JSON-LD fiyati Sepette fiyatindan farkliysa sepet etiketi konmaz (uydurma yok)", () => {
    const p = parseProductPage(page(7999, priceBlock));
    expect(p).toMatchObject({
      priceKurus: 799900,
      priceKind: "regular",
      regularPriceKurus: 799900,
      basketPriceKurus: null,
      basketConditionsVerified: false,
      color: null,
    });
  });

  it("parseBasketPrice / parseColor yoksa null", () => {
    expect(parseBasketPrice("<div>4.799,40 TL</div>")).toBeNull();
    expect(parseColor("<div>Renk</div><div></div>")).toBeNull();
  });
});

describe("Faz 5: farkli barkod/satici/renk fiyatlari karismaz", () => {
  it("ayni baslikli iki barkod iki ayri sonuc; her biri kendi fiyati, saticisi, rengi", async () => {
    const O6 = "https://www.pazarama.com";
    const page = (price: number, seller: string, color: string, basket: boolean) =>
      `<script type="application/ld+json">${JSON.stringify({
        "@type": "Product",
        name: "Ornek Model X",
        offers: { price, priceCurrency: "TRY", seller, availability: "https://schema.org/InStock" },
      })}</script>${basket ? `<div>9.999,00 TL</div><span>Sepette</span><span>${price.toFixed(2).replace(".", ",")} TL</span>` : ""}<span>Renk</span><span>${color}</span>window.__NUXT__`;
    const routes: Record<string, string> = {
      [`${O6}/ornek/model-k-K1`]:
        '<a href="/x-p-10000001" title="Ornek Model X">x</a><span>1,00 TL</span><a href="/x-p-10000002" title="Ornek Model X">x</a><span>1,00 TL</span>',
      [`${O6}/x-p-10000001`]: page(100, "Satici A", "Siyah", true),
      [`${O6}/x-p-10000002`]: page(150, "Satici B", "Beyaz", false),
    };
    const client = new PazaramaClient({
      userAgent: "TestBot/1.0",
      minIntervalMs: 0,
      maxRequests: 10,
      fetchImpl: async (url) => ({
        status: routes[url] ? 200 : 404,
        headers: { get: () => null },
        text: async () => routes[url] ?? "",
      }),
    });
    const r = await discoverPazarama(
      client,
      { query: "Ornek Model X", gtins: [], matchedTitles: ["Ornek Model X"], categoryNames: [] },
      ["/ornek/model-k-K1"],
      { maxPagesPerPath: 1 },
    );
    expect(
      r.results.map((x) => [
        x.barcode,
        x.priceKurus,
        x.seller,
        x.color,
        x.priceKind,
        x.regularPriceKurus,
        x.basketPriceKurus,
      ]),
    ).toEqual([
      ["10000001", 10000, "Satici A", "Siyah", "basket", 999900, 10000],
      ["10000002", 15000, "Satici B", "Beyaz", "regular", 15000, null],
    ]);
    expect(r.results.every((x) => x.basketConditionsVerified === false)).toBe(true);
  });
});
