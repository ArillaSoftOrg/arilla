import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Karar 0092: koyu tema iki blokta tanimlanir (cihaz tercihi + elle secim);
 * CSS ikisini tek kuralda birlestiremez. Bu test iki blogun ayni degerleri
 * tasidigini ve acik temanin her koyu belirtece bir karsilik verdigini denetler.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

/** `selector { ... }` govdesindeki `--ad: deger;` ciftleri (ilk eslesen blok). */
function declarations(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`blok yok: ${selector}`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  const body = css.slice(open + 1, close);
  const result = new Map<string, string>();
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    result.set(match[1] as string, (match[2] as string).replace(/\s+/g, " ").trim());
  }
  return result;
}

describe("tokens.css tema bloklari", () => {
  const css = read("../../../packages/ui/src/tokens.css");
  const mediaDark = declarations(css, ':root:not([data-theme="light"])');
  const forcedDark = declarations(css, ':root[data-theme="dark"]');
  const light = declarations(css, ":root");

  it("cihaz tercihi koyu blok ile elle secilen koyu blok aynidir", () => {
    expect(mediaDark.size).toBeGreaterThan(20);
    expect(Object.fromEntries(forcedDark)).toEqual(Object.fromEntries(mediaDark));
  });

  it("koyu temanin degistirdigi her belirtecin acik temada bir degeri vardir", () => {
    const missing = [...mediaDark.keys()].filter((name) => !light.has(name));
    expect(missing).toEqual([]);
  });

  it("acik tema sayfa zemini saf beyaz degildir; kartlar beyaz yukselir", () => {
    expect(light.get("--paper")).not.toBe("#ffffff");
    expect(light.get("--surface-raised")).toBe("#ffffff");
  });

  it("elle secimde yerel kontroller de secilen temada cizilir", () => {
    expect(css).toMatch(/:root\[data-theme="light"\] \{\s*color-scheme: light;/);
    expect(css).toMatch(/:root\[data-theme="dark"\] \{\s*color-scheme: dark;/);
  });
});

describe("yonetim kabugu koyu tema bloklari", () => {
  const css = read("./yonetim/admin.module.css");

  it("cihaz tercihi ve elle secim ayni degerleri tasir", () => {
    const media = declarations(css, ':global(:root:not([data-theme="light"])) .shell');
    const forced = declarations(css, ':global(:root[data-theme="dark"]) .shell');
    expect(media.size).toBeGreaterThan(0);
    expect(Object.fromEntries(forced)).toEqual(Object.fromEntries(media));
  });
});
