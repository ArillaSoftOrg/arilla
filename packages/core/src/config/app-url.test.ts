import { describe, expect, it } from "vitest";
import { readAppUrl, requireAppUrl } from "./app-url.ts";

describe("readAppUrl", () => {
  it("tanimsiz veya bos degerde undefined doner", () => {
    expect(readAppUrl(undefined)).toBeUndefined();
    expect(readAppUrl("")).toBeUndefined();
    expect(readAppUrl("   ")).toBeUndefined();
  });

  it("sondaki slash'i kaldirir", () => {
    expect(readAppUrl("https://alan-adi.com/")).toBe("https://alan-adi.com");
    expect(readAppUrl("https://alan-adi.com")).toBe("https://alan-adi.com");
  });

  it("portu korur", () => {
    expect(readAppUrl("http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("protokolsuz degeri reddeder", () => {
    expect(() => readAppUrl("alan-adi.com")).toThrow(/APP_URL/);
  });

  it("http/https disindaki protokolu reddeder", () => {
    expect(() => readAppUrl("ftp://alan-adi.com")).toThrow(/http/);
  });

  it("yol veya sorgu iceren degeri reddeder", () => {
    expect(() => readAppUrl("https://alan-adi.com/tr")).toThrow(/kok adres/);
    expect(() => readAppUrl("https://alan-adi.com/?x=1")).toThrow(/kok adres/);
  });
});

describe("requireAppUrl", () => {
  it("tanimsizsa firlatir", () => {
    expect(() => requireAppUrl(undefined)).toThrow(/tanimli degil/);
  });

  it("tanimliysa normalize edilmis degeri doner", () => {
    expect(requireAppUrl("https://alan-adi.com/")).toBe("https://alan-adi.com");
  });
});
