/**
 * Konusma dilindeki fiyat ifadeleri. Mevcut arama kaliplari
 * (`search/price-patterns.ts`: "3000 tl altı", "2000-3000 arası") burada
 * degistirilmez; bunlar onlardan ONCE calisan, takip cumlelerine ozgu
 * kaliplardir:
 *
 *   "5 bin lirayı geçmesin"  -> en fazla 5.000 TL
 *   "5000'i geçmesin"        -> en fazla 5.000 TL
 *   "en fazla 5000"          -> en fazla 5.000 TL
 *   "5 bine kadar"           -> en fazla 5.000 TL
 *   "en az 2000"             -> en az 2.000 TL
 *   "1000 ile 2000 arası"    -> 1.000 – 2.000 TL
 *   "2 bin civarı"           -> 1.600 – 2.400 TL (bkz. AROUND_BAND)
 *   "yaklaşık 20 bin"        -> 16.000 – 24.000 TL (civarı ile ayni bant)
 *   "5-10 bin arası"         -> 5.000 – 10.000 TL ("bin" iki uca da uygulanir)
 *
 * Tutarsiz ya da bagimsiz bir sayi ("5000", "iphone 16") fiyat sayilmaz:
 * sayi ancak bir fiyat kelimesiyle birlikte gelirse okunur. Tahmin yok.
 */

/**
 * "civarı" icin kullanilan sabit bant: tutarin %20 alti ile %20 ustu.
 * Arayuz uygulanan araligi acikca gosterir ("1.600 TL – 2.400 TL"), yani
 * kullanici neyin uygulandigini gorur ve cipten kaldirabilir.
 */
export const AROUND_BAND = 0.2;

/** Bir fiyat filtresi icin makul ust sinir; asan sayi fiyat sayilmaz. */
const MAX_REASONABLE_TRY = 10_000_000;

export interface ConversationalBudget {
  minKurus: number | null;
  maxKurus: number | null;
}

function parseAmount(raw: string): number | null {
  const value = Number.parseInt(raw.replace(/\./g, ""), 10);
  return Number.isFinite(value) && value > 0 && value <= MAX_REASONABLE_TRY ? value : null;
}

/**
 * "5 bin" -> "5000", "2,5 bin" -> "2500". Uzunluk korunur (sag bosluk ile)
 * ki cagiran taraf indeksleri kaydirmadan blank'leyebilsin. Ondalik yalnizca
 * tek hane ve yalnizca "bin" ile birlikte kabul edilir: "2.500" zaten binlik
 * ayracidir ve ayri okunur.
 */
export function normalizeThousands(lower: string): string {
  return lower.replace(
    /(?<![\p{L}\p{N}.,])(\d{1,4})(?:[.,](\d))?\s?bin(\p{L}{0,4})(?!\p{L})/gu,
    (whole, int: string, decimal: string | undefined, suffix: string) => {
      const value =
        Number.parseInt(int, 10) * 1000 + (decimal ? Number.parseInt(decimal, 10) * 100 : 0);
      const replaced = `${value}${suffix}`;
      return replaced.length <= whole.length ? replaced.padEnd(whole.length, " ") : whole;
    },
  );
}

/** Tutar + ekli para birimi/ek: "5000", "5000'i", "5000 tl'ye", "5000 liraya". */
const AMOUNT = String.raw`(\d[\d.]*)(?:'?\p{L}{0,4})?(?:\s*(?:tl|lira|₺)(?:'?\p{L}{0,4})?)?`;

interface Pattern {
  re: RegExp;
  apply: (amounts: number[]) => ConversationalBudget | null;
}

const PATTERNS: readonly Pattern[] = [
  {
    // "1000 ile 2000 arası", "1000 ve 2000 arasında"
    re: new RegExp(`${AMOUNT}\\s+(?:ile|ve)\\s+${AMOUNT}\\s*aras\\p{L}*`, "gu"),
    apply: ([a = 0, b = 0]) =>
      a <= b ? { minKurus: a * 100, maxKurus: b * 100 } : { minKurus: b * 100, maxKurus: a * 100 },
  },
  {
    // "en fazla 5000", "en çok 5000 tl", "maksimum 5000"
    re: new RegExp(`(?:en fazla|en çok|maksimum|maks|max|azami)\\s*${AMOUNT}`, "gu"),
    apply: ([a = 0]) => ({ minKurus: null, maxKurus: a * 100 }),
  },
  {
    // "en az 2000", "minimum 2000"
    re: new RegExp(`(?:en az|minimum|asgari)\\s*${AMOUNT}`, "gu"),
    apply: ([a = 0]) => ({ minKurus: a * 100, maxKurus: null }),
  },
  {
    // "5000'i geçmesin", "5000 lirayı aşmasın", "5000 tl'yi geçmeyen"
    re: new RegExp(`${AMOUNT}\\s+(?:geçme|aşma)\\p{L}*`, "gu"),
    apply: ([a = 0]) => ({ minKurus: null, maxKurus: a * 100 }),
  },
  {
    // "5000'e kadar", "5000 tl'ye kadar"
    re: new RegExp(`${AMOUNT}\\s+kadar(?!\\s+bir)`, "gu"),
    apply: ([a = 0]) => ({ minKurus: null, maxKurus: a * 100 }),
  },
  {
    // "yaklaşık 20000", "takriben 5000 tl", "ortalama 3 bin", "aşağı yukarı 2000"
    re: new RegExp(`(?:yaklaşık|takriben|ortalama|aşağı yukarı)\\s*${AMOUNT}`, "gu"),
    apply: ([a = 0]) => ({
      minKurus: Math.round(a * (1 - AROUND_BAND)) * 100,
      maxKurus: Math.round(a * (1 + AROUND_BAND)) * 100,
    }),
  },
  {
    // "2000 civarı", "2000 civarında", "2000 dolaylarında"
    re: new RegExp(`${AMOUNT}\\s+(?:civar|dolay)\\p{L}*`, "gu"),
    apply: ([a = 0]) => ({
      minKurus: Math.round(a * (1 - AROUND_BAND)) * 100,
      maxKurus: Math.round(a * (1 + AROUND_BAND)) * 100,
    }),
  },
];

/**
 * "5-10 bin", "5 ile 10 bin arası", "2,5-4 bin tl". Ilk sayi ikinciden
 * buyukse ("2500-10 bin") aralik sayilmaz; tahmin yok.
 */
const THOUSAND_RANGE_RE =
  /(?<![\p{L}\p{N}.,])(\d{1,4})(?:[.,](\d))?\s*(?:-|–|ile|ve)\s*(\d{1,4})(?:[.,](\d))?\s?bin\p{L}{0,4}(?:\s*(?:tl|lira|₺)'?\p{L}{0,4})?(?:\s+aras\p{L}*)?(?!\p{L})/gu;

function thousands(int: string | undefined, decimal: string | undefined): number {
  return (
    Number.parseInt(int ?? "0", 10) * 1000 + (decimal ? Number.parseInt(decimal, 10) * 100 : 0)
  );
}

function thousandRange(m: RegExpMatchArray): { minTry: number; maxTry: number } | null {
  const minTry = thousands(m[1], m[2]);
  const maxTry = thousands(m[3], m[4]);
  if (minTry <= 0 || maxTry > MAX_REASONABLE_TRY || minTry > maxTry) return null;
  return { minTry, maxTry };
}

/**
 * Metnin GERCEKTEN soyledigi TL tutarlari: rakamlar ("2500", "2.500"), "bin"
 * ifadeleri ("10 bin" -> 10000, "2,5 bin" -> 2500) ve binli araligin iki ucu
 * ("5-10 bin" -> 5000, 10000). Model ciktisindaki butce yalnizca bu kumeden
 * olabilir (`validateInterpretation`); metinde dayanagi olmayan sayi kabul edilmez.
 */
export function priceAmountsInText(text: string): Set<number> {
  const lower = text.toLocaleLowerCase("tr");
  const found = new Set<number>();
  for (const m of normalizeThousands(lower).matchAll(/\d[\d.]*/g)) {
    const value = Number.parseInt(m[0].replace(/\./g, ""), 10);
    if (Number.isFinite(value) && value > 0) found.add(value);
  }
  for (const m of lower.matchAll(THOUSAND_RANGE_RE)) {
    const range = thousandRange(m);
    if (range === null) continue;
    found.add(range.minTry);
    found.add(range.maxTry);
  }
  return found;
}

function blank(text: string, start: number, end: number): string {
  return text.slice(0, start) + " ".repeat(end - start) + text.slice(end);
}

/**
 * Metni (Turkce kucuk harf) tarar; bulunan fiyat ifadelerini bosluga cevirir.
 * Donen `rest` uzunluk olarak girdiyle aynidir ve binler normalize edilmistir.
 */
export function extractConversationalBudget(lower: string): {
  budget: ConversationalBudget | null;
  rest: string;
} {
  let rest = normalizeThousands(lower);
  let minKurus: number | null = null;
  let maxKurus: number | null = null;
  let found = false;

  // "5-10 bin arası": "bin" iki uca da aittir. Normalizasyon uzunlugu
  // korudugu icin ilk sayi yerinde 5000'e cevrilemez; aralik ham metinden
  // okunur ve ayni konum `rest`te bosaltilir.
  for (const m of lower.matchAll(THOUSAND_RANGE_RE)) {
    const range = thousandRange(m);
    if (range === null) continue;
    found = true;
    minKurus = range.minTry * 100;
    maxKurus = range.maxTry * 100;
    rest = blank(rest, m.index, m.index + m[0].length);
  }

  for (const pattern of PATTERNS) {
    for (const m of rest.matchAll(pattern.re)) {
      const amounts = m
        .slice(1)
        .filter((g): g is string => g !== undefined)
        .map(parseAmount);
      if (amounts.length === 0 || amounts.some((a) => a === null)) continue;
      const budget = pattern.apply(amounts as number[]);
      if (budget === null) continue;
      found = true;
      if (budget.minKurus !== null) minKurus = budget.minKurus;
      if (budget.maxKurus !== null) maxKurus = budget.maxKurus;
      rest = blank(rest, m.index, m.index + m[0].length);
    }
  }

  return { budget: found ? { minKurus, maxKurus } : null, rest };
}
