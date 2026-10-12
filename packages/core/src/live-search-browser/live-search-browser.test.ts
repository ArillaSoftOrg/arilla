/**
 * Buradaki HTML'ler SENTETIKTIR: canli sayfalarda gozlenen YAPIYI (2026-10-12)
 * taklit eder, gercek urun verisi icermez ve canli calistigini kanitlamaz.
 * Canli dogrulama: docs/research/canli-arama-platformlari.md.
 */

import { describe, expect, it } from "vitest";
import { isBundleTitle, matchesQuery } from "./match.ts";
import { flattenNextFlight, jsonValueAfter } from "./parse-helpers.ts";
import { searchLiveStore, topCategoryNames } from "./search.ts";
import {
  extractCiceksepeti,
  extractHepsiburada,
  extractHepsiburadaCategoryFacet,
  extractHepsiburadaGtins,
  LIVE_STORES,
} from "./stores.ts";

describe("Faz 2 eklemeleri (kategori kaniti, GTIN)", () => {
  it("HB urun sayfasindan gtin once, sonra varyant barkodlari; gecersizler atlanir", () => {
    const html =
      '{"gtin":"0195949771569","x":1}{"barcode":"0195949771187"}{"barcode":"0195949771569"}' +
      '{\\"barcode\\":\\"0195949771750\\"}{"gtin":"934583809031482"}{"barcode":"0000659455656"}';
    expect(extractHepsiburadaGtins(html)).toEqual([
      "0195949771569",
      "0195949771187",
      "0195949771750",
    ]);
  });

  it("HB kategori fasetini (ust duzey) okur; bozuk durumda bos", () => {
    const vfHtml = `<div>{"title":"Kategori","key":"AllCategories.CategoryId","values":[{"displayName":"Telefon","itemCount":-1},{"displayName":"Elektronik","itemCount":-1}]}</div>`;
    const state = {
      voltranState: { fragmentsMap: { "99": { VerticalFilter: { html: vfHtml } } } },
    };
    const html = `<script id="reduxStore" type="application/json">${JSON.stringify(state)}</script>`;
    expect(extractHepsiburadaCategoryFacet(html)).toEqual(["Telefon", "Elektronik"]);
    expect(extractHepsiburadaCategoryFacet('<script id="reduxStore">{bozuk</script>')).toEqual([]);
  });

  it("CS categoryTree adlarini (Marketplace haric) urune ekler ve sayfa kategorisini sayar", () => {
    const payload = `"products":[${JSON.stringify({
      name: "Ornek Ayakkabi",
      image: "https://cdn03.ciceksepeti.com/a.jpg",
      link: "ornek-kcm1",
      price: { finalPrice: 100 },
      categoryTree: [
        { name: "Marketplace" },
        { name: "Spor ve Outdoor" },
        { name: "Spor Ayakkabı" },
      ],
    })}]`;
    const html = `<script>self.__next_f.push([1,${JSON.stringify(payload)}])</script>`;
    const out = extractCiceksepeti(html, "2026-10-12T00:00:00Z");
    expect(out[0]?.categoryNames).toEqual(["Spor ve Outdoor", "Spor Ayakkabı"]);
    expect(topCategoryNames([...out, ...out])).toEqual(["Spor ve Outdoor", "Spor Ayakkabı"]);
  });
});

const NOW = "2026-10-12T10:00:00.000Z";

function hepsiburadaHtml(items: unknown[]): string {
  const state = {
    voltranState: {
      fragmentsMap: {
        "7": { ProductList: { seoState: { itemListElement: JSON.stringify(items) } } },
      },
    },
  };
  return `<html><script id="reduxStore" type="application/json">${JSON.stringify(state)}</script></html>`;
}

function nextFlightHtml(payload: string): string {
  // Gercek sayfadaki gibi: icerik birden cok push parcasina bolunmus JSON dizgesi.
  const half = Math.floor(payload.length / 2);
  return [payload.slice(0, half), payload.slice(half)]
    .map((p) => `<script>self.__next_f.push([1,${JSON.stringify(p)}])</script>`)
    .join("");
}

const hbItem = {
  "@type": "Product",
  name: "Ornek Telefon 16 Pro 128GB",
  url: "https://www.hepsiburada.com/ornek-telefon-p-HBCTEST1",
  image: ["https://productimages.hepsiburada.net/s/1/a.jpg"],
  offers: {
    "@type": "Offer",
    price: 1234.5,
    priceCurrency: "TRY",
    availability: "https://schema.org/InStock",
  },
};

describe("extractHepsiburada", () => {
  it("reduxStore ItemList'ten tam alanli urun cikarir", () => {
    expect(extractHepsiburada(hepsiburadaHtml([{ item: hbItem }]), NOW)).toEqual([
      {
        store: "hepsiburada",
        title: "Ornek Telefon 16 Pro 128GB",
        priceKurus: 123450,
        currency: "TRY",
        imageUrl: "https://productimages.hepsiburada.net/s/1/a.jpg",
        productUrl: "https://www.hepsiburada.com/ornek-telefon-p-HBCTEST1",
        merchant: "Hepsiburada",
        availability: "in_stock",
        lastCheckedAt: NOW,
      },
    ]);
  });

  it("fiyati, gorseli ya da alan adi dogrulanamayan urunu atlar", () => {
    const bad = [
      { ...hbItem, offers: { price: 0, priceCurrency: "TRY" } },
      { ...hbItem, image: ["http://insecure.example/a.jpg"] },
      { ...hbItem, url: "https://evil.example/x-p-1" },
      { ...hbItem, offers: { price: 10, priceCurrency: "USD" } },
    ];
    expect(extractHepsiburada(hepsiburadaHtml(bad), NOW)).toEqual([]);
  });

  it("reduxStore yoksa ya da bozuksa bos doner", () => {
    expect(extractHepsiburada("<html></html>", NOW)).toEqual([]);
    expect(extractHepsiburada('<script id="reduxStore">{bozuk</script>', NOW)).toEqual([]);
  });
});

describe("extractCiceksepeti", () => {
  const payload = `5:["$","$L1",null,{"seo":{"title":"x"},"products":[${JSON.stringify({
    id: 1,
    name: "Ornek Spor Ayakkabi",
    image: "https://cdn03.ciceksepeti.com/cicek/kcm1-1/M/a.jpg",
    link: "ornek-spor-ayakkabi-kcm1",
    price: { finalPrice: 2199, strikeoutDiscountPrice: { priceText: "2.199,00 TL" } },
  })},{"id":2,"name":"Fiyatsiz","image":"https://cdn03.ciceksepeti.com/b.jpg","link":"fiyatsiz-kcm2","price":{}}]}]`;

  it("Next.js akisindaki products dizisini okur, fiyatsizi atlar", () => {
    const out = extractCiceksepeti(nextFlightHtml(payload), NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      title: "Ornek Spor Ayakkabi",
      priceKurus: 219900,
      productUrl: "https://www.ciceksepeti.com/ornek-spor-ayakkabi-kcm1",
      imageUrl: "https://cdn03.ciceksepeti.com/cicek/kcm1-1/M/a.jpg",
      availability: "unknown",
    });
  });

  it("parcali akisi birlestirir ve dengeli parantezle diziyi bulur", () => {
    const flat = flattenNextFlight(nextFlightHtml('{"a":[1,"]",{"b":"\\"}"}],"z":1}'));
    expect(jsonValueAfter(flat, '"a":[')).toEqual([1, "]", { b: '"}' }]);
  });
});

describe("matchesQuery (canli testte gorulen hatali sonuclar)", () => {
  it.each([
    ["Apple iPhone 16 Pro 128GB Natürel Titanyum", "iPhone 16 Pro 128 GB", true],
    ["Apple iPhone 17 Pro 256 GB Turuncu", "iPhone 16 Pro 128 GB", false],
    ["Apple iPhone 16 Pro Max 128 GB", "iPhone 16 Pro 128 GB", false],
    ["Sony WH-1000XM5 Kulak Üstü Kulaklık", "Sony WH-1000XM5", true],
    ["Sony WH1000XM5 Siyah", "Sony WH-1000XM5", true],
    ["Sony WH-1000XM6 Kulak Üstü Bluetooth Kulaklık", "Sony WH-1000XM5", false],
    ["Sony WH-1000XM5 Uyumlu Kulaklık Pedi", "Sony WH-1000XM5", false],
    ["Avver Kadın Siyah Astarlı Kruvaze Şifon Elbise", "Siyah kadın elbise", true],
    ["Tesettür Namaz Elbisesi-Siyah Kadın", "Siyah kadın elbise", true],
    ["Adidas Samba OG Kadın Spor Ayakkabı", "Adidas Samba", true],
    ["iPhone 16 Pro Kılıf", "iPhone 16 Pro kılıf", true],
    // 4. oturum canli degerlendirmesinde (2026-10-12) gecen hatali eslesmeler:
    [
      "Sony Ult Wear - Gürültü Engelleme Özelliğine Sahip Kablosuz Kulaklıklar, Ult Güçlü Ses, Üstün Derin Bas, WH-1000XM5 ile Aynı Işlemci",
      "Sony WH-1000XM5",
      false,
    ],
    ["Capcom EA SPORTS FC 27 Playstation 5 Fiziki Kutu Oyun", "PlayStation 5", false],
    ["Sony Playstation 5 Kol Dualsense Wireless Controller", "PlayStation 5", false],
    ["Sony Playstation 5 PS5 Dualsense Şarj istasyonu", "PlayStation 5", false],
    ["Dyson V15 Filtre", "Dyson V15", false],
    ["Dyson V15™ / V11™ Batarya", "Dyson V15", false],
    ["Dyson V15 Boru (Gri)", "Dyson V15", false],
    // Paketler ana urun olarak kalir; ek parca "+" sonrasindadir.
    ["Sony Playstation 5 Slim Digital 825 GB + Şarj İstasyonu", "PlayStation 5", true],
    ["Sony Playstation 5 Slim +2.kol Dualsense +Şarj İstasyonu", "PlayStation 5", true],
    ["Sony Playstation 5 Slim Cd'li 1 TB Oyun Konsolu", "PlayStation 5", true],
    ["Dyson V15 Detect™ Absolute Kablosuz Süpürge", "Dyson V15", true],
    ["Apple iPhone 13 128 GB Siyah", "iPhone 13 128 GB", true],
    ["Kolay Kurulum Siyah Kadın Elbise", "Siyah kadın elbise", true],
    // Giyimde "kol" yen, "mini" kesimdir (ilk duzeltmede gerileme olarak goruldu):
    ["Kadın Balon Kol Kruvaze Yaka Krep Kumaş Midi Boy Elbise (Siyah)", "Siyah kadın elbise", true],
    ["Kadın Sıfır Kol Kaşkorse Elbise (Siyah)", "Siyah kadın elbise", true],
    ["Kadın Siyah Mini Askılı Straplez Elbise", "Siyah kadın elbise", true],
    ["Kadın Renkli Çiçek Desenli Kısa Kollu Yazlık Elbise", "Siyah kadın elbise", false],
    ["Sony PlayStation 5 DualSense Wireless Controller Beyaz", "PlayStation 5", false],
    // 3. canli turda kalanlar: Dyson parcalari ve ikinci el.
    ["Dyson V15 - V11 Hazne", "Dyson V15", false],
    ["Dyson V15 Toz Haznesi", "Dyson V15", false],
    ["Dyson V15 Detect™ ve V11™ Digital Motorbar™ Temizleme Başlığı", "Dyson V15", false],
    ["PlayStation 5 Fat 1TB Tek Kol CD’li Sürüm Kutulu(İKİNCİ EL)", "PlayStation 5", false],
    [
      "PlayStation 5 Fat 1TB Tek Kol CD’li Sürüm Kutulu(İKİNCİ EL)",
      "PlayStation 5 ikinci el",
      true,
    ],
    ["Apple iPhone 13 128 GB Yenilenmiş", "iPhone 13 128 GB", false],
    ["Sony PlayStation 5 Fat Kasa CD'li Sürüm Tek Kol Oyun Konsolu", "PlayStation 5", true],
    // 6. oturum: coklu model uyumluluk aksesuarlari (son paketle HB'de kalan 2/4 hata).
    ["Dyson V15s, V15, V11, V10 ve V8 İçin Çok Yönlü Temizlik Seti", "Dyson V15", false],
    ["Dyson V15s, V15 Detect™, V11™, Cyclone V10™, V8™ Mobilya Aparatı", "Dyson V15", false],
    // Gercek Dyson V15'ler elenmemeli:
    ["Dyson V15 Detect™ Absolute Kablosuz Süpürge", "Dyson V15", true],
    ["Dyson V15 Detect™ Absolute Kablosuz Süpürge EOL", "Dyson V15", true],
    // Faz 3 (Pazarama canli): "Sarjli" urunun niteligidir, aksesuar degil.
    ["Dyson V15 Detect Kablosuz Şarjlı Dikey Süpürge Sarı Nikel", "Dyson V15", true],
    ["DYSON V15 Detect Absolute Kablosuz Şarjlı Dikey Süpürge", "Dyson V15", true],
    ["Dyson V15 Şarj Ünitesi", "Dyson V15", false],
    // Faz 3 canli: "Sambae" ayri model; Turkce ek toleransi yalnizca gercek eklerde.
    ["adidas Sambae W Kadın Günlük Ayakkabı JI1349 Beyaz", "Adidas Samba", false],
    ["adidas SAMBA OG IG1024", "Adidas Samba", true],
    ["Siyah Kadınlar İçin Elbiseler", "Siyah kadın elbise", true],
    ["Dyson V15s Detect Submarine Islak ve Kuru Kablosuz Süpürge", "Dyson V15", false],
    // Rakamli kodlar coklu sayilsa da telefonlar etkilenmez:
    [
      "Apple iPhone 16 Pro 128 GB 8 GB RAM 5G Akıllı Telefon (Apple Türkiye Garantili)",
      "iPhone 16 Pro 128 GB",
      true,
    ],
    ["LEGO ® Technic Güçlü Makineler 42233 - 7 Yaş ve Üzeri Çocuklar için", "Lego Technic", true],
  ])("%s / %s -> %s", (title, query, expected) => {
    expect(matchesQuery(title, query)).toBe(expected);
  });

  it("paket basligini tanir", () => {
    expect(isBundleTitle("Sony Playstation 5 Slim Digital 825 GB + Şarj İstasyonu")).toBe(true);
    expect(isBundleTitle("Sony Playstation 5 Slim +2.kol Dualsense")).toBe(true);
    expect(isBundleTitle("Apple iPhone 13 128 GB Siyah")).toBe(false);
  });
});

describe("searchLiveStore", () => {
  const hb = LIVE_STORES.find((s) => s.id === "hepsiburada");
  if (!hb) throw new Error("hepsiburada store missing");

  it("cerezsiz CORS istegi atar ve eslesenleri dondurur", async () => {
    let init: RequestInit | undefined;
    const fetchImpl = (async (_url: string, i?: RequestInit) => {
      init = i;
      return new Response(hepsiburadaHtml([hbItem, { ...hbItem, name: "Baska Urun" }]), {
        status: 200,
      });
    }) as typeof fetch;
    const r = await searchLiveStore(hb, "Ornek Telefon 16 Pro 128 GB", {
      fetchImpl,
      now: () => new Date(NOW),
    });
    expect(init).toMatchObject({ mode: "cors", credentials: "omit" });
    expect(r).toMatchObject({ ok: true, totalOnPage: 2 });
    expect(r.ok && r.products.map((p) => p.title)).toEqual(["Ornek Telefon 16 Pro 128GB"]);
  });

  it("CORS reddi (TypeError) ve HTTP hatasi sonuc uretmez", async () => {
    const cors = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    expect(await searchLiveStore(hb, "x", { fetchImpl: cors })).toMatchObject({
      ok: false,
      reason: "cors-or-network",
    });
    const http = (async () => new Response("", { status: 503 })) as typeof fetch;
    expect(await searchLiveStore(hb, "x", { fetchImpl: http })).toMatchObject({
      ok: false,
      status: 503,
    });
  });
});
