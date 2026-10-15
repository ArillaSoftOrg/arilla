import { describe, expect, it } from "vitest";
import { validateDiscoveryItem } from "./discovery-validate.ts";

const rules = { urlHost: "hepsiburada.com", imageHost: "hepsiburada.net" };
const ok = {
  externalId: "HBC0000KHSC74",
  codeKind: "pm",
  url: "https://www.hepsiburada.com/store-kitap-okuma-standi-pm-HBC0000KHSC74",
  title: "  Kitap   Okuma Standı ",
  imageUrl: "https://productimages.hepsiburada.net/s/777/738/110002354869575.jpg",
  sourceUnitKey: "sitemaps/product/sitemap_1.xml",
};

describe("kesif kaydi dogrulama", () => {
  it("gecerli kaydi normallestirir; fiyat alani yoktur", () => {
    const r = validateDiscoveryItem({ ...ok, priceMinor: 100 }, rules);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.item.title).toBe("Kitap Okuma Standı");
      expect("priceMinor" in r.item).toBe(false);
    }
  });
  it("kimlik URL sonundaki kodla eslesmeli", () => {
    const r = validateDiscoveryItem({ ...ok, externalId: "HBC0000XXXXXX" }, rules);
    expect(r).toEqual({ ok: false, code: "external_id" });
  });
  it("kod turu URL ile eslesmeli (-p- ile pm)", () => {
    const r = validateDiscoveryItem({ ...ok, url: ok.url.replace("-pm-", "-p-") }, rules);
    expect(r).toEqual({ ok: false, code: "url" });
  });
  it("yabanci alan adi, http, sorgu ve kimlik bilgisi reddedilir", () => {
    for (const url of [
      "https://evil.example/x-pm-HBC0000KHSC74",
      "http://www.hepsiburada.com/x-pm-HBC0000KHSC74",
      "https://www.hepsiburada.com.evil.io/x-pm-HBC0000KHSC74",
      `${ok.url}?utm=1`,
      "https://u:p@www.hepsiburada.com/x-pm-HBC0000KHSC74",
    ]) {
      expect(validateDiscoveryItem({ ...ok, url }, rules).ok).toBe(false);
    }
  });
  it("yabanci gorsel adresi atilir ama kayit reddedilmez; bos baslik NULL olur", () => {
    const r = validateDiscoveryItem(
      { ...ok, imageUrl: "https://evil.example/a.jpg", title: "" },
      rules,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.item.imageUrl).toBeNull();
      expect(r.item.title).toBeNull();
    }
  });
  it("kaynak birim anahtari yol benzeri olmali", () => {
    expect(validateDiscoveryItem({ ...ok, sourceUnitKey: "../etc/passwd" }, rules)).toEqual({
      ok: false,
      code: "unit_key",
    });
  });
});
