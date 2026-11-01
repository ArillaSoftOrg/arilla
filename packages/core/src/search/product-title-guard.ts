import { foldForMatch } from "./text-match.ts";

const AUDIO_DEVICE = /\b(kulakli[kg]\w*|headphones?|headsets?|earphones?|earbuds?)\b/;
const ACCESSORY_WORDS =
  "adaptor[a-z]*|adapter[a-z]*|donustur[a-z]*|converter[a-z]*|stand(s|i|in|ina|inda|inin|lar[a-z]*)?|holder[a-z]*|tutucu[a-z]*|aski[a-z]*|earpad[a-z]*|cushions?|yasti[kg](i|si|lar[a-z]*)?|socket[a-z]*|connector[a-z]*|kilif[a-z]*|case|hanger[a-z]*|bracket[a-z]*|replacement[a-z]*|cable[a-z]*|kablo|kablosu|accessor[a-z]*|aksesuar[a-z]*";
const ACCESSORY = `(^|[^a-z0-9])(${ACCESSORY_WORDS})($|[^a-z0-9])`;

/**
 * Kategorisiz bir ilanda "kulaklik uyumlu" yazmasi onu kulaklik yapmaz.
 * Cihaz aramasinda belirgin aksesuarlari aday sinirindan ONCE eleriz.
 * Kullanici aksesuar istiyorsa bu sinir uygulanmaz. Katalogda urun yoksa
 * bos sonuc dogrudur; adaptor veya sarj standi gercek eslesme diye sunulmaz.
 */
export function productTitleExclusionPattern(text: string): string | null {
  const query = foldForMatch(text);
  if (!AUDIO_DEVICE.test(query) || new RegExp(ACCESSORY).test(query)) return null;
  const overEar = /\b(kulak[ -]?ustu|over[ -]?ear|on[ -]?ear)\b/.test(query);
  return overEar
    ? `${ACCESSORY}|(^|[^a-z0-9])(earbuds?|in[ -]ear|kulak ici|open[ -]ear|clip[ -]on|bone[ -]conduction)($|[^a-z0-9])`
    : ACCESSORY;
}

/** Acikca istenen cihaz bicimi/baglanti turu head-only fallback'te kaybolmaz. */
export function productTitleRequiredPatterns(text: string): string[] {
  const query = foldForMatch(text);
  if (!AUDIO_DEVICE.test(query) || new RegExp(ACCESSORY).test(query)) return [];
  const patterns: string[] = [];
  if (/\b(kulak[ -]?ustu|over[ -]?ear|on[ -]?ear)\b/.test(query)) {
    // Spor/uyku bandi da "headband" diye satilir; kulak ustu olduguna kanit degildir.
    patterns.push(
      /\bon[ -]?ear\b/.test(query)
        ? "(^|[^a-z0-9])(on[ -]?ear)($|[^a-z0-9])"
        : "(^|[^a-z0-9])(kulak[ -]?ustu|over[ -]?ear)($|[^a-z0-9])",
    );
  }
  if (/\b(kablosuz|wireless|bluetooth)\b/.test(query)) {
    patterns.push("(^|[^a-z0-9])(kablosuz|wireless|bluetooth)($|[^a-z0-9])");
  }
  return patterns;
}
