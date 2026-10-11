/**
 * Belirleyici sorgu eslestirme (model yok). Canli testlerde (2026-10-12)
 * gorulen hatalara gore: varyant kaymasi ("16 Pro" -> "16 Pro Max"),
 * yenilenmis urun ve aksesuar (kilif, ekran koruyucu) elenir.
 */

const TR_FOLD: Record<string, string> = {
  ı: "i",
  İ: "i",
  ç: "c",
  Ç: "c",
  ğ: "g",
  Ğ: "g",
  ö: "o",
  Ö: "o",
  ş: "s",
  Ş: "s",
  ü: "u",
  Ü: "u",
};

export function tokenize(text: string): string[] {
  return text
    .replace(/[ıİçÇğĞöÖşŞüÜ]/g, (c) => TR_FOLD[c] ?? c)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\b(\d+)\s+(gb|tb)\b/g, "$1$2")
    .split(" ")
    .filter(Boolean);
}

export const VARIANT_WORDS = new Set([
  "max",
  "plus",
  "mini",
  "ultra",
  "pro",
  "air",
  "se",
  "fe",
  "lite",
]);
const CONDITION_WORDS = new Set([
  "yenilenmis",
  "yenilio",
  "outlet",
  "kalite",
  "ikinci",
  "kullanilmis",
]);
// Kok eslesmesi: Turkce ekler ("kilifi") tam kelime listesini atlatir. Ancak
// kokten sonra -li/-lu/-siz/-suz gelen sifatlar aksesuar DEGILDIR: canli testte
// "Sony WH-1000XM5 ... Kablosuz" kulaklik "kablo" koku yuzunden eleniyordu
// ("sarjli supurge" de ayni risk). "cam" koku "camasir"a uydugu icin yok.
const ACCESSORY_STEMS = [
  "uyumlu",
  "kilif",
  "kapak",
  "koruyucu",
  "film",
  "aparat",
  "sarj",
  "kablo",
  "adaptor",
  "lens",
  "tutucu",
  "aksesuar",
  "batarya",
  "yedek",
  "case",
  "cover",
  "protector",
  "glass",
  "charger",
  "cable",
];
const ADJECTIVE_SUFFIX = /^(li|lu|siz|suz)/;
const isAccessory = (tok: string) =>
  ACCESSORY_STEMS.some(
    (stem) => tok.startsWith(stem) && !ADJECTIVE_SUFFIX.test(tok.slice(stem.length)),
  );

export function isAccessoryText(text: string): boolean {
  return tokenize(text).some(isAccessory);
}

/**
 * Urun basligi sorguyla eslesiyor mu? `category` kaynagin kategori adi.
 * `coveredByPage`: urunun geldigi liste sayfasinin (Trendyol'un kendi renk/
 * cinsiyet/kategori/model filtresi) zaten kapsadigi sorgu belirtecleri; bunlarin
 * baslikta ayrica gecmesi aranmaz. Canli testte "Siyah Kadin Elbise" sayfasindaki
 * 36 urunun yalnizca 12'sinin basliginda "kadin" geciyordu.
 */
export function matchProduct(
  title: string,
  query: string,
  category: string | null = null,
  coveredByPage: readonly string[] = [],
): boolean {
  const q = tokenize(query);
  if (q.length === 0) return false;
  const t = tokenize(title);
  const tset = new Set(t);
  const qset = new Set(q);
  const covered = new Set(coveredByPage);
  if (!q.every((tok) => covered.has(tok) || tset.has(tok))) return false;
  if (t.some((tok) => VARIANT_WORDS.has(tok) && !qset.has(tok))) return false;
  const context = [...t, ...tokenize(category ?? "")];
  if (context.some((tok) => CONDITION_WORDS.has(tok) && !qset.has(tok))) return false;
  if (q.some(isAccessory)) return true;
  return !context.some(isAccessory);
}
