/**
 * Satici kaynakli Trendyol fiyati (arastirma prototipi). ManiCepte'yi kendi
 * Trendyol Partner API'sine yetkilendiren saticilarin ONAYLI urunlerinden
 * fiyat okur. Resmi belge: developers.trendyol.com "Urun Filtreleme - Onayli Urun v2"
 *   GET {base}/integration/product/sellers/{sellerId}/products/approved?contentId=...
 *   Basic auth (saticinin API Key/Secret), User-Agent "<sellerId> - <EntegratorAdi>"
 * Yalnizca saticinin KENDI teklifleri doner; baska satici kapsanmaz.
 *
 * Gizli anahtarlar yalnizca kayittan (ortam/sir deposu) okunur; asla loglanmaz.
 * `priceSeenByCustomer` belgede TANIMSIZDIR (yalnizca ornekte); anlami gercek bir
 * saticiyla dogrulanana kadar fiyat `priceBasis` ile birlikte dondurulur.
 */

import { priceTextToKurus } from "./listing.ts";
import type { PriceProvider, PriceQuote, ProductCard } from "./price-enrichment.ts";

export interface AuthorizedSeller {
  sellerId: string;
  /** Kartta gosterilecek satici adi (saticinin onayladigi bicimde). */
  displayName: string;
  apiKey: string;
  apiSecret: string;
}

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface SellerApiOptions {
  sellers: readonly AuthorizedSeller[];
  /** "ManiCepte" — alfasayisal, en fazla 30 karakter (belge kurali). */
  integratorName: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  now?: () => Date;
  /** Hangi fiyat alani gosterilecek; varsayilan dogrulanana kadar "salePrice". */
  priceField?: "salePrice" | "priceSeenByCustomer";
}

type Json = Record<string, unknown>;

const VARIANT_ATTR = /^(beden|numara|renk|hafıza|hafiza|kapasite|dahili hafıza|ebat)$/i;

/** Varyant oznitelikleri ("Beden: 38,5", "Renk: Siyah") -> tek etiket; yoksa null. */
export function variantLabel(attrs: unknown): string | null {
  if (!Array.isArray(attrs)) return null;
  const parts = attrs
    .filter((a): a is Json => !!a && typeof a === "object")
    .filter((a) => typeof a.attributeName === "string" && VARIANT_ATTR.test(a.attributeName.trim()))
    .map((a) => String(a.attributeValue ?? "").trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : null;
}

function toKurus(v: unknown): number | null {
  if (typeof v !== "number" && typeof v !== "string") return null;
  return priceTextToKurus(String(v));
}

/** Belgedeki yanit bicimini PriceQuote'lara cevirir (satisa acik, kilitsiz varyantlar). */
export function quotesFromApprovedResponse(
  body: unknown,
  seller: AuthorizedSeller,
  contentId: string,
  checkedAt: string,
  priceField: "salePrice" | "priceSeenByCustomer",
): PriceQuote[] {
  const out: PriceQuote[] = [];
  for (const content of ((body as Json)?.content as Json[] | undefined) ?? []) {
    if (String(content.contentId) !== contentId) continue;
    for (const v of (content.variants as Json[] | undefined) ?? []) {
      if (v.onSale !== true || v.locked === true || v.archived === true || v.blacklisted === true) {
        continue;
      }
      const qty = (v.stock as Json | undefined)?.quantity;
      if (typeof qty === "number" && qty <= 0) continue;
      const price = (v.price ?? {}) as Json;
      const basis =
        priceField === "priceSeenByCustomer" && price.priceSeenByCustomer != null
          ? "priceSeenByCustomer"
          : "salePrice";
      const kurus = toKurus(price[basis]);
      if (kurus == null) continue;
      out.push({
        source: "trendyol-seller-api",
        store: "Trendyol",
        storeProductId: contentId,
        title: String(content.title ?? ""),
        seller: seller.displayName,
        supplierId: String(v.supplierId ?? seller.sellerId),
        barcode: typeof v.barcode === "string" ? v.barcode : null,
        variantId: v.variantId != null ? String(v.variantId) : null,
        variant: variantLabel(v.attributes),
        offerUrl: typeof v.productUrl === "string" ? v.productUrl : null,
        priceKurus: kurus,
        currency: "TRY",
        priceBasis: basis,
        checkedAt,
      });
    }
  }
  return out;
}

export function trendyolSellerApiProvider(opts: SellerApiOptions): PriceProvider {
  const base = opts.baseUrl ?? "https://apigw.trendyol.com";
  const doFetch: FetchLike =
    opts.fetchImpl ?? ((url, init) => fetch(url, init) as ReturnType<FetchLike>);
  const now = opts.now ?? (() => new Date());
  const priceField = opts.priceField ?? "salePrice";
  return {
    name: "trendyol-seller-api",
    async quotes(card: ProductCard, signal?: AbortSignal): Promise<PriceQuote[]> {
      // Kesifte saticisi biliniyorsa once/sadece o satici; degilse yetkili saticilarin hepsi.
      const known = opts.sellers.filter((s) => s.sellerId === card.supplierId);
      const targets = known.length > 0 ? known : opts.sellers;
      const results = await Promise.all(
        targets.map(async (seller) => {
          const url = `${base}/integration/product/sellers/${encodeURIComponent(seller.sellerId)}/products/approved?contentId=${encodeURIComponent(card.storeProductId)}&size=1`;
          const auth = Buffer.from(`${seller.apiKey}:${seller.apiSecret}`).toString("base64");
          const res = await doFetch(url, {
            headers: {
              authorization: `Basic ${auth}`,
              "user-agent": `${seller.sellerId} - ${opts.integratorName}`,
              accept: "application/json",
            },
            signal,
          });
          // 401/403/429: bu satici icin fiyat yok; yeniden deneme/atlatma yok.
          if (res.status !== 200) return [];
          return quotesFromApprovedResponse(
            await res.json(),
            seller,
            card.storeProductId,
            now().toISOString(),
            priceField,
          );
        }),
      );
      return results.flat();
    },
  };
}
