/**
 * Hepsiburada katalog hunisi (karar 0129): iki toplayicidan gelen kayitlarin merkezi
 * katalogda nereye kadar ilerledigi. YALNIZCA OKUR.
 *
 *   arama toplayicisi -> catalog_intake_record -> (hb-merge) offer
 *   sitemap toplayicisi -> catalog_discovery (fiyatsiz)
 *   ikisi -> (catalog_build) product draft -> kapi (ready/held) -> acik yayin (published)
 *
 * Milyonlarca satir icin: her sayim ya indeksle (`product_source_state_idx`,
 * `catalog_discovery_priced_idx`, `catalog_intake_pending_idx`, `offer_merchant_state_idx`)
 * ya da ust sinirli (`LIMIT` + "en az") yapilir; tum sorgular kisa zaman asimi altindadir.
 * Sinira ulasan sayi `capped: true` doner ve arayuz onu "en az" diye gosterir.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { type AdminActor, assertCapability } from "../admin/capabilities.ts";

/** Bu kadar satirdan sonra sayim durur ("en az N"). */
export const FUNNEL_COUNT_CAP = 1_000_000;
const STATEMENT_TIMEOUT = "4s";

export interface CappedCount {
  value: number;
  /** Sayim ust sinira ulasti: gercek sayi en az `value`. */
  capped: boolean;
}

export interface CatalogFunnel {
  merchantFound: boolean;
  /** Arama toplayicisi: ara depoya yazilan kayit (kosu x urun). */
  intake: { total: CappedCount; merged: CappedCount; pending: number };
  /** Sitemap toplayicisi: kesif defteri. Fiyat durumu bilinenler indeksle tam sayilir. */
  discovery: { total: CappedCount; listingPrice: number; pageVerified: number; stale: number };
  /** Birlestirilmis kayit = Hepsiburada teklifi (`offer`, magaza + kod tekil). */
  offers: { total: number; active: number; linkedToProduct: number; stockUnknown: number };
  /** Product'a aktarilan Hepsiburada urunleri (kaynak ilani), yayin durumuna gore. */
  products: {
    total: number;
    draft: number;
    ready: number;
    held: number;
    published: number;
    heldReasons: Record<string, number>;
  };
  /** Kaynak teklifinde gercek fiyat olan urun (liste fiyati; sayfayla ayrica dogrulanmadi). */
  pricedProducts: number;
  /** Fiyat bekleyen urun: kapida teklifsiz/fiyatsiz tutulan (`source_offer_missing`, `no_price`). */
  awaitingPriceProducts: number;
  /** Hatali/bekleyen kayitlar. */
  problems: {
    priceJumpHeld: number;
    offerBuildSkipped: Record<string, number>;
    discoveryBuildSkipped: Record<string, number>;
  };
  checkpoints: {
    offerBuildCompletedAt: Date | null;
    discoveryBuildCompletedAt: Date | null;
    discoveryBuildLastId: string | null;
  };
}

const AWAITING_PRICE_REASONS = new Set(["source_offer_missing", "no_price"]);

type Row = Record<string, unknown>;

function num(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function capped(value: unknown, limit: number): CappedCount {
  const n = num(value);
  return n > limit ? { value: limit, capped: true } : { value: n, capped: false };
}

function counts(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, number> = {};
  for (const [key, n] of Object.entries(value as Record<string, unknown>)) {
    if (num(n) > 0) out[key] = num(n);
  }
  return out;
}

function emptyFunnel(): CatalogFunnel {
  const zero = { value: 0, capped: false };
  return {
    merchantFound: false,
    intake: { total: zero, merged: zero, pending: 0 },
    discovery: { total: zero, listingPrice: 0, pageVerified: 0, stale: 0 },
    offers: { total: 0, active: 0, linkedToProduct: 0, stockUnknown: 0 },
    products: { total: 0, draft: 0, ready: 0, held: 0, published: 0, heldReasons: {} },
    pricedProducts: 0,
    awaitingPriceProducts: 0,
    problems: { priceJumpHeld: 0, offerBuildSkipped: {}, discoveryBuildSkipped: {} },
    checkpoints: {
      offerBuildCompletedAt: null,
      discoveryBuildCompletedAt: null,
      discoveryBuildLastId: null,
    },
  };
}

export async function getCatalogFunnel(
  db: Database,
  actor: AdminActor,
  source: string,
  options: { countCap?: number } = {},
): Promise<CatalogFunnel> {
  assertCapability(actor, "catalog.read");
  const limit = options.countCap ?? FUNNEL_COUNT_CAP;
  const cap = limit + 1;
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`));
    // Toplama kaynagi ile magaza ayni adi tasir (collection_source.source = merchant.slug).
    const merchant = (await tx.execute<Row>(sql`SELECT id FROM merchant WHERE slug = ${source}`))
      .rows[0];
    const funnel = emptyFunnel();

    const intake = (
      await tx.execute<Row>(sql`
        SELECT
          (SELECT count(*) FROM (
              SELECT 1 FROM catalog_intake_record i JOIN collection_run r ON r.id = i.run_id
               WHERE r.source = ${source} LIMIT ${cap}) s) AS total,
          (SELECT count(*) FROM (
              SELECT 1 FROM catalog_intake_record i JOIN collection_run r ON r.id = i.run_id
               WHERE r.source = ${source} AND i.merged_at IS NOT NULL LIMIT ${cap}) s) AS merged,
          (SELECT count(*) FROM catalog_intake_record i JOIN collection_run r ON r.id = i.run_id
            WHERE r.source = ${source} AND i.merged_at IS NULL) AS pending,
          (SELECT count(*) FROM (
              SELECT 1 FROM catalog_discovery WHERE source = ${source} LIMIT ${cap}) s)
            AS discovery_total,
          (SELECT jsonb_object_agg(price_state, n) FROM (
              SELECT price_state, count(*) AS n FROM catalog_discovery
               WHERE source = ${source} AND price_state <> 'unpriced' GROUP BY 1) d)
            AS discovery_states,
          (SELECT row_to_json(s) FROM (
              SELECT last_external_id, skipped, completed_at
                FROM catalog_discovery_build_state WHERE source = ${source}) s) AS discovery_build
      `)
    ).rows[0] as Row;
    funnel.intake = {
      total: capped(intake.total, limit),
      merged: capped(intake.merged, limit),
      pending: num(intake.pending),
    };
    const states = counts(intake.discovery_states);
    funnel.discovery = {
      total: capped(intake.discovery_total, limit),
      listingPrice: states.listing_price ?? 0,
      pageVerified: states.page_verified ?? 0,
      stale: states.stale ?? 0,
    };
    const discoveryBuild = intake.discovery_build as {
      last_external_id: string;
      skipped: unknown;
      completed_at: string | null;
    } | null;
    funnel.problems.discoveryBuildSkipped = counts(discoveryBuild?.skipped);
    funnel.checkpoints.discoveryBuildLastId = discoveryBuild?.last_external_id || null;
    funnel.checkpoints.discoveryBuildCompletedAt = discoveryBuild?.completed_at
      ? new Date(discoveryBuild.completed_at)
      : null;

    if (!merchant) return funnel;
    const merchantId = Number(merchant.id);
    funnel.merchantFound = true;

    const catalog = (
      await tx.execute<Row>(sql`
        SELECT
          (SELECT count(*) FROM offer WHERE merchant_id = ${merchantId}) AS offers,
          (SELECT count(*) FROM offer WHERE merchant_id = ${merchantId} AND is_active)
            AS offers_active,
          (SELECT count(*) FROM offer WHERE merchant_id = ${merchantId}
              AND product_id IS NOT NULL) AS offers_linked,
          (SELECT count(*) FROM offer WHERE merchant_id = ${merchantId} AND is_active
              AND NOT in_stock AND attributes_raw->>'stock_state' = 'unknown') AS stock_unknown,
          (SELECT jsonb_object_agg(k, n) FROM (
              SELECT publication_state || ':' || COALESCE(hold_reason, '') AS k, count(*) AS n
                FROM product WHERE source_merchant_id = ${merchantId} GROUP BY 1) p)
            AS product_states,
          (SELECT count(*) FROM offer o
            WHERE o.merchant_id = ${merchantId} AND o.is_active AND o.current_price > 0
              AND EXISTS (SELECT 1 FROM product p WHERE p.source_offer_id = o.id
                             AND p.source_merchant_id = ${merchantId})) AS priced_products,
          (SELECT count(*) FROM ingest_error e JOIN feed_source f ON f.id = e.feed_source_id
            WHERE f.merchant_id = ${merchantId} AND e.error_code = 'price_jump_held'
              AND e.status IN ('open', 'retrying')) AS price_jump_held,
          (SELECT row_to_json(s) FROM (
              SELECT skipped, completed_at FROM catalog_build_state
               WHERE merchant_id = ${merchantId}) s) AS offer_build
      `)
    ).rows[0] as Row;

    funnel.offers = {
      total: num(catalog.offers),
      active: num(catalog.offers_active),
      linkedToProduct: num(catalog.offers_linked),
      stockUnknown: num(catalog.stock_unknown),
    };
    const products = funnel.products;
    for (const [key, n] of Object.entries(counts(catalog.product_states))) {
      const [state, reason] = key.split(":") as [string, string];
      products.total += n;
      if (state === "draft") products.draft += n;
      else if (state === "ready") products.ready += n;
      else if (state === "published") products.published += n;
      else if (state === "held") {
        products.held += n;
        products.heldReasons[reason] = (products.heldReasons[reason] ?? 0) + n;
        if (AWAITING_PRICE_REASONS.has(reason)) funnel.awaitingPriceProducts += n;
      }
    }
    funnel.pricedProducts = num(catalog.priced_products);
    funnel.problems.priceJumpHeld = num(catalog.price_jump_held);
    const offerBuild = catalog.offer_build as {
      skipped: unknown;
      completed_at: string | null;
    } | null;
    funnel.problems.offerBuildSkipped = counts(offerBuild?.skipped);
    funnel.checkpoints.offerBuildCompletedAt = offerBuild?.completed_at
      ? new Date(offerBuild.completed_at)
      : null;
    return funnel;
  });
}
