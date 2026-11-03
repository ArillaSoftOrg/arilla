/**
 * Turkce ek cozumleme (karar 0172). Tam bir morfolojik cozumleyici DEGILDIR: urun
 * sorgularinda sik gorulen cekim ve yapim eklerinin kapali, kucuk bir listesi. Bir ayristirma
 * yalnizca kok sozcuk dagarciginda varsa kabul edilir (sozluk dogrulamali kok bulma); boylece
 * "kulaklik" -> "kulak", "kablosuz" -> "kablo" gibi yanlis kokler kendiliginden elenir:
 * ekli bicimin kendisi dagarcikta ise hic ayristirilmaz.
 *
 * Tum isler KATLANMIS bicimde yapilir (ı/i, ü/u, ö/o, ş/s, ç/c, ğ/g birlesik); gorunen bicim
 * gerektiginde unlu uyumuyla yeniden kurulur (`renderSuffixed`).
 */

/**
 * Katlanmis ek bicimleri, uzundan kisaya. Cekim: cogul, iyelik, hal ve bunlarin sik
 * birlesimleri. Yapim: -lik/-li/-siz/-ci (yalnizca kok dagarcikta ve ekli bicim yoksa).
 */
const SUFFIXES: readonly string[] = [
  "lerinden",
  "larindan",
  "lerinde",
  "larinda",
  "lerini",
  "larini",
  "lerine",
  "larina",
  "lerden",
  "lardan",
  "lerin",
  "larin",
  "lerde",
  "larda",
  "leri",
  "lari",
  "lere",
  "lara",
  "sini",
  "sunu",
  "sinin",
  "sunun",
  "nden",
  "ndan",
  "nin",
  "nun",
  "den",
  "dan",
  "ten",
  "tan",
  "ler",
  "lar",
  "lik",
  "luk",
  "siz",
  "suz",
  "si",
  "su",
  "ni",
  "nu",
  "in",
  "un",
  "ya",
  "ye",
  "da",
  "de",
  "ta",
  "te",
  "li",
  "lu",
  "ci",
  "cu",
  "i",
  "u",
  "a",
  "e",
];

/** Ek atildiktan sonra kalmasi gereken en kisa kok. */
const MIN_STEM = 3;

/** Unsuz yumusamasinin tersi (katlanmis): kulakli[g]i -> kulakli[k], dola[b]i -> dola[p]. */
const UNSOFTEN: Readonly<Record<string, string>> = { g: "k", b: "p", d: "t" };

export interface SuffixSplit {
  /** Katlanmis kok adayi (yumusama geri alinmis olabilir). */
  stem: string;
  /** Katlanmis ek (birden fazla ek birlesik olabilir). */
  suffix: string;
  /** Kokun son harfi ekten once yumusamis yazilmis mi ("kulaklig" + "i"). */
  softened: boolean;
}

/**
 * Bir katlanmis kelimenin olasi (kok, ek) ayristirmalari; en fazla iki ek. Sozluk
 * dogrulamasi YOK; cagiran kokun dagarcikta olup olmadigina bakar.
 */
export function suffixSplits(folded: string): SuffixSplit[] {
  const out: SuffixSplit[] = [];
  const seen = new Set<string>();
  const push = (stem: string, suffix: string, softened: boolean) => {
    const key = `${stem}|${suffix}|${softened}`;
    if (stem.length < MIN_STEM || seen.has(key)) return;
    seen.add(key);
    out.push({ stem, suffix, softened });
  };
  const strip = (word: string, tail: string, depth: number) => {
    for (const suffix of SUFFIXES) {
      if (!word.endsWith(suffix) || word.length - suffix.length < MIN_STEM) continue;
      const stem = word.slice(0, -suffix.length);
      const combined = `${suffix}${tail}`;
      push(stem, combined, false);
      const last = stem[stem.length - 1] as string;
      const hard = UNSOFTEN[last];
      if (hard !== undefined && /^[aeiou]/.test(combined)) {
        push(`${stem.slice(0, -1)}${hard}`, combined, true);
      }
      if (depth < 2) strip(stem, combined, depth + 1);
    }
  };
  strip(folded, "", 1);
  return out;
}

const BACK = new Set(["a", "ı", "o", "u"]);
const ROUNDED = new Set(["o", "ö", "u", "ü"]);
const VOWEL_RE = /[aeıioöuü]/g;
const VOICELESS = new Set(["ç", "f", "h", "k", "p", "s", "ş", "t"]);

function lastVowel(text: string): string | null {
  const vowels = text.match(VOWEL_RE);
  return vowels ? (vowels[vowels.length - 1] as string) : null;
}

const SOFTEN: Readonly<Record<string, string>> = { k: "ğ", p: "b", t: "d", ç: "c" };

/**
 * Gorunen kok + katlanmis ek -> gorunen ekli kelime, unlu uyumu ve unsuz benzesmesiyle:
 * ("kılıf", "lari") -> "kılıfları"; ("koruyucu", "su") -> "koruyucusu";
 * ("kulaklık", "i", softened) -> "kulaklığı".
 */
export function renderSuffixed(stemDisplay: string, suffix: string, softened: boolean): string {
  let stem = stemDisplay;
  if (softened) {
    const last = stem[stem.length - 1] as string;
    const soft = SOFTEN[last];
    if (soft !== undefined) stem = `${stem.slice(0, -1)}${soft}`;
  }
  let previous = stem;
  let out = "";
  for (const ch of suffix) {
    const vowel = lastVowel(previous) ?? "e";
    const back = BACK.has(vowel);
    let rendered = ch;
    if (ch === "i" || ch === "u") {
      rendered = ROUNDED.has(vowel) ? (back ? "u" : "ü") : back ? "ı" : "i";
    } else if (ch === "a" || ch === "e") {
      rendered = back ? "a" : "e";
    } else if (ch === "c" || ch === "d") {
      const prev = previous[previous.length - 1] as string;
      const voiceless = VOICELESS.has(prev);
      rendered = ch === "c" ? (voiceless ? "ç" : "c") : voiceless ? "t" : "d";
    }
    out += rendered;
    previous = `${stem}${out}`;
  }
  return `${stem}${out}`;
}
