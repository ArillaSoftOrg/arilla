/**
 * Kök catch-all (`docs/routes.md` "Link öneki") ve link araması (0031):
 * yapıştırılan link katalogda zaten eşleşmiş bir ürüne aitse doğrudan
 * `/urun/<slug>`; yoksa kuyruğa alınır (`link-resolution.ts`). Bu dosya
 * yalnızca OKUR - katalog tablolarına hiçbir yazma yapmaz (`CLAUDE.md`).
 *
 * İki kimlik yolu var:
 *  - `user_link` offer'ı: `external_id` normalize URL'den türetilmiştir (0014).
 *  - feed/Shopify offer'ı: `external_id` mağazanın KENDİ kimliğidir (ör. Shopify
 *    ürün numarası), URL'den türetilemez. Bu yüzden aynı mağazada offer
 *    adresinin YOLU da karşılaştırılır (şema, `www.` ve sorgu hariç). 0031
 *    QA'sında bulundu: yalnızca `external_id` bakılınca katalogdaki bir
 *    ürünün linki bulunamıyor, yeniden getirilip kopya offer açılıyordu.
 */
import { type Database, merchant, offer, product } from "@arilla/db";
import { and, eq, or, sql } from "drizzle-orm";
import { normalizeUrl } from "./normalize-url.ts";

export interface KnownOffer {
  productSlug: string;
}

/** `external_id`'deki yol kısmı (sorgusuz); offer adresinin yoluyla karşılaştırılır. */
function pathOf(externalId: string): string {
  const path = externalId.split("?")[0] ?? "/";
  return path || "/";
}

export async function findKnownOfferByUrl(
  db: Database,
  rawUrl: string,
): Promise<KnownOffer | null> {
  const normalized = normalizeUrl(rawUrl);
  const path = pathOf(normalized.externalId);

  // Offer adresinden yol: şema + host atılır, sorgu/fragment atılır, sondaki
  // bölü düşer - `normalizeUrl` ile aynı kural.
  const offerPath = sql`coalesce(nullif(rtrim(split_part(split_part(regexp_replace(${offer.url}, '^[a-zA-Z]+://[^/]+', ''), '?', 1), '#', 1), '/'), ''), '/')`;

  const rows = await db
    .select({ slug: product.slug })
    .from(offer)
    .innerJoin(merchant, eq(merchant.id, offer.merchantId))
    .innerJoin(product, eq(product.id, offer.productId))
    .where(
      and(
        eq(merchant.domain, normalized.domain),
        or(
          eq(offer.externalId, normalized.externalId),
          // Kök yol ("/") bir ürün değil, mağazanın ana sayfasıdır.
          path === "/" ? sql`false` : sql`${offerPath} = ${path}`,
        ),
      ),
    )
    .orderBy(offer.id)
    .limit(1);

  const row = rows[0];
  return row ? { productSlug: row.slug } : null;
}
