/**
 * Urun sayfasi / liste sayfasi veri cikarma. Sira: JSON-LD (schema.org) >
 * Open Graph. Dogrulanamayan alan URETILMEZ; null kalir ve `missing`e yazilir.
 */

export type Availability = "in_stock" | "out_of_stock" | "preorder" | "unknown";

export interface LiveProduct {
  title: string | null;
  /** Ondalik dize ("149999.00"); yalnizca kaynakta gecen deger. */
  price: string | null;
  /** Kurus cinsinden tamsayi (CLAUDE.md: fiyat asla float). */
  priceKurus: number | null;
  currency: string | null;
  imageUrl: string | null;
  productUrl: string;
  merchant: string;
  availability: Availability;
  condition: "new" | "refurbished" | "used" | "unknown";
  lastCheckedAt: string;
  source: "json-ld" | "item-list" | "open-graph";
  /** Kaynakta bulunamayan alanlar. */
  missing: string[];
  /** Sayfanin isRelatedTo baglantilari (kesfi genisletmek icin). */
  relatedUrls: string[];
}

type Json = Record<string, unknown>;

export function parseJsonLd(html: string): Json[] {
  const out: Json[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    try {
      const parsed: unknown = JSON.parse(m[1] ?? "");
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of list) {
        if (node && typeof node === "object") {
          const graph = (node as Json)["@graph"];
          if (Array.isArray(graph)) {
            out.push(...(graph.filter((g) => g && typeof g === "object") as Json[]));
          } else out.push(node as Json);
        }
      }
    } catch {
      // bozuk blok yok sayilir
    }
  }
  return out;
}

function asArray<T>(v: T | T[] | undefined | null): T[] {
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

function typeOf(node: Json): string[] {
  return asArray(node["@type"] as string | string[]).map(String);
}

/** "149999.00" / "149.999,00" -> {price:"149999.00", kurus:14999900}; aksi halde null. */
export function parsePrice(raw: unknown): { price: string; kurus: number } | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  let s = String(raw).trim();
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(",", ".");
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const kurusPart = Number((m[2] ?? "").padEnd(2, "0") || "0");
  const kurus = Number(m[1]) * 100 + kurusPart;
  if (!Number.isSafeInteger(kurus) || kurus <= 0) return null;
  return { price: `${m[1]}.${String(kurusPart).padStart(2, "0")}`, kurus };
}

function mapAvailability(v: unknown): Availability {
  const s = typeof v === "string" ? v.toLowerCase() : "";
  if (s.endsWith("instock") || s.endsWith("limitedavailability")) return "in_stock";
  if (s.endsWith("outofstock") || s.endsWith("soldout") || s.endsWith("discontinued")) {
    return "out_of_stock";
  }
  if (s.endsWith("preorder") || s.endsWith("presale")) return "preorder";
  return "unknown";
}

function mapCondition(v: unknown): LiveProduct["condition"] {
  const s = typeof v === "string" ? v.toLowerCase() : "";
  if (s.endsWith("newcondition")) return "new";
  if (s.endsWith("refurbishedcondition")) return "refurbished";
  if (s.endsWith("usedcondition")) return "used";
  return "unknown";
}

function firstHttpsImage(v: unknown): string | null {
  for (const item of asArray(v)) {
    if (typeof item === "string" && item.startsWith("https://")) return item;
    if (item && typeof item === "object") {
      const o = item as Json;
      const found = firstHttpsImage(o.contentUrl ?? o.url);
      if (found) return found;
    }
  }
  return null;
}

/** Urun adresini kok + yol'a indirger (sorgu/parcayi atar); urun adresi degilse null. */
export function canonicalProductUrl(raw: string, origin: string): string | null {
  try {
    const u = new URL(raw, origin);
    if (u.origin !== origin || !/-p-\d+$/.test(u.pathname)) return null;
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}

export interface ExtractContext {
  pageUrl: string;
  origin: string;
  merchant: string;
  checkedAt: string;
}

export function productFromNode(
  node: Json,
  ctx: ExtractContext & { source: LiveProduct["source"] },
): LiveProduct | null {
  const url = canonicalProductUrl(String(node.url ?? node["@id"] ?? ctx.pageUrl), ctx.origin);
  if (!url) return null;
  const offer = asArray(node.offers as Json | Json[]).find((o) => o && typeof o === "object");
  const parsed = parsePrice(offer ? (offer.price ?? offer.lowPrice) : undefined);
  const currency =
    offer && typeof offer.priceCurrency === "string" && /^[A-Z]{3}$/.test(offer.priceCurrency)
      ? offer.priceCurrency
      : null;
  const title = typeof node.name === "string" && node.name.trim() ? node.name.trim() : null;
  const imageUrl = firstHttpsImage(node.image);
  // Para birimi dogrulanamayan fiyat gosterilmez.
  const price = parsed && currency ? parsed : null;
  const availability = offer ? mapAvailability(offer.availability) : "unknown";
  const missing: string[] = [];
  if (!title) missing.push("title");
  if (!price) missing.push("price");
  if (!currency) missing.push("currency");
  if (!imageUrl) missing.push("imageUrl");
  if (availability === "unknown") missing.push("availability");
  return {
    title,
    price: price?.price ?? null,
    priceKurus: price?.kurus ?? null,
    currency: price ? currency : null,
    imageUrl,
    productUrl: url,
    merchant: ctx.merchant,
    availability,
    condition: offer ? mapCondition(offer.itemCondition) : "unknown",
    lastCheckedAt: ctx.checkedAt,
    source: ctx.source,
    missing,
    relatedUrls: asArray(node.isRelatedTo as string | string[])
      .map((u) => canonicalProductUrl(String(u), ctx.origin))
      .filter((u): u is string => u !== null),
  };
}

function ogMeta(html: string, prop: string): string | null {
  const re = new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']*)["']`, "i");
  return re.exec(html)?.[1]?.trim() || null;
}

/** Urun sayfasindan tek urun: once JSON-LD Product/ProductGroup, yoksa Open Graph. */
export function extractProductPage(html: string, ctx: ExtractContext): LiveProduct | null {
  for (const node of parseJsonLd(html)) {
    if (typeOf(node).some((t) => t === "Product" || t === "ProductGroup")) {
      const p = productFromNode(node, { ...ctx, source: "json-ld" });
      if (p) return p;
    }
  }
  const url = canonicalProductUrl(ctx.pageUrl, ctx.origin);
  const title = ogMeta(html, "og:title");
  if (!url || !title) return null;
  const image = ogMeta(html, "og:image");
  const imageUrl = image?.startsWith("https://") ? image : null;
  return {
    title,
    price: null,
    priceKurus: null,
    currency: null,
    imageUrl,
    productUrl: url,
    merchant: ctx.merchant,
    availability: "unknown",
    condition: "unknown",
    lastCheckedAt: ctx.checkedAt,
    source: "open-graph",
    missing: ["price", "currency", "availability", ...(imageUrl ? [] : ["imageUrl"])],
    relatedUrls: [],
  };
}

/** Liste sayfasindaki JSON-LD ItemList icindeki urunler. */
export function extractListingProducts(html: string, ctx: ExtractContext): LiveProduct[] {
  const out: LiveProduct[] = [];
  for (const node of parseJsonLd(html)) {
    if (!typeOf(node).includes("ItemList")) continue;
    for (const el of asArray(node.itemListElement as Json[])) {
      const item = (el.item ?? el) as Json;
      if (!item || typeof item !== "object") continue;
      const p = productFromNode(item, { ...ctx, source: "item-list" });
      if (p) out.push(p);
    }
  }
  return out;
}
