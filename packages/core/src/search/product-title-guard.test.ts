import { describe, expect, it } from "vitest";
import {
  productTitleExclusionPattern,
  productTitleRequiredPatterns,
} from "./product-title-guard.ts";
import { foldForMatch } from "./text-match.ts";

function excluded(query: string, title: string): boolean {
  const pattern = productTitleExclusionPattern(query);
  const primaryTitle = foldForMatch(title).split(" with ")[0] ?? "";
  return pattern !== null && new RegExp(pattern).test(primaryTitle);
}

describe("kulaklik aramasinda cihaz ve aksesuar ayrimi", () => {
  it.each([
    "Woyax Qı2 Kablosuz Şarj Standı Telefon Kulaklık Saat Wireless",
    "Jopus Usb-C To 3.5mm Kulaklık Dönüştürü (Dac Chip)",
    "Headphone Stand Desktop Holder",
    "Replacement Ear Pads Cushions for Sony Headphones",
    "Carrying Case for Wireless Headphones",
    "For AirPods Max Over-ear Bluetooth Headphone Battery A2096 A2165",
    "Battery for AirPods Max Over Ear Headphones A2096",
  ])("cihaz yerine aksesuar gostermez: %s", (title) => {
    expect(excluded("kulak üstü kablosuz kulaklık", title)).toBe(true);
  });

  it.each([
    "Premium Wireless Bluetooth Headphones Active Noise Cancelling Over Ear",
    "JBL Tune 520BT Kablosuz Bluetooth Kulaklık",
    "Sony Wireless Headphones with Carrying Case",
    "Standard Bluetooth Over Ear Headphones",
    "Cushioned Wireless Over Ear Headphones",
    "Premium Wireless Bluetooth Headphones Over Ear Long 40H Battery Life Soft Memory Foam",
    "Battery Powered Wireless Over Ear Headphones",
  ])("gercek cihaz ve kutu icerigini korur: %s", (title) => {
    expect(excluded("kulak üstü kablosuz kulaklık", title)).toBe(false);
  });

  it("kulak ustu istegine acikca kulak ici olan urunu karistirmaz", () => {
    expect(excluded("kulak üstü kulaklık", "Wireless In-Ear Earbuds")).toBe(true);
    expect(excluded("kulak üstü kulaklık", "Over-Ear Wireless Open-Ear Hook Headset")).toBe(true);
    expect(excluded("kablosuz kulaklık", "Wireless In-Ear Earbuds")).toBe(false);
  });

  it("Turkce ek ve unsuz yumusamasinda da cihaz istegini korur", () => {
    expect(excluded("kulak üstü kulaklığı arıyorum", "Kablosuz Kulaklık Şarj Standı")).toBe(true);
  });

  it.each([
    "kulaklık standı",
    "headphone adapter",
    "kulaklık kılıfı",
    "kulaklık bataryası",
    "headphone battery",
  ])("aksesuar isteginde aksesuar sonucunu korur: %s", (query) =>
    expect(productTitleExclusionPattern(query)).toBeNull(),
  );

  it("baska urun ailelerine kulaklik kurali uygulamaz", () => {
    expect(productTitleExclusionPattern("beyaz spor ayakkabı")).toBeNull();
  });

  it("kulak ustu ve kablosuz gereksinimini farkli urun turune gevsetmez", () => {
    const required = productTitleRequiredPatterns("kulak üstü kablosuz kulaklık");
    const fits = (title: string) => required.every((p) => new RegExp(p).test(foldForMatch(title)));
    expect(fits("Wireless Bluetooth Over Ear Headphones")).toBe(true);
    expect(fits("Bluetooth Headband Headphone")).toBe(false);
    expect(fits("Bluetooth Sleep Headband Headphones")).toBe(false);
    expect(fits("Bluetooth Clip-On Ear Type Headset")).toBe(false);
    expect(fits("Bluetooth In-Ear Earbuds")).toBe(false);
    expect(fits("Radio Receiver Headphone Compatible")).toBe(false);
    expect(fits("Over Ear Wired Headphones")).toBe(false);
    expect(productTitleRequiredPatterns("kulaklık standı")).toEqual([]);
  });
});
