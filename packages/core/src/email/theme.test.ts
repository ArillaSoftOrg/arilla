import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EMAIL_DARK, EMAIL_LIGHT } from "./theme.ts";

const DESIGN = readFileSync(new URL("../../../../docs/design.md", import.meta.url), "utf8");

/** docs/design.md tablosundan `--token` için [açık, koyu] hex çiftini okur. */
function tokenPair(token: string): [string, string] {
  const row = DESIGN.split("\n").find(
    (line) => line.startsWith("| ") && line.includes(`\`${token}\``),
  );
  if (!row) throw new Error(`design.md'de ${token} yok`);
  const hex = row.match(/#[0-9A-Fa-f]{6}/g);
  if (!hex || hex.length < 2) throw new Error(`${token} için açık/koyu değer yok`);
  return [(hex[0] as string).toUpperCase(), (hex[1] as string).toUpperCase()];
}

describe("e-posta paleti docs/design.md ile eşleşir", () => {
  const mapping = {
    page: "--paper",
    card: "--surface-raised",
    ink: "--ink",
    inkSecondary: "--ink-secondary",
    inkMuted: "--ink-muted",
    line: "--line",
    accent: "--accent",
    accentForeground: "--accent-foreground",
    surface: "--surface",
  } as const;

  it.each(Object.entries(mapping))("%s ↔ %s", (key, token) => {
    const [light, dark] = tokenPair(token);
    expect(EMAIL_LIGHT[key as keyof typeof EMAIL_LIGHT].toUpperCase()).toBe(light);
    expect(EMAIL_DARK[key as keyof typeof EMAIL_DARK].toUpperCase()).toBe(dark);
  });
});
