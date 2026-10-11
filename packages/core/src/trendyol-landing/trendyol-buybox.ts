/**
 * Trendyol Buybox fiyati (arastirma prototipi). Resmi belge:
 * developers.trendyol.com "Urun Buybox Kontrol Servisi"
 *   POST {base}/integration/product/sellers/{sellerId}/products/buybox-information
 *   govde {"barcodes": [...]} (en fazla 10), Basic auth, UA "<sellerId> - <Entegrator>"
 * Yanit: buyboxInfo[{barcode, buyboxOrder, buyboxPrice, hasMultipleSeller,
 *   secondBuyboxPrice?, thirdBuyboxPrice?}] — alanlar belgede TANIMSIZ; 2./3. fiyatlarin
 *   saticisi belirtilmez (anonim) ve bu iki alan OpenAPI semasinda yoktur.
 *
 * YETKI SINIRI: Belge "urunlerinizin buybox bilgisini" diyor. Bu saglayici YALNIZCA
 * yetkili saticinin kendi katalogunda (Product V2) bulunan barkodlari sorgular; disaridan
 * barkod kabul etmez. Saticinin satmadigi barkodu sorgulamak bu prototipte yasaktir.
 */

import { priceTextToKurus } from "./listing.ts";
import type { PriceQuote } from "./price-enrichment.ts";
import type { AuthorizedSeller } from "./trendyol-seller-api.ts";

export type PostFetch = (
  url: string,
  init: { method: "POST"; body: string; headers: Record<string, string> },
) => Promise<{ status: number; json(): Promise<unknown> }>;

/** Saticinin Product V2 katalogundan gelen kayit (contentId <-> barkod). */
export interface SellerCatalogEntry {
  contentId: string;
  barcode: string;
  title: string;
  productUrl: string | null;
}

type Json = Record<string, unknown>;

const toKurus = (v: unknown) =>
  typeof v === "number" || typeof v === "string" ? priceTextToKurus(String(v)) : null;

export function quotesFromBuyboxResponse(
  body: unknown,
  catalog: ReadonlyMap<string, SellerCatalogEntry>,
  seller: AuthorizedSeller,
  checkedAt: string,
): PriceQuote[] {
  const out: PriceQuote[] = [];
  for (const info of ((body as Json)?.buyboxInfo as Json[] | undefined) ?? []) {
    const entry = catalog.get(String(info.barcode ?? ""));
    if (!entry) continue; // katalog disi barkod: kullanilmaz
    const kurus = toKurus(info.buyboxPrice);
    if (kurus == null) continue;
    const ownWins = info.buyboxOrder === 1;
    out.push({
      source: "trendyol-buybox",
      store: "Trendyol",
      storeProductId: entry.contentId,
      title: entry.title,
      // Buybox kazanani yetkili saticiysa adi bilinir; degilse kazanan satici anonimdir.
      seller: ownWins ? seller.displayName : null,
      supplierId: ownWins ? seller.sellerId : null,
      barcode: entry.barcode,
      offerUrl: entry.productUrl,
      priceKurus: kurus,
      currency: "TRY",
      priceBasis: "buyboxPrice",
      checkedAt,
    });
  }
  return out;
}

export interface BuyboxOptions {
  seller: AuthorizedSeller;
  integratorName: string;
  baseUrl?: string;
  fetchImpl?: PostFetch;
  now?: () => Date;
}

/** Saticinin kendi barkodlari icin buybox fiyatlari (10'arli gruplar). */
export async function fetchBuyboxQuotes(
  opts: BuyboxOptions,
  catalogEntries: readonly SellerCatalogEntry[],
): Promise<PriceQuote[]> {
  const catalog = new Map(catalogEntries.map((e) => [e.barcode, e]));
  const barcodes = [...catalog.keys()];
  const base = opts.baseUrl ?? "https://apigw.trendyol.com";
  const doFetch: PostFetch = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const auth = Buffer.from(`${opts.seller.apiKey}:${opts.seller.apiSecret}`).toString("base64");
  const out: PriceQuote[] = [];
  for (let i = 0; i < barcodes.length; i += 10) {
    const res = await doFetch(
      `${base}/integration/product/sellers/${encodeURIComponent(opts.seller.sellerId)}/products/buybox-information`,
      {
        method: "POST",
        body: JSON.stringify({ barcodes: barcodes.slice(i, i + 10) }),
        headers: {
          authorization: `Basic ${auth}`,
          "user-agent": `${opts.seller.sellerId} - ${opts.integratorName}`,
          "content-type": "application/json",
          accept: "application/json",
        },
      },
    );
    // 401/403/429: dur; yeniden deneme veya atlatma yok.
    if (res.status !== 200) break;
    out.push(
      ...quotesFromBuyboxResponse(
        await res.json(),
        catalog,
        opts.seller,
        (opts.now ?? (() => new Date()))().toISOString(),
      ),
    );
  }
  return out;
}
