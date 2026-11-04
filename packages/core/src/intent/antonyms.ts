/**
 * Sabit karsit tablosu (0171 §4.4). "Kablosuz olmayan" -> excluded kablosuz;
 * karsiti ("kablolu") yalnizca R kipinde (siralama) tercih olarak eklenir.
 * Karsitlar MODELDEN alinmaz: yalnizca bu tablodaki kapali eslemeler.
 *
 * `terms` baslik eslemesi icindir (siralama ipucu); hicbiri sert filtre olmaz.
 */
import type { AttributeKey } from "./contract.ts";
import { evidenceTokens } from "./evidence.ts";

export interface AttributeValueDef {
  key: AttributeKey;
  id: string;
  label: string;
  /** Katlanmis baslik terimleri (Turkce + Ingilizce). */
  terms: readonly string[];
}

export const ATTRIBUTE_VALUES: readonly AttributeValueDef[] = [
  {
    key: "connectivity",
    id: "wireless",
    label: "Kablosuz",
    terms: ["kablosuz", "wireless", "bluetooth", "bt"],
  },
  { key: "connectivity", id: "wired", label: "Kablolu", terms: ["kablolu", "wired"] },
  { key: "connector", id: "usb_c", label: "USB-C", terms: ["usb c", "type c", "usbc", "typec"] },
  { key: "connector", id: "lightning", label: "Lightning", terms: ["lightning"] },
  { key: "connector", id: "micro_usb", label: "Micro USB", terms: ["micro usb", "microusb"] },
  { key: "panel_type", id: "ips", label: "IPS", terms: ["ips"] },
  { key: "panel_type", id: "va", label: "VA", terms: ["va panel"] },
  { key: "panel_type", id: "oled", label: "OLED", terms: ["oled", "amoled"] },
];

/** Karsit ciftleri: ayni anahtarin iki ucu. */
const OPPOSITES: readonly (readonly [string, string])[] = [["wireless", "wired"]];

/** Model degerini (serbest metin) tablodaki kapali degere esler; yoksa null. */
export function resolveAttributeValue(key: string, value: string): AttributeValueDef | null {
  const tokens = evidenceTokens(value).join(" ");
  if (tokens.length === 0) return null;
  for (const def of ATTRIBUTE_VALUES) {
    if (def.key !== key) continue;
    if (
      def.id === tokens ||
      def.label.toLocaleLowerCase("tr-TR") === value.toLocaleLowerCase("tr-TR")
    )
      return def;
    if (def.terms.some((term) => evidenceTokens(term).join(" ") === tokens)) return def;
  }
  return null;
}

/** Kapali deger icin karsit; tabloda yoksa null (karsit uydurulmaz). */
export function oppositeOf(def: AttributeValueDef): AttributeValueDef | null {
  for (const [a, b] of OPPOSITES) {
    const other = def.id === a ? b : def.id === b ? a : null;
    if (other === null) continue;
    return ATTRIBUTE_VALUES.find((entry) => entry.key === def.key && entry.id === other) ?? null;
  }
  return null;
}
