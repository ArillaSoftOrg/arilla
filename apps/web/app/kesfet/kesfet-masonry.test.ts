import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

describe("Keşfet masonry sözleşmesi", () => {
  it("görünüm ortak DiscoveryGrid yerine Keşfet masonry'sini kullanır", () => {
    const view = read("kesfet-view.tsx");
    expect(view).toContain("DiscoverMasonry");
    expect(view).not.toContain("DiscoveryGrid");
  });

  it("kart tek bağlantı, ilk satır eager, gerisi lazy", () => {
    const card = read("discover-card.tsx");
    expect((card.match(/<a /g) ?? []).length).toBe(1);
    expect(card).toContain('priority ? "eager" : "lazy"');
  });

  it("hover ve animasyonlar reduced-motion ve hover medya sorgusuna bağlı", () => {
    const css = read("discover.module.css");
    expect(css).toContain("(hover: hover) and (prefers-reduced-motion: no-preference)");
    expect(css).toMatch(/grid-template-columns: repeat\(4/);
    expect(css).toContain("--discover-radius: 22px");
  });
});
