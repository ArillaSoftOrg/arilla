/**
 * Sorgu <-> baslik eslestirme. Yalnizca belirleyici kurallar; model yok.
 * Amac yanlis-pozitifi azaltmak: "16 Pro" sorgusuna "16 Pro Max" donmez.
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

export function normalize(text: string): string {
  return text
    .replace(/[ıİçÇğĞöÖşŞüÜ]/g, (c) => TR_FOLD[c] ?? c)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** "128 gb" -> "128gb": sayi + birim tek belirtec olur. */
export function tokenize(text: string): string[] {
  return normalize(text)
    .replace(/\b(\d+)\s+(gb|tb)\b/g, "$1$2")
    .split(" ")
    .filter(Boolean);
}

/** Sorguda yoksa basliga girmemesi gereken model/varyant sozcukleri. */
const VARIANT_WORDS = new Set(["max", "plus", "mini", "ultra", "pro", "air", "se", "fe", "lite"]);
/** Sorguda istenmedikce elenen durum sozcukleri (yenilenmis, outlet...). */
const CONDITION_WORDS = new Set([
  "yenilenmis",
  "yenilio",
  "outlet",
  "kalite",
  "ikinci",
  "kullanilmis",
]);

export interface MatchResult {
  ok: boolean;
  reason?: string;
}

export function matchTitle(title: string, query: string): MatchResult {
  const q = tokenize(query);
  if (q.length === 0) return { ok: false, reason: "empty-query" };
  const t = tokenize(title);
  const tset = new Set(t);
  const qset = new Set(q);
  for (const tok of q) if (!tset.has(tok)) return { ok: false, reason: `missing:${tok}` };
  for (const tok of t) {
    if (VARIANT_WORDS.has(tok) && !qset.has(tok)) return { ok: false, reason: `variant:${tok}` };
    if (CONDITION_WORDS.has(tok) && !qset.has(tok))
      return { ok: false, reason: `condition:${tok}` };
  }
  return { ok: true };
}

/** Kategori secimi icin sorgudaki harfli, anlamli belirtecler. */
export function queryWords(query: string): string[] {
  return tokenize(query).filter((t) => /^[a-z]{3,}$/.test(t) && t !== "gb" && t !== "tb");
}
