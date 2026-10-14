/**
 * Arama/liste sayfasindan urunler: `apps/live-search-extension/extract.js` (dal
 * research/live-search-extension, commit edilmemis prototip) mantiginin core'a tasinmis hali.
 * Ag istegi atmaz; kullanicinin acik sayfasindaki metinleri okur.
 *
 *  - Trendyol: `window["__single-search-result__PROPS"]` (ilk ~36 urun; trendyol-landing/listing.ts).
 *  - Hepsiburada: `<script id="reduxStore">` icindeki schema.org ItemList, yoksa JSON-LD.
 */

import { findSearchProps, listingProducts, priceTextToKurus } from "../trendyol-landing/listing.ts";
import { matchProduct } from "../trendyol-landing/match.ts";
import { type PageInputs, parseJsonLd } from "./page-inputs.ts";

export interface SearchPageProduct {
  store: "Trendyol" | "Hepsiburada";
  title: string | null;
  priceKurus: number | null;
  currency: "TRY" | null;
  imageUrl: string | null;
  productUrl: string | null;
  contentId: string | null;
  sellerId: string | null;
  variant: string | null;
  category: string | null;
  availability: "in_stock" | "out_of_stock" | "unknown";
  observedAt: string;
  source: "trendyol-search-props" | "hepsiburada-redux-itemlist" | "json-ld";
  missing: string[];
}

export interface SearchPageResult {
  source: SearchPageProduct["source"] | null;
  totalOnPage: number;
  matchedCount: number;
  products: SearchPageProduct[];
}

type Json = Record<string, unknown>;

/** Hepsiburada: voltranState.fragmentsMap.<n>.ProductList.seoState.itemListElement (metin JSON). */
export function findHepsiburadaItemList(reduxStoreText: string | null | undefined): Json[] | null {
  if (!reduxStoreText) return null;
  try {
    const fragments =
      ((JSON.parse(reduxStoreText) as Json)?.voltranState as Json)?.fragmentsMap ?? {};
    for (const fragment of Object.values(fragments as Json)) {
      const raw = (((fragment as Json)?.ProductList as Json)?.seoState as Json)?.itemListElement;
      if (typeof raw !== "string") continue;
      const items: unknown = JSON.parse(raw);
      if (Array.isArray(items)) return items as Json[];
    }
  } catch {}
  return null;
}

function fromJsonLdItems(
  items: Json[],
  origin: string,
  observedAt: string,
  source: SearchPageProduct["source"],
): SearchPageProduct[] {
  return items.map((el) => {
    const n = ((el.item as Json) ?? el) as Json;
    const offer = (Array.isArray(n.offers) ? n.offers[0] : n.offers) as Json | undefined;
    const cur = String(offer?.priceCurrency ?? "").toUpperCase();
    const currency = cur === "TRY" || cur === "TL" ? ("TRY" as const) : null;
    const priceKurus = currency
      ? priceTextToKurus(String(offer?.price ?? offer?.lowPrice ?? ""))
      : null;
    let productUrl: string | null = null;
    try {
      const u = new URL(String(n.url ?? ""), origin);
      if (u.origin === origin) productUrl = `${u.origin}${u.pathname}`;
    } catch {}
    const img = Array.isArray(n.image) ? n.image[0] : n.image;
    const imageUrl =
      typeof img === "string"
        ? img
        : (((img as Json)?.url ?? (img as Json)?.contentUrl) as string | undefined);
    const avail = String(offer?.availability ?? "").toLowerCase();
    const p: SearchPageProduct = {
      store: origin.includes("hepsiburada") ? "Hepsiburada" : "Trendyol",
      title: typeof n.name === "string" ? n.name.trim() : null,
      priceKurus,
      currency: priceKurus != null ? currency : null,
      imageUrl: typeof imageUrl === "string" && imageUrl.startsWith("https://") ? imageUrl : null,
      productUrl,
      contentId: null,
      sellerId: null,
      variant: null,
      category: null,
      availability: avail.endsWith("instock")
        ? "in_stock"
        : avail.endsWith("outofstock")
          ? "out_of_stock"
          : "unknown",
      observedAt,
      source,
      missing: [],
    };
    return withMissing(p);
  });
}

function withMissing(p: SearchPageProduct): SearchPageProduct {
  const missing: string[] = [];
  if (!p.title) missing.push("title");
  if (p.priceKurus == null) missing.push("price");
  if (!p.imageUrl) missing.push("image");
  if (!p.productUrl) missing.push("url");
  if (p.availability === "unknown") missing.push("stock");
  return { ...p, missing };
}

export function extractSearchPage(
  input: PageInputs & { query: string; limit?: number },
): SearchPageResult {
  const origin = new URL(input.url).origin;
  let all: SearchPageProduct[] = [];
  let source: SearchPageProduct["source"] | null = null;

  if (origin === "https://www.trendyol.com") {
    const props = input.scriptTexts.map(findSearchProps).find((p) => p != null) ?? null;
    if (props) {
      source = "trendyol-search-props";
      all = listingProducts(props, input.observedAt).map((p) =>
        withMissing({
          store: "Trendyol",
          title: p.title,
          priceKurus: p.priceKurus,
          currency: p.currency === "TRY" ? "TRY" : null,
          imageUrl: p.imageUrl,
          productUrl: p.productUrl,
          contentId: p.contentId,
          sellerId: p.supplierId,
          variant: p.variant,
          category: p.category,
          // Liste nesnesindeki `stock` canli testte bos ({}) geldi; stok bilinmiyor.
          availability: "unknown",
          observedAt: input.observedAt,
          source: "trendyol-search-props",
          missing: [],
        }),
      );
    }
  }
  if (!source && origin === "https://www.hepsiburada.com") {
    const items = findHepsiburadaItemList(input.reduxStoreText);
    if (items) {
      source = "hepsiburada-redux-itemlist";
      all = fromJsonLdItems(items, origin, input.observedAt, source);
    }
  }
  if (!source) {
    const nodes = parseJsonLd(input.jsonLdTexts);
    const items: Json[] = [];
    for (const n of nodes) {
      const types = Array.isArray(n["@type"]) ? n["@type"] : [n["@type"]];
      if (types.includes("ItemList") && Array.isArray(n.itemListElement))
        items.push(...(n.itemListElement as Json[]));
      else if (types.includes("Product")) items.push(n);
    }
    if (items.length) {
      source = "json-ld";
      all = fromJsonLdItems(items, origin, input.observedAt, source);
    }
  }
  const matched = all.filter(
    (p) => p.title != null && matchProduct(p.title, input.query, p.category),
  );
  return {
    source,
    totalOnPage: all.length,
    matchedCount: matched.length,
    products: matched.slice(0, input.limit ?? 3),
  };
}
