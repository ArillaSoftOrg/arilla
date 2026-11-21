import { describe, expect, it } from "vitest";
import { siteJsonLd } from "./site-json-ld.ts";

const base = { brand: "ManiCepte", description: "d", sameAs: [], searchOpen: false };

describe("siteJsonLd", () => {
  it("produces nothing without a site url", () => {
    expect(siteJsonLd({ ...base, siteUrl: undefined })).toBeNull();
  });
  it("emits Organization + WebSite, SearchAction only when search is open", () => {
    const closed = JSON.stringify(siteJsonLd({ ...base, siteUrl: "https://manicepte.com/" }));
    expect(closed).toContain('"@type":"Organization"');
    expect(closed).toContain("https://manicepte.com/brand/manicepte-logo.png");
    expect(closed).not.toContain("SearchAction");
    const open = JSON.stringify(
      siteJsonLd({ ...base, siteUrl: "https://manicepte.com", searchOpen: true }),
    );
    expect(open).toContain("https://manicepte.com/sohbet?q={search_term_string}");
  });
});
