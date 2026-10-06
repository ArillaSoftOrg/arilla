/**
 * Fiyat kaliplari (docs/search.md, Kademe 2). Saf, deterministik: model, DB ve
 * ag yok. Sonuc kurus cinsinden tamsayi (CLAUDE.md: para float degil) ve para
 * birimi her zaman TRY.
 *
 *   "3000 tl altı"            -> max 3.000 TL        "20 bin altı telefon"   -> max 20.000 TL
 *   "20k altı"                -> max 20.000 TL       "20.000 TL altı"        -> max 20.000 TL
 *   "15 bin ile 25 bin arası" -> 15.000–25.000 TL    "15-25k"                -> 15.000–25.000 TL
 *   "en fazla 30k"            -> max 30.000 TL       "5000 TL'den ucuz"      -> max 5.000 TL
 *   "10 bin üstü"             -> min 10.000 TL       "en az 8 bin"           -> min 8.000 TL
 *   "1,5 milyon altı"         -> max 1.500.000 TL
 *
 * MODEL NUMARASI / OZELLIK FIYAT DEGILDIR. Bir sayi ancak bir fiyat isaretiyle
 * (para birimi: tl/₺/lira/try; ya da carpan: bin/k/milyon) VEYA bir fiyat
 * isleciyle (altı/üstü/arası/kadar/ucuz, en fazla/en az) birlikte okunur ve:
 *
 *   - bir harf ya da rakamin hemen yaninda duran sayi hic okunmaz
 *     ("s24", "a15", "rtx4060", "iphone17");
 *   - isaretsiz (tl/bin/k yok) sayi ancak PARA BICIMINDEYSE okunur: binlik
 *     noktali ("2.999") ya da yuvarlak (50'nin kati: "250", "3000"). Boylece
 *     depolama/model sayilari ("128 altı", "256", "512", "1024", "17") fiyat
 *     olmaz; kucuk sayilar ("iphone 17 altı", "en az 16 ram") zaten esigin
 *     altindadir;
 *   - isaretsiz sayinin ardindan olcu birimi gelirse okunmaz
 *     ("en az 256 gb", "en fazla 5000 mah", "en az 120 hz");
 *   - bir isleci olmayan sayi ("iphone 17 pro 256") hic fiyat degildir.
 *
 * Tahmin yoktur: emin olunamayan sayi `unparsed`'a kalir, filtre olmaz.
 */

export interface PriceMatch {
  start: number;
  end: number;
  priceMin?: number;
  priceMax?: number;
  /** Fiyat para birimi: yalnizca TRY (CLAUDE.md). */
  currency: "TRY";
}

/**
 * Isaretsiz (para birimi/carpan yok) sayi icin kurallar, TL. Neden bu degerler:
 *   - Taban: bir isleci olsa bile cok kucuk sayi bir model/ozellik numarasidir
 *     ("iphone 17 altı", "en az 16 ram"). Isleç SONRA geliyorsa ("X altı") 100,
 *     ONCE geliyorsa ("en fazla X") 1000: "en az 128" depolama, "en fazla 5000" butce.
 *   - Biçim: taban yetmez ("128", "256", "512", "1024" tabanin ustunde ama
 *     depolama/RAM). Fiyat yazan kisi yuvarlak yazar (250, 3000, 7500) ya da
 *     binlik noktasi kullanir (2.999). Ikili depolama boyutlari 50'nin kati degildir.
 * Fiyat yazan biri yuvarlak olmayan isaretsiz bir sayi yazarsa ("2999 altı")
 * filtre uygulanmaz ve sayi `unparsed`'a kalir: yanlis filtre, filtresizlikten kotu.
 * `tl`/`₺`/`bin`/`k`/`milyon` tasiyan tutarlarda bu kural yoktur.
 */
const BARE_FLOOR_AFTER_OPERATOR = 100;
const BARE_FLOOR_BEFORE_OPERATOR = 1000;
const BARE_ROUND_STEP = 50;
/** Bir fiyat filtresi icin makul ust sinir (TL); asan sayi fiyat sayilmaz. */
const MAX_REASONABLE_TRY = 100_000_000;

const UNIT_AFTER_BARE =
  /^\s*(?:gb|tb|mb|kb|mah|inç|inc|inch|hz|cm|mm|ml|lt|gr|kg|watt|w|mp|ram|ssd|hdd|çekirdek|core|adet|taksit|yıl|ay|gün|saat|dk|dakika|beden|numara|yaş|bit|nit|fps|rpm|bar|volt|v)(?![\p{L}\p{N}])/u;

// -- tutar ifadesi -------------------------------------------------------------

/**
 * Bir tutar: sayi + (bin|milyon|k) + (tl|₺|try|lira). Yakalama gruplari:
 *   1 sayi  2 bin/milyon  3 k  4 para birimi (ek dahil)
 * Sayinin onunde harf/rakam/nokta/virgul olamaz ("s24", "a15").
 */
const AMOUNT = String.raw`(?<![\p{L}\p{N}.,])(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?:\s?(bin|milyon)\p{L}{0,3}(?![\p{L}])|(k)(?![\p{L}]))?(\s*(?:tl|₺|try|lira)(?:['’]?\p{L}{0,4})?)?`;
const AMOUNT_GROUPS = 4;

interface Amount {
  /** TL cinsinden (ondalikli olabilir). */
  value: number;
  multiplier: number;
  hasMarker: boolean;
  /** Isaretsiz sayi para bicimindeyse: binlik noktali ya da yuvarlak. */
  moneyShaped: boolean;
}

function parseNumber(raw: string): number {
  // "20.000" / "1.299,90" -> binlik noktasi; "2,5" / "2.5" / "1,5" -> ondalik.
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(raw)) {
    return Number.parseFloat(raw.replace(/\./g, "").replace(",", "."));
  }
  return Number.parseFloat(raw.replace(",", "."));
}

function readAmount(groups: readonly (string | undefined)[], offset: number): Amount | null {
  const raw = groups[offset];
  if (raw === undefined) return null;
  const word = groups[offset + 1];
  const k = groups[offset + 2];
  const currency = groups[offset + 3];
  const multiplier = word === "milyon" ? 1_000_000 : word === "bin" || k ? 1000 : 1;
  const value = parseNumber(raw) * multiplier;
  if (!Number.isFinite(value) || value <= 0 || value > MAX_REASONABLE_TRY) return null;
  const grouped = /^\d{1,3}(?:\.\d{3})+/.test(raw);
  const round = Number.isInteger(value) && value % BARE_ROUND_STEP === 0;
  return {
    value,
    multiplier,
    hasMarker: multiplier > 1 || currency !== undefined,
    moneyShaped: grouped || round,
  };
}

function toKurus(value: number): number {
  return Math.round(value * 100);
}

// -- islecler ------------------------------------------------------------------

const SUFFIX = String.raw`(?:\s*['’]?(?:den|dan|ten|tan))?`;
const BELOW =
  String.raw`(?:\s+(?:ve\s+)?alt(?:ı|ında|ındaki|ına)(?![\p{L}])` +
  String.raw`|(?:\s*['’]?\p{L}{0,3})?\s+kadar(?!\s+bir)(?![\p{L}])` +
  String.raw`|${SUFFIX}\s+(?:daha\s+)?(?:ucuz|az|düşük)(?![\p{L}])` +
  String.raw`|\s+(?:geçme|aşma)\p{L}*)`;
const ABOVE =
  String.raw`(?:\s+(?:ve\s+)?(?:üstü|üzeri|üzerinde|üstünde|üstündeki|yukarı|yukarısı)(?![\p{L}])` +
  String.raw`|${SUFFIX}\s+(?:daha\s+)?(?:pahalı|fazla|yüksek)(?![\p{L}]))`;
// "max"/"min"/"maks" ISLEC DEGILDIR: "iphone 17 pro max 60 bin altı"da "max" model adidir.
const MAX_PREFIX = String.raw`(?:en\s+fazla|en\s+çok|en\s+yüksek|maksimum|azami|üst\s+limit)\s*`;
const MIN_PREFIX = String.raw`(?:en\s+az|en\s+düşük|minimum|asgari|alt\s+limit)\s*`;
const BETWEEN_SEP = String.raw`\s*(?:ile|ve|-|–|—)\s*`;

function flagged(source: string): RegExp {
  return new RegExp(source, "gu");
}

/** Normalize edilmis (kucuk harf) metin uzerinde calisir. */
export function extractPricePatterns(text: string): PriceMatch[] {
  const matches: PriceMatch[] = [];
  const consumedRanges: Array<[number, number]> = [];

  const overlaps = (start: number, end: number) =>
    consumedRanges.some(([s, e]) => start < e && end > s);

  const addMatch = (match: Omit<PriceMatch, "currency">) => {
    if (overlaps(match.start, match.end)) return;
    consumedRanges.push([match.start, match.end]);
    matches.push({ ...match, currency: "TRY" });
  };

  const bareUnitFollows = (end: number) => UNIT_AFTER_BARE.test(text.slice(end));

  // 1) Aralik: "15 bin ile 25 bin arası", "15 ile 25 bin arası", "2000-3000 arası".
  const range = flagged(`${AMOUNT}${BETWEEN_SEP}${AMOUNT}\\s*aras[ıi]\\p{L}*`);
  for (const m of text.matchAll(range)) {
    const first = readAmount(m, 1);
    const second = readAmount(m, 1 + AMOUNT_GROUPS);
    if (first === null || second === null) continue;
    let a = first.value;
    const b = second.value;
    // "15 ile 25 bin arası": carpan ikinci tutarda; birinciye de uygulanir.
    if (!first.hasMarker && second.multiplier > 1 && a < 1000) a *= second.multiplier;
    // Isaretsiz sayilar yalniz makul buyuklukte VE para biciminde ise aralik sayilir.
    const bare = [first, second].filter((amount) => !amount.hasMarker);
    if (
      bare.length === 2 &&
      (Math.min(a, b) < BARE_FLOOR_AFTER_OPERATOR || !bare.every((amount) => amount.moneyShaped))
    ) {
      continue;
    }
    addMatch({
      start: m.index,
      end: m.index + m[0].length,
      priceMin: toKurus(Math.min(a, b)),
      priceMax: toKurus(Math.max(a, b)),
    });
  }

  // 2) "arası" olmayan aralik: yalnizca ikinci tutar carpan/para birimi tasiyorsa
  //    ("15-25 bin", "15k-25k", "2000-3000 tl"); "14-16 inç" gibi olculer okunmaz.
  const rangeNoWord = flagged(`${AMOUNT}\\s*[-–—]\\s*${AMOUNT}`);
  for (const m of text.matchAll(rangeNoWord)) {
    const first = readAmount(m, 1);
    const second = readAmount(m, 1 + AMOUNT_GROUPS);
    if (first === null || second === null || !second.hasMarker) continue;
    let a = first.value;
    if (!first.hasMarker && second.multiplier > 1 && a < 1000) a *= second.multiplier;
    addMatch({
      start: m.index,
      end: m.index + m[0].length,
      priceMin: toKurus(Math.min(a, second.value)),
      priceMax: toKurus(Math.max(a, second.value)),
    });
  }

  // 3) On islec: "en fazla 30k", "en az 8 bin", "maksimum 5000 tl".
  for (const [prefix, bound] of [
    [MAX_PREFIX, "max"],
    [MIN_PREFIX, "min"],
  ] as const) {
    for (const m of text.matchAll(flagged(`${prefix}${AMOUNT}`))) {
      const amount = readAmount(m, 1);
      if (amount === null) continue;
      const end = m.index + m[0].length;
      if (!amount.hasMarker) {
        if (
          amount.value < BARE_FLOOR_BEFORE_OPERATOR ||
          !amount.moneyShaped ||
          bareUnitFollows(end)
        ) {
          continue;
        }
      }
      addMatch({
        start: m.index,
        end,
        ...(bound === "max"
          ? { priceMax: toKurus(amount.value) }
          : { priceMin: toKurus(amount.value) }),
      });
    }
  }

  // 4) Son islec: "20 bin altı", "20k altı", "5000 TL'den ucuz", "10 bin üstü".
  for (const [operator, bound] of [
    [BELOW, "max"],
    [ABOVE, "min"],
  ] as const) {
    for (const m of text.matchAll(flagged(`${AMOUNT}${operator}`))) {
      const amount = readAmount(m, 1);
      if (amount === null) continue;
      if (!amount.hasMarker && (amount.value < BARE_FLOOR_AFTER_OPERATOR || !amount.moneyShaped)) {
        continue;
      }
      addMatch({
        start: m.index,
        end: m.index + m[0].length,
        ...(bound === "max"
          ? { priceMax: toKurus(amount.value) }
          : { priceMin: toKurus(amount.value) }),
      });
    }
  }

  // 5) Eski bitisik kaliplar ("3000altı", "-3000₺"); yukaridakiler kapsamadiysa.
  const legacyBelow = /(\d[\d.]*)\s*(tl|₺|try)?\s*alt(?:ı|ında)/gu;
  for (const m of text.matchAll(legacyBelow)) {
    if (m.index > 0 && /[\p{L}\p{N}]/u.test(text[m.index - 1] ?? "")) continue;
    const raw = m[1] ?? "";
    const value = Number.parseInt(raw.replace(/\./g, ""), 10);
    if (!Number.isFinite(value) || value < BARE_FLOOR_AFTER_OPERATOR) continue;
    // Para birimi yoksa ayni para bicimi kurali: "3000altı" evet, "128altı" hayir.
    const moneyShaped = /^\d{1,3}(?:\.\d{3})+$/.test(raw) || value % BARE_ROUND_STEP === 0;
    if (m[2] === undefined && !moneyShaped) continue;
    addMatch({ start: m.index, end: m.index + m[0].length, priceMax: toKurus(value) });
  }

  const minusPrefix = /-(\d[\d.]*)\s*(?:tl|₺|try)/gu;
  for (const m of text.matchAll(minusPrefix)) {
    const value = Number.parseInt((m[1] ?? "").replace(/\./g, ""), 10);
    if (!Number.isFinite(value) || value <= 0) continue;
    addMatch({ start: m.index, end: m.index + m[0].length, priceMax: toKurus(value) });
  }

  return matches.sort((a, b) => a.start - b.start);
}
