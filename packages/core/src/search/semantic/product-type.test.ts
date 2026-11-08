import { describe, expect, it } from "vitest";
import { foldForMatch } from "../text-match.ts";
import { requiredTypePattern } from "./product-type.ts";

const matches = (query: string, title: string): boolean | null => {
  const pattern = requiredTypePattern(query);
  return pattern === null ? null : new RegExp(pattern).test(foldForMatch(title));
};

describe("urun turu zorunlulugu", () => {
  it("bas isim turu basliktaki Ingilizce/Turkce karsiligi arar", () => {
    expect(matches("kırmızı şort", "Women Red Summer Shorts")).toBe(true);
    expect(matches("kırmızı şort", "Red Short Sleeve T-Shirt")).toBe(false);
    expect(matches("kırmızı şort", "Kırmızı Spor Şort Kadın")).toBe(true);
    expect(matches("red shorts", "Cotton Tee Red")).toBe(false);
    expect(matches("kablosuz kulaklık", "Bluetooth Earbuds Sport")).toBe(true);
    expect(matches("kablosuz kulaklık", "Vacuum Cleaner Cordless")).toBe(false);
  });

  it("cok sozcuklu ifadeler bas isimdir (bebek arabasi != araba)", () => {
    expect(matches("bebek arabası", "Foldable Baby Stroller Lightweight")).toBe(true);
    expect(matches("bebek arabası", "Car Seat Cover Universal")).toBe(false);
    expect(matches("sırt çantası", "Waterproof Laptop Backpack")).toBe(true);
    expect(matches("akıllı saat", "Smartwatch Men Fitness Tracker")).toBe(true);
    expect(matches("oyuncak araba", "RC Toy Car Remote Control")).toBe(true);
  });

  it("alt dize eslesmesi yok; bilinmeyen sorguda zorunluluk yok", () => {
    expect(matches("yüzük", "Ringtone Speaker Black")).toBe(false);
    expect(matches("şişe", "Water Bottle Steel")).toBe(null);
    expect(requiredTypePattern("")).toBeNull();
    expect(requiredTypePattern("zorbalux")).toBeNull();
  });

  it("telefon kilifi: bas isim 'kilif' (telefon degil)", () => {
    expect(matches("telefon kılıfı", "Shockproof Case For iPhone 15")).toBe(true);
    expect(matches("telefon kılıfı", "Android Smartphone 5G 256GB")).toBe(false);
  });
});
