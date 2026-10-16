import { describe, expect, it } from "vitest";
import { recordFromSitemapEntry } from "./sitemap-items.ts";
import {
  bodyToTextStream,
  looksLikeHtml,
  MAX_ELEMENT_CHARS,
  SitemapIndexParser,
  SitemapParseError,
  SitemapUrlsetParser,
  xmlText,
} from "./sitemap-stream.ts";

// Sentetik sitemap: gercek Hepsiburada verisi degildir.
const url = (n: number) =>
  `<url><loc>https://www.hepsiburada.com/urun-${n}-pm-HBC${String(n).padStart(6, "0")}</loc>` +
  `<image:image><image:loc>https://productimages.hepsiburada.net/s/${n}/a.jpg</image:loc>` +
  `<image:title>Urun &amp; ${n}</image:title></image:image></url>`;
const doc = (n: number) =>
  `<?xml version="1.0"?><urlset xmlns="x" xmlns:image="y">${Array.from({ length: n }, (_, i) => url(i + 1)).join("\n")}</urlset>`;

function feed(text: string, size: number) {
  const p = new SitemapUrlsetParser();
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(...p.push(text.slice(i, i + size)));
  return { out, end: p.end() };
}

describe("sitemap akisli ayristirici", () => {
  it("parca sinirindan bagimsiz ayni sonucu verir", () => {
    const text = doc(50);
    const whole = feed(text, text.length).out;
    for (const size of [1, 7, 64, 1000]) expect(feed(text, size).out).toEqual(whole);
    expect(whole).toHaveLength(50);
    expect(whole[0]).toEqual({
      loc: "https://www.hepsiburada.com/urun-1-pm-HBC000001",
      imageLoc: "https://productimages.hepsiburada.net/s/1/a.jpg",
      imageTitle: "Urun & 1",
    });
  });
  it("gorsel loc'u urun loc'una karismaz; baslik yoksa uydurulmaz", () => {
    const r = feed(
      `<urlset><url><image:image><image:loc>https://i.hepsiburada.net/a.jpg</image:loc></image:image><loc>https://www.hepsiburada.com/x-pm-ABCD1</loc></url></urlset>`,
      9,
    ).out;
    expect(r[0]?.loc).toBe("https://www.hepsiburada.com/x-pm-ABCD1");
    expect(r[0]?.imageTitle).toBeNull();
  });
  it("kesilmis dosyayi bildirir", () => {
    const text = doc(3);
    const cut = text.slice(0, text.length - 40);
    const { out, end } = feed(cut, 100);
    expect(out).toHaveLength(2);
    expect(end.truncated).toBe(true);
    expect(feed(text, 100).end).toEqual({ truncated: false, rootSeen: true });
  });
  it("tek oge sinirini asan icerikte durur (bellek korumasi)", () => {
    const p = new SitemapUrlsetParser();
    expect(() => p.push(`<urlset><url><loc>${"a".repeat(MAX_ELEMENT_CHARS + 10)}`)).toThrow(
      SitemapParseError,
    );
  });
  it("indeks dosyasini okur", () => {
    const p = new SitemapIndexParser();
    const r = p.push(
      `<sitemapindex><sitemap><loc>https://www.hepsiburada.com/sitemaps/product/sitemap_1.xml</loc><lastmod>2026-10-15</lastmod></sitemap></sitemapindex>`,
    );
    expect(r).toEqual([
      { loc: "https://www.hepsiburada.com/sitemaps/product/sitemap_1.xml", lastmod: "2026-10-15" },
    ]);
  });
  it("xml varliklari ve CDATA", () => {
    expect(xmlText("a &amp; b &#x41;")).toBe("a & b A");
    expect(xmlText("<![CDATA[ x < y ]]>")).toBe("x < y");
  });
  it("HTML/engel sayfasini tanir", () => {
    expect(looksLikeHtml("<!DOCTYPE html><html>")).toBe(true);
    expect(looksLikeHtml('<?xml version="1.0"?><urlset>')).toBe(false);
  });
  it("acilmis bayt tavani asilirsa akis hata verir", async () => {
    const bytes = new TextEncoder().encode(doc(200));
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    });
    const { stream } = await bodyToTextStream(body, "https://x/sitemap.xml", {
      maxDecodedBytes: 1000,
    });
    await expect(
      (async () => {
        for await (const _ of stream as unknown as AsyncIterable<string>) {
          /* tuket */
        }
      })(),
    ).rejects.toThrow();
  });
});

describe("recordFromSitemapEntry", () => {
  const e = (loc: string) => ({ loc, imageLoc: null, imageTitle: " Ad  X " });
  it("kimlik, tur ve temiz adres uretir; fiyat yoktur", () => {
    const r = recordFromSitemapEntry(
      e("https://www.hepsiburada.com/a-b-pm-HBC0001?x=1#y"),
      "k.xml",
    );
    expect(r).toEqual({
      externalId: "HBC0001",
      codeKind: "pm",
      url: "https://www.hepsiburada.com/a-b-pm-HBC0001",
      title: "Ad X",
      imageUrl: null,
      sourceUnitKey: "k.xml",
    });
  });
  it("kodsuz ya da yabanci adres atilir", () => {
    expect(recordFromSitemapEntry(e("https://www.hepsiburada.com/kategori"), "k")).toBeNull();
    expect(recordFromSitemapEntry(e("https://evil.example/a-pm-HBC0001"), "k")).toBeNull();
    expect(recordFromSitemapEntry(e("http://www.hepsiburada.com/a-pm-HBC0001"), "k")).toBeNull();
  });
});
