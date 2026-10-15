/**
 * Hepsiburada URUN sayfasindan ana satici, varyant etiketi ve GTIN (karar 0117).
 *
 * DOGRULANMADI: arsivde gercek bir urun sayfasi kaydi yok; bu okuyucu yalnizca
 * schema.org `Product` JSON-LD standardina dayanir (`offers.seller.name`,
 * `gtin*`, `color`, `size`). Gercek isaretleme farkliysa alanlar `null` doner,
 * hicbir sey uydurulmaz. Toplayiciya BAGLI DEGILDIR: ilk pilotta gercek bir sayfa
 * ornegiyle dogrulanmadan baglanmaz. Diger saticilarin teklifleri hedef degildir.
 */
import { isRecord } from "./parse-helpers.ts";

export interface ProductPageInfo {
  sellerName: string | null;
  variantLabel: string | null;
  gtin: string | null;
}

const EMPTY: ProductPageInfo = { sellerName: null, variantLabel: null, gtin: null };

function text(v: unknown, max: number): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
}

function productNodes(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const m of html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      const parsed: unknown = JSON.parse(m[1] ?? "");
      const nodes = Array.isArray(parsed) ? parsed : [parsed];
      for (const n of nodes) {
        const graph = isRecord(n) && Array.isArray(n["@graph"]) ? (n["@graph"] as unknown[]) : [n];
        for (const g of graph) {
          const t = isRecord(g) ? g["@type"] : null;
          if (isRecord(g) && (t === "Product" || (Array.isArray(t) && t.includes("Product")))) {
            out.push(g);
          }
        }
      }
    } catch {
      /* bozuk blok: atla */
    }
  }
  return out;
}

export function extractHepsiburadaProductPage(html: string): ProductPageInfo {
  const product = productNodes(html)[0];
  if (!product) return EMPTY;
  const offers = Array.isArray(product.offers) ? product.offers[0] : product.offers;
  const seller = isRecord(offers) ? offers.seller : null;
  const sellerName = text(isRecord(seller) ? seller.name : seller, 300);
  const gtinRaw = [product.gtin, product.gtin13, product.gtin14, product.gtin12, product.gtin8]
    .map((g) => text(g, 14))
    .find((g) => g && /^[0-9]{8,14}$/.test(g) && !/^0{4,}/.test(g));
  const parts = [text(product.color, 60), text(product.size, 60)].filter(Boolean);
  return {
    sellerName,
    variantLabel: parts.length ? parts.join(" / ") : null,
    gtin: gtinRaw ?? null,
  };
}
