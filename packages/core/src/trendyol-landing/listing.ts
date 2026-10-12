/**
 * Trendyol liste/arama sayfasinin sunucuda gomdugu
 * window["__single-search-result__PROPS"] nesnesinden urunler (ilk ~36).
 * Dogrulanamayan fiyat/gorsel uretilmez; null kalir, `missing`e yazilir.
 */

export interface TrendyolListingProduct {
  title: string | null;
  price: string | null;
  priceKurus: number | null;
  currency: string | null;
  imageUrl: string | null;
  productUrl: string | null;
  merchant: "Trendyol";
  category: string | null;
  availability: "unknown";
  lastCheckedAt: string;
  missing: string[];
  /** Kimlik hiyerarsisi (canli dogrulandi 2026-10-12): renk grubu -> content -> varyant -> satici. */
  contentId: string | null;
  /** Renk grubu (`groupId` = urun sayfasindaki `productGroupId`). Sitemap'te YOK. */
  groupId: string | null;
  /** Karttaki teklifin saticisi (adresteki merchantId). */
  supplierId: string | null;
  /** Kartin gosterdigi varyant ("38,5", "Tek Ebat"); fiyat bu varyanta aittir. */
  variant: string | null;
}

const PROPS_KEY = 'window["__single-search-result__PROPS"]=';
const ORIGIN = "https://www.trendyol.com";

/** "124.999" | "187,64" | "106.090,41" -> kurus tamsayi; float kullanilmaz. */
export function priceTextToKurus(raw: unknown): number | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  let s = String(raw).trim();
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(",", ".");
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const kurus = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
  return Number.isSafeInteger(kurus) && kurus > 0 ? kurus : null;
}

export function formatKurus(kurus: number): string {
  const lira = String(Math.floor(kurus / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${lira},${String(kurus % 100).padStart(2, "0")}`;
}

/** Script metinlerinden (ya da tum HTML'den) gomulu nesneyi bulur. */
export function findSearchProps(text: string): unknown {
  const i = text.indexOf(PROPS_KEY);
  if (i < 0) return null;
  const rest = text.slice(i + PROPS_KEY.length);
  const end = rest.indexOf("</script>");
  const body = (end >= 0 ? rest.slice(0, end) : rest).trim().replace(/;\s*$/, "");
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

type Json = Record<string, unknown>;

export function listingProducts(props: unknown, checkedAt: string): TrendyolListingProduct[] {
  const products = ((props as Json)?.data as Json)?.products;
  if (!Array.isArray(products)) return [];
  return products.map((raw) => {
    const p = (raw ?? {}) as Json;
    const priceObj = (p.price ?? {}) as Json;
    const priceKurus =
      priceTextToKurus(priceObj.discountedPriceText) ?? priceTextToKurus(priceObj.currentText);
    const cur = String(priceObj.currency ?? "").toUpperCase();
    const currency = priceKurus != null && (cur === "TL" || cur === "TRY") ? "TRY" : null;
    let productUrl: string | null = null;
    let supplierId: string | null = null;
    try {
      const u = new URL(String(p.url ?? ""), ORIGIN);
      if (u.origin === ORIGIN && /-p-\d+$/.test(u.pathname)) productUrl = `${ORIGIN}${u.pathname}`;
      supplierId = /^\d+$/.test(u.searchParams.get("merchantId") ?? "")
        ? u.searchParams.get("merchantId")
        : null;
    } catch {}
    const idOf = (v: unknown) =>
      (typeof v === "number" || typeof v === "string") && /^\d+$/.test(String(v))
        ? String(v)
        : null;
    const image = typeof p.image === "string" && p.image.startsWith("https://") ? p.image : null;
    const title =
      typeof p.name === "string"
        ? [typeof p.brand === "string" ? p.brand : "", p.name].join(" ").trim()
        : null;
    const category =
      typeof (p.category as Json)?.name === "string" ? String((p.category as Json).name) : null;
    const missing = ["availability"];
    if (!title) missing.push("title");
    if (priceKurus == null || !currency) missing.push("price");
    if (!image) missing.push("imageUrl");
    if (!productUrl) missing.push("productUrl");
    return {
      title,
      price: priceKurus != null && currency ? formatKurus(priceKurus) : null,
      priceKurus: currency ? priceKurus : null,
      currency,
      imageUrl: image,
      productUrl,
      merchant: "Trendyol" as const,
      category,
      // Liste nesnesindeki `stock` alani canli testte bos ({}) geldi.
      availability: "unknown" as const,
      lastCheckedAt: checkedAt,
      missing,
      contentId: productUrl ? (productUrl.match(/-p-(\d+)$/)?.[1] ?? null) : null,
      groupId: idOf(p.groupId),
      supplierId,
      variant:
        typeof p.variantValue === "string" && p.variantValue.trim() ? p.variantValue.trim() : null,
    };
  });
}
