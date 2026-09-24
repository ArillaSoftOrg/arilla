import type { CSSProperties } from "react";

/**
 * docs/design.md "Boşluk": `--space-N` olcegindeki adimlar. Duzen ilkeleri
 * (`Stack`, `Cluster`) yalnizca bu adimlari kabul eder - tek seferlik piksel
 * degeri gecilemez.
 */
export type SpaceStep = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 8 | 10 | 12 | 16 | 24 | 32;

/** Bosluk adimini bilesenin CSS modulunun okudugu `--layout-gap`'e baglar. */
export function gapStyle(gap: SpaceStep, style?: CSSProperties): CSSProperties {
  return {
    ...style,
    "--layout-gap": gap === 0 ? "0" : `var(--space-${gap})`,
  } as CSSProperties;
}

/**
 * `list-style: none` WebKit/VoiceOver'da `ul`/`ol`'un liste rolunu dusurur;
 * duzen ilkesi liste olarak kullanildiginda rol acikca geri verilir.
 */
export function listRole(tag: string, role: string | undefined): string | undefined {
  if (role !== undefined) return role;
  return tag === "ul" || tag === "ol" ? "list" : undefined;
}

export function joinClassNames(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(" ");
}
