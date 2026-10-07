import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Karar 0073: liste/arama kartlari yalnizca TEK (birincil) gorsel yukler. Galeri
 * tablosu (`offer_image`) yalnizca urun detay sayfasinda okunur; liste sorgulari
 * ona JOIN etmez, boylece kart basina uc gorsel indirilmez ve sorgu agirlasmaz.
 */
describe("listing queries stay single-image", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const listingDirs = [here, join(here, "../discovery-feed"), join(here, "../discovery")];

  it("no listing/search source reads offer_image", () => {
    const offenders: string[] = [];
    for (const dir of listingDirs) {
      for (const name of readdirSync(dir, { recursive: true }) as string[]) {
        if (!/\.ts$/.test(name) || /\.test\.ts$/.test(name) || /integration/.test(name)) continue;
        const text = readFileSync(join(dir, name), "utf8");
        if (/offer_image|offerImage/.test(text)) offenders.push(join(dir, name));
      }
    }
    expect(offenders).toEqual([]);
  });
});
