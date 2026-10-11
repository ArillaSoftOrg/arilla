/**
 * Model ciktisinin ayristirilmasi ve DOGRULANMASI (docs/decisions/0102).
 *
 * Model ciktisi guvenilmez veridir. Bir aday ancak su kosullarla gosterilir:
 *  1. adres guvenli, genel https adresidir (`toSafePublicUrl`);
 *  2. adres, aramanin GERCEKTEN dondurdugu (atif) ya da URL Context ile
 *     okunan sayfalar arasindadir - model adresi uyduramaz ya da degistiremez;
 *  3. sayfa bir urun sayfasidir (model beyani + bariz arama/liste yolu degil).
 *
 * Fiyat yalnizca sayfa URL Context ile BASARIYLA okunduysa VE modelin verdigi
 * kanit metni ayni TRY tutarini iceriyorsa "verified" olur. Aksi halde fiyat
 * hic gosterilmez (`priceKurus: null`, `unverified`); uydurulmaz. Stok da
 * yalnizca okunan sayfada bilinir.
 */
import { WEB_SEARCH_MAX_CANDIDATES } from "./config.ts";
import { looksLikeProductPage, type SafeUrl, toSafePublicUrl } from "./url-safety.ts";

export interface WebCandidate {
  title: string;
  brand: string | null;
  url: SafeUrl;
  declaredKind: "exact" | "similar";
  priceKurus: number | null;
  priceStatus: "verified" | "unverified";
  inStock: boolean | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Kod blogu cercevesini ve metin etrafini atip ilk JSON nesnesini okur. */
export function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Gorunen metin: HTML/adres/kontrol karakteri atilir, bosluk sadelesir, kisaltilir. */
export function sanitizeDisplayText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/<[^>]*>/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: kontrol karakterleri bilerek atilir.
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length < 2) return null;
  return cleaned.length > max ? `${cleaned.slice(0, max - 1).trimEnd()}…` : cleaned;
}

/**
 * Metindeki TRY tutarlarini kurusa cevirir (kayan nokta yok). Turkce
 * (`1.299,90`) ve ondalik nokta (`1299.90`) bicimlerini tanir.
 */
export function parsePricesKurus(text: string): number[] {
  const found: number[] = [];
  for (const match of text.matchAll(/\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?/g)) {
    const raw = match[0];
    let whole: string;
    let fraction = "";
    if (raw.includes(".") && raw.includes(",")) {
      const [w, f] = raw.split(",");
      whole = (w ?? "").replace(/\./g, "");
      fraction = f ?? "";
    } else if (raw.includes(",")) {
      const [w, f] = raw.split(",");
      whole = w ?? "";
      fraction = f ?? "";
    } else if (raw.includes(".")) {
      if (/^\d{1,3}(?:\.\d{3})+$/.test(raw)) {
        whole = raw.replace(/\./g, "");
      } else {
        const [w, f] = raw.split(".");
        whole = w ?? "";
        fraction = f ?? "";
      }
    } else {
      whole = raw;
    }
    const kurus = Number(whole) * 100 + Number(fraction.padEnd(2, "0").slice(0, 2));
    if (Number.isSafeInteger(kurus) && kurus > 0) found.push(kurus);
  }
  return found;
}

export interface GroundingEvidence {
  /** Atif/okunan sayfa anahtarlari (`SafeUrl.key`): ana makine + yol. */
  groundedKeys: ReadonlySet<string>;
  /** URL Context ile BASARIYLA okunan sayfalarin anahtarlari. */
  retrievedKeys: ReadonlySet<string>;
}

export function buildGroundingEvidence(
  citationUrls: readonly string[],
  retrieved: readonly { url: string; ok: boolean }[],
): GroundingEvidence {
  const grounded = new Set<string>();
  const read = new Set<string>();
  for (const url of citationUrls) {
    const safe = toSafePublicUrl(url);
    if (safe) grounded.add(safe.key);
  }
  for (const page of retrieved) {
    const safe = toSafePublicUrl(page.url);
    if (!safe) continue;
    if (page.ok) {
      read.add(safe.key);
      grounded.add(safe.key);
    }
  }
  return { groundedKeys: grounded, retrievedKeys: read };
}

export interface ParseStats {
  received: number;
  rejected: number;
  /** Eleme nedenlerine gore sayac (icerik yok; yalnizca tanilama). */
  reasons: Record<string, number>;
}

/** Ham model metnini dogrulanmis adaylara cevirir. Gecersiz her aday sessizce elenir. */
export function parseAndVerifyCandidates(
  text: string,
  evidence: GroundingEvidence,
): { candidates: WebCandidate[]; stats: ParseStats } {
  const root = extractJsonObject(text);
  const list = isRecord(root) && Array.isArray(root.results) ? root.results : [];
  const stats: ParseStats = { received: Math.min(list.length, 50), rejected: 0, reasons: {} };
  const candidates: WebCandidate[] = [];
  const seenKeys = new Set<string>();

  for (const raw of list.slice(0, WEB_SEARCH_MAX_CANDIDATES * 2)) {
    const candidate = verifyOne(raw, evidence);
    if (typeof candidate === "string" || seenKeys.has(candidate.url.key)) {
      stats.rejected++;
      const reason = typeof candidate === "string" ? candidate : "duplicate";
      stats.reasons[reason] = (stats.reasons[reason] ?? 0) + 1;
      continue;
    }
    seenKeys.add(candidate.url.key);
    candidates.push(candidate);
    if (candidates.length >= WEB_SEARCH_MAX_CANDIDATES) break;
  }
  return { candidates, stats };
}

function verifyOne(raw: unknown, evidence: GroundingEvidence): WebCandidate | string {
  if (!isRecord(raw)) return "shape";
  const title = sanitizeDisplayText(raw.title, 160);
  if (title === null) return "title";
  const url = toSafePublicUrl(raw.url);
  if (url === null) return "unsafe_url";
  // 2) Adres aramanin dondurdugu ya da okunan sayfalardan biri olmali.
  if (!evidence.groundedKeys.has(url.key)) return "ungrounded";
  // 3) Urun sayfasi: model beyani + bariz arama/liste yolu degil.
  if (raw.pageType !== "product") return "page_type";
  if (!looksLikeProductPage(url.url)) return "not_product_path";
  const declaredKind =
    raw.matchKind === "exact" ? "exact" : raw.matchKind === "similar" ? "similar" : null;
  if (declaredKind === null) return "match_kind";

  const pageRead = evidence.retrievedKeys.has(url.key);
  let priceKurus: number | null = null;
  let inStock: boolean | null = null;
  if (pageRead) {
    inStock = typeof raw.inStock === "boolean" ? raw.inStock : null;
    const price = raw.price;
    if (
      isRecord(price) &&
      typeof price.amount === "number" &&
      Number.isFinite(price.amount) &&
      price.amount > 0 &&
      price.amount < 10_000_000 &&
      typeof price.currency === "string" &&
      price.currency.trim().toUpperCase() === "TRY" &&
      typeof price.evidence === "string" &&
      price.evidence.length <= 300
    ) {
      const kurus = Math.round(price.amount * 100);
      // Kanit metni ayni tutari gercekten icermeli.
      if (parsePricesKurus(price.evidence).includes(kurus)) priceKurus = kurus;
    }
  }

  const brand = sanitizeDisplayText(raw.brand, 60);
  return {
    title,
    brand,
    url,
    declaredKind,
    priceKurus,
    priceStatus: priceKurus === null ? "unverified" : "verified",
    inStock,
  };
}
