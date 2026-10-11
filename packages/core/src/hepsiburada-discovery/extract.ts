/**
 * Urun sayfasi HTML'inden JSON-LD (schema.org Product/Offer) ile urun cikarimi.
 * Yalnizca sayfada GERCEKTEN bulunan alanlar doner; eksik alan null kalir,
 * hicbir deger uretilmez ya da tahmin edilmez.
 */

export type Availability = "in_stock" | "out_of_stock" | "unknown";

export interface DiscoveredProduct {
  title: string;
  /** Kurus cinsinden tamsayi (CLAUDE.md: fiyat asla float). Fiyat yoksa null. */
  priceKurus: number | null;
  currency: string | null;
  imageUrl: string | null;
  productUrl: string;
  merchant: string;
  availability: Availability;
  lastCheckedAt: string;
}

const HOST_RE = /(^|\.)hepsiburada\.com$/i;

function asArray<T>(v: T | T[] | undefined | null): T[] {
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** <script type="application/ld+json"> bloklarini JSON olarak okur; bozuklar atlanir. */
export function readJsonLdBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    try {
      out.push(JSON.parse((m[1] ?? "").trim()));
    } catch {
      /* bozuk blok: atla */
    }
  }
  return out;
}

function flattenNodes(root: unknown): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  const visit = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(visit);
    if (!isRecord(n)) return;
    nodes.push(n);
    if (n["@graph"]) visit(n["@graph"]);
  };
  visit(root);
  return nodes;
}

function hasType(node: Record<string, unknown>, type: string): boolean {
  return asArray(node["@type"] as string | string[]).some(
    (t) => String(t).toLowerCase() === type.toLowerCase(),
  );
}

/** "1.299,90" / "1299.90" / 1299.9 -> 129990. Gecersiz ya da <= 0 ise null. */
export function parsePriceToKurus(raw: unknown): number | null {
  let s = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;
  s = s.replace(/[^\d.,]/g, "");
  if (s.includes(",") && s.includes(".")) {
    const dec = s.lastIndexOf(",") > s.lastIndexOf(".") ? "," : ".";
    const thou = dec === "," ? "." : ",";
    s = s.split(thou).join("").replace(dec, ".");
  } else if (s.includes(",")) {
    s = /,\d{1,2}$/.test(s) ? s.replace(",", ".") : s.split(",").join("");
  } else if ((s.match(/\./g) ?? []).length > 1 || /\.\d{3}$/.test(s)) {
    s = s.split(".").join("");
  }
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

function mapAvailability(raw: unknown): Availability {
  const s = typeof raw === "string" ? raw.toLowerCase() : "";
  if (s.endsWith("instock") || s.endsWith("limitedavailability") || s.endsWith("onlineonly")) {
    return "in_stock";
  }
  if (s.endsWith("outofstock") || s.endsWith("soldout") || s.endsWith("discontinued")) {
    return "out_of_stock";
  }
  return "unknown";
}

function firstImage(v: unknown): string | null {
  for (const item of asArray(v)) {
    const url = typeof item === "string" ? item : isRecord(item) ? item.url : null;
    if (typeof url === "string" && /^https:\/\//i.test(url)) return url;
  }
  return null;
}

/** Adres yalnizca https ve hepsiburada.com alan adinda kabul edilir. */
export function normalizeProductUrl(raw: string, base: string): string | null {
  try {
    const u = new URL(raw, base);
    if (u.protocol !== "https:" || !HOST_RE.test(u.hostname) || u.username || u.password) {
      return null;
    }
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|gclid|fbclid|srsltid)/i.test(k)) u.searchParams.delete(k);
    }
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Bir urun sayfasindan JSON-LD Product dugumunu cikarir. Baslik ya da gecerli
 * adres yoksa null doner (kismi/uydurma kayit uretilmez).
 */
export function extractProductFromHtml(
  html: string,
  pageUrl: string,
  checkedAt: string,
): DiscoveredProduct | null {
  const nodes = readJsonLdBlocks(html).flatMap(flattenNodes);
  const product = nodes.find((n) => hasType(n, "Product"));
  if (!product) return null;

  const title = typeof product.name === "string" ? product.name.trim() : "";
  const productUrl =
    normalizeProductUrl(typeof product.url === "string" ? product.url : pageUrl, pageUrl) ??
    normalizeProductUrl(pageUrl, pageUrl);
  if (!title || !productUrl) return null;

  const offer = asArray(product.offers).filter(isRecord)[0];
  const priceKurus = parsePriceToKurus(offer ? (offer.price ?? offer.lowPrice) : undefined);
  const currency =
    priceKurus !== null && offer && typeof offer.priceCurrency === "string"
      ? offer.priceCurrency.toUpperCase()
      : null;

  let merchant = "Hepsiburada";
  const seller = offer?.seller;
  if (isRecord(seller) && typeof seller.name === "string" && seller.name.trim()) {
    merchant = seller.name.trim();
  }

  return {
    title,
    priceKurus,
    currency,
    imageUrl: firstImage(product.image),
    productUrl,
    merchant,
    availability: mapAvailability(offer?.availability),
    lastCheckedAt: checkedAt,
  };
}

/** Liste sayfasindaki urun baglantilari (Hepsiburada urun yolu: ...-p-KOD / ...-pm-KOD). */
export function extractProductLinks(html: string, pageUrl: string, limit: number): string[] {
  const seen = new Set<string>();
  for (const m of html.matchAll(/href=["']([^"']+)["']/gi)) {
    const url = normalizeProductUrl((m[1] ?? "").replace(/&amp;/g, "&"), pageUrl);
    if (!url) continue;
    const u = new URL(url);
    if (!/-pm?-[A-Za-z0-9]+$/.test(u.pathname)) continue;
    u.search = "";
    seen.add(u.toString());
    if (seen.size >= limit) break;
  }
  return [...seen];
}
