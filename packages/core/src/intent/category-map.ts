/**
 * IntentV2 urun turu -> katalog kategorisi (docs/decisions/0171 §4.2).
 *
 * Neden ayri tablo: `clarification/product-types.ts` yollari (ornek
 * `ev-yasam`, `saglik-kozmetik/kozmetik`, `anne-bebek`, `kitap-muzik-hobi`)
 * uretim katalogunda bos ya da neredeyse bos koklere isaret ediyor; o dosya v1
 * netlestirme motorunu da besledigi icin DEGISTIRILMEZ (mevcut davranis
 * korunur). Niyet katmani yalnizca bu tabloyu kullanir.
 *
 * Kesin filtre (H) kurali: tur, uretimde salt okunur olculmus ornekleme gore
 * (basliginda tur bas ismi gecen urunler, en fazla 5.000) yolun alt agacinda
 * EN AZ %90 ve kategorisiz (category_id NULL) urun oraninda EN FAZLA %5 ise
 * `hard: true`. Aksi halde yol yalnizca SIRALAMA ipucudur (R): kategori
 * belirsizken yanlis kategori kesin bilgi gibi uygulanmaz. Kategori filtresi
 * `c.path = yol OR c.path LIKE yol || '/%'` oldugu icin alt kategoriler kapsanir.
 *
 * Olcum yenilenince `evidence` ve `verifiedOn` guncellenir; esik testle sabit.
 */
export const HARD_MIN_IN_PATH = 0.9;
export const HARD_MAX_NO_CATEGORY = 0.05;

export interface IntentCategoryEvidence {
  /** Ornekteki urun sayisi (en fazla 5.000). */
  sampled: number;
  /** Yolun alt agacindaki urun sayisi (`hardPath` icin). */
  inPath: number;
  /** Kategorisiz urun sayisi. */
  noCategory: number;
}

export interface IntentCategory {
  /** H icin olculen (genelde kok) yol; filtre yalnizca bu yolla uygulanir. */
  hardPath: string;
  /** Siralama ipucu yolu: turun en yogun, dolu alt kategorisi. */
  hintPath: string;
  hard: boolean;
  evidence: IntentCategoryEvidence;
}

const VERIFIED_ON = "2026-11-07";

function entry(
  hardPath: string,
  hintPath: string,
  evidence: IntentCategoryEvidence,
): IntentCategory {
  const hard =
    evidence.sampled >= 1000 &&
    evidence.inPath / evidence.sampled >= HARD_MIN_IN_PATH &&
    evidence.noCategory / evidence.sampled <= HARD_MAX_NO_CATEGORY;
  return { hardPath, hintPath, hard, evidence };
}

/** Uretim katalogu, salt okunur olcum (12,26 milyon urun), `VERIFIED_ON`. */
export const INTENT_CATEGORY_MAP: Readonly<Record<string, IntentCategory>> = {
  laptop: entry("elektronik", "elektronik/bilgisayar-grubu", {
    sampled: 5000,
    inPath: 2257,
    noCategory: 1099,
  }),
  tablet: entry("elektronik", "elektronik", { sampled: 5000, inPath: 4120, noCategory: 129 }),
  monitor: entry("elektronik", "elektronik/bilgisayar-grubu", {
    sampled: 5000,
    inPath: 1280,
    noCategory: 2415,
  }),
  game_console: entry("elektronik", "elektronik/oyun-oyun-konsollari", {
    sampled: 5000,
    inPath: 4801,
    noCategory: 24,
  }),
  perfume: entry("kozmetik-kisisel-bakim", "kozmetik-kisisel-bakim/parfum-ve-deodorant", {
    sampled: 5000,
    inPath: 2725,
    noCategory: 1600,
  }),
  stroller: entry("anne-bebek-cocuk", "anne-bebek-cocuk/cocuk-gerecleri", {
    sampled: 5000,
    inPath: 3940,
    noCategory: 284,
  }),
  tent: entry("spor-outdoor", "spor-outdoor/ekipman-aksesuar", {
    sampled: 5000,
    inPath: 1030,
    noCategory: 567,
  }),
  // Kitap basliklari tur adini tasimaz; ornek (4) dogrulamaya yetmez.
  book: entry("kitap", "kitap", { sampled: 4, inPath: 2, noCategory: 2 }),
  vacuum: entry("elektronik", "elektronik", { sampled: 5000, inPath: 1048, noCategory: 2630 }),
};

export const INTENT_CATEGORY_VERIFIED_ON = VERIFIED_ON;

export function intentCategoryFor(typeId: string): IntentCategory | null {
  return INTENT_CATEGORY_MAP[typeId] ?? null;
}
