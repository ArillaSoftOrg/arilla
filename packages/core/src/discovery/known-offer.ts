/**
 * Kök catch-all (`docs/routes.md` "Link öneki"): yapıştırılan link katalogda
 * zaten varsa hemen `/urun/<slug>` adresine 302; yoksa kuyruğa alınır
 * (`link-resolution.ts`). Bu dosya yalnızca OKUR - katalog `offer`/`product`
 * tablolarına hiçbir yazma yapmaz (`CLAUDE.md` mimari sınırı).
 */
import { type Database, merchant, offer, product } from "@arilla/db";
import { and, eq } from "drizzle-orm";
import { normalizeUrl } from "./normalize-url.ts";

export interface KnownOffer {
  productSlug: string;
}

export async function findKnownOfferByUrl(
  db: Database,
  rawUrl: string,
): Promise<KnownOffer | null> {
  const normalized = normalizeUrl(rawUrl);

  const rows = await db
    .select({ slug: product.slug })
    .from(offer)
    .innerJoin(merchant, eq(merchant.id, offer.merchantId))
    .innerJoin(product, eq(product.id, offer.productId))
    .where(and(eq(merchant.domain, normalized.domain), eq(offer.externalId, normalized.externalId)))
    .limit(1);

  const row = rows[0];
  return row ? { productSlug: row.slug } : null;
}
