import { describe, expect, it } from "vitest";
import { redactText, safeUrl, urlHost } from "./redact.ts";

describe("safeUrl", () => {
  it("kimlik bilgisi, sorgu dizisi ve parça gösterilmez", () => {
    expect(safeUrl("https://user:secret@feed.ornek.com/urunler.xml?api_key=abc#x")).toBe(
      "https://feed.ornek.com/urunler.xml?…",
    );
    expect(safeUrl("https://ornek.com/a")).toBe("https://ornek.com/a");
  });

  it("http(s) dışı ve bozuk adres null", () => {
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("ftp://ornek.com/x")).toBeNull();
    expect(safeUrl("bozuk")).toBeNull();
    expect(safeUrl(null)).toBeNull();
  });
});

describe("urlHost", () => {
  it("yalnızca ana makine", () => {
    expect(urlHost("https://www.ornek.com/p/1?utm=1")).toBe("www.ornek.com");
    expect(urlHost("bozuk")).toBeNull();
  });
});

describe("redactText", () => {
  it("metindeki adreslerden token atılır", () => {
    const text =
      "HTTPError 403 for url: https://shop.test/products.json?access_token=SECRET&page=2";
    const out = redactText(text) ?? "";
    expect(out).not.toContain("SECRET");
    expect(out).toContain("https://shop.test/products.json?…");
  });

  it("uzun metin kırpılır", () => {
    expect(redactText("a".repeat(3000), 100)?.length).toBe(101);
    expect(redactText(null)).toBeNull();
  });
});
