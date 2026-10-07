/**
 * Yönetim arama tanısının (`admin/search-diagnostics.ts`) arama motoru tarafı.
 * Yalnızca okur ve `search-sql.ts`'teki yapı taşlarını kullanır: aday CTE'si,
 * filtre, metin kapısı, skor ve görsel tekilleştirme `/ara` ile aynı SQL'dir.
 * Burada ikinci bir sıralama formülü YOK; skor çarpanları aynı ifadelerden
 * ayrı kolon olarak okunur (`scoredCtes(..., explain = true)`).
 *
 * Dahili — `index.ts`'ten dışa açılmaz; yalnızca yönetim tanısı çağırır.
 */
import type { Database } from "@arilla/db";
import { type SQL, sql } from "drizzle-orm";
import {
  bestOfferCte,
  distinctImage,
  type FilterPredicateName,
  filterPredicates,
  finalOrder,
  imageRanked,
  merchantIdsOf,
  scoredCtes,
  type TextSort,
  textMatch,
} from "./search-sql.ts";
import { allowedMisses, headPrefilter } from "./text-match.ts";
import type { QueryObject } from "./types.ts";

export interface ScoreFactors {
  /** Metin alakası (slot benzerliklerinin ortalaması; metin yoksa 1). */
  relevance: number | null;
  /** Yalnızca "Bizim seçtiklerimiz": güven/100, stok çarpanı, 1 - yüzdelik/100. */
  trust: number | null;
  stock: number | null;
  price: number | null;
}

export interface ExplainedItem {
  rank: number;
  productId: number;
  slug: string;
  title: string;
  brandName: string | null;
  categoryPath: string | null;
  minPrice: number | null;
  inStock: boolean | null;
  offerCount: number;
  merchantTrustScore: number | null;
  currentPercentile: number | null;
  score: number;
  factors: ScoreFactors;
}

type Row = Record<string, unknown>;

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toExplained(row: Row, rank: number): ExplainedItem {
  return {
    rank,
    productId: Number(row.id),
    slug: String(row.slug),
    title: String(row.title),
    brandName: (row.brand_name as string | null) ?? null,
    categoryPath: (row.category_path as string | null) ?? null,
    minPrice: num(row.current_price),
    inStock: (row.in_stock as boolean | null) ?? null,
    offerCount: Number(row.offer_count ?? 0),
    merchantTrustScore: num(row.trust_score),
    currentPercentile: num(row.current_percentile),
    score: Number(row.score),
    factors: {
      relevance: num(row.f_relevance),
      trust: num(row.f_trust),
      stock: num(row.f_stock),
      price: num(row.f_price),
    },
  };
}

/**
 * `/ara`'nın listesiyle aynı sıra (aynı CTE, aynı tekilleştirme, aynı ORDER
 * BY) ve her satırın skor çarpanları.
 */
export async function rankWithFactors(
  db: Database,
  query: QueryObject,
  sort: TextSort,
  limit: number,
): Promise<{ total: number; items: ExplainedItem[] }> {
  const result = await db.execute<Row>(sql`
    ${scoredCtes(query, sort, true)}
    SELECT s.*, count(*) OVER()::text AS total_count
    FROM (${distinctImage(sql`scored`)}) s
    ORDER BY ${finalOrder(sort)}
    LIMIT ${limit}
  `);
  const rows = result.rows;
  return {
    total: rows.length === 0 ? 0 : Number(rows[0]?.total_count ?? 0),
    items: rows.map((row, index) => toExplained(row, index + 1)),
  };
}

export interface CandidateFunnel {
  /** Metin varsa: baş isim ön filtresinden geçen ürün; yoksa tüm katalog. */
  prefilter: number;
  /** + aktif mağazada aktif teklifi olan (mağaza/stok filtresiyle). */
  withActiveOffer: number;
  /** + metin kapısı (baş isim ve niteleyiciler). */
  textGate: number;
  /** Her filtrenin, önceki adımdan geçenler içinde TEK BAŞINA elediği sayı. */
  filterRejects: { name: FilterPredicateName; rejected: number }[];
  /** + tüm filtreler. */
  filters: number;
  /** + "En iyi fırsatlar": fiyat istatistiği var ve liste fiyatı şişik değil. */
  priceStats: number;
  /** Aynı görselden tek kart kaldıktan sonra = `/ara`'nın toplamı. */
  afterImageDedup: number;
  textSlots: string[][];
  requiredSlots: number;
}

/** Hangi kapının kaç adayı geçirdiği. Bir sorgu, sınırlı (READ ONLY + zaman aşımı çağıranda). */
export async function candidateFunnel(
  db: Database,
  query: QueryObject,
  sort: TextSort,
): Promise<CandidateFunnel> {
  const merchantIds = merchantIdsOf(query.filters);
  const inStockOnly = query.filters.in_stock_only ?? false;
  const text = textMatch(query);
  const predicates = filterPredicates(query.filters);
  const statsOk =
    sort === "best_deal"
      ? sql`(pps.product_id IS NOT NULL AND pps.list_price_inflated = FALSE)`
      : sql`TRUE`;
  const predicateColumns = sql.join(
    predicates.map((p, i) => sql`COALESCE(${p.sql}, FALSE) AS ${sql.raw(`f${i}`)}`),
    sql`, `,
  );
  const allFilters = sql.join(
    predicates.map((_, i) => sql.raw(`f${i}`)),
    sql` AND `,
  );
  const rejectCounts = sql.join(
    predicates.map(
      (_, i) =>
        sql`count(*) FILTER (WHERE has_offer AND gate_ok AND NOT ${sql.raw(`f${i}`)})::int AS ${sql.raw(`r${i}`)}`,
    ),
    sql`, `,
  );

  const result = await db.execute<Row>(sql`
    WITH ${bestOfferCte(inStockOnly, merchantIds)},
    base AS (
      SELECT p.id, p.primary_image_url,
             (bo.product_id IS NOT NULL) AS has_offer,
             COALESCE(${text.gate}, FALSE) AS gate_ok,
             ${statsOk} AS stats_ok,
             ${predicateColumns}
      FROM ${text.products}
      LEFT JOIN best_offer bo ON bo.product_id = p.id
      LEFT JOIN product_price_stats pps ON pps.product_id = p.id
      LEFT JOIN brand b ON b.id = p.brand_id
      LEFT JOIN category c ON c.id = p.category_id
      ${text.lateral}
    ),
    passed AS (
      SELECT id, primary_image_url FROM base
      WHERE has_offer AND gate_ok AND ${allFilters} AND stats_ok
    )
    SELECT count(*)::int AS prefilter,
           count(*) FILTER (WHERE has_offer)::int AS with_offer,
           count(*) FILTER (WHERE has_offer AND gate_ok)::int AS text_gate,
           count(*) FILTER (WHERE has_offer AND gate_ok AND ${allFilters})::int AS filters,
           count(*) FILTER (WHERE has_offer AND gate_ok AND ${allFilters} AND stats_ok)::int AS price_stats,
           (SELECT count(DISTINCT COALESCE(primary_image_url, id::text) COLLATE "C") FROM passed)::int AS dedup,
           ${rejectCounts}
    FROM base
  `);
  const row = result.rows[0] ?? {};
  return {
    prefilter: Number(row.prefilter ?? 0),
    withActiveOffer: Number(row.with_offer ?? 0),
    textGate: Number(row.text_gate ?? 0),
    filterRejects: predicates.map((p, i) => ({
      name: p.name,
      rejected: Number(row[`r${i}`] ?? 0),
    })),
    filters: Number(row.filters ?? 0),
    priceStats: Number(row.price_stats ?? 0),
    afterImageDedup: Number(row.dedup ?? 0),
    textSlots: text.slots,
    requiredSlots: text.slots.length - allowedMisses(text.slots.length),
  };
}

export interface ProductProbe {
  productId: number;
  slug: string;
  title: string;
  offers: {
    total: number;
    active: number;
    /** Aktif teklif + aktif mağaza. */
    activeOnActiveMerchant: number;
    activeInStock: number;
  };
  /** Sorgunun mağaza/stok filtresiyle `best_offer` satırı var mı. */
  hasBestOffer: boolean;
  /** Metin yoksa null (kapı yok). */
  prefilterPass: boolean | null;
  text: { matched: number; head: number; relevance: number; required: number } | null;
  textGatePass: boolean;
  predicates: { name: FilterPredicateName; pass: boolean }[];
  /** Yalnızca "En iyi fırsatlar": fiyat istatistiği var mı, liste fiyatı şişik mi. */
  priceStats: { present: boolean; listPriceInflated: boolean | null };
  /** Aday listesinde (kapı + filtre sonrası) mi. */
  inCandidates: boolean;
  /** Aynı görseli taşıyan ve daha yüksek skorlu ürün yüzünden gizlendiyse o ürün. */
  hiddenByImageOf: { productId: number; title: string } | null;
  /** `/ara` listesindeki sırası (1'den), yoksa null. */
  rank: number | null;
  total: number;
  score: number | null;
  factors: ScoreFactors | null;
}

/**
 * Tek ürünün bu sorguda nereye düştüğü. Her kapı ayrı ayrı, aynı SQL
 * ifadeleriyle değerlendirilir; sıra pencere fonksiyonuyla aynı ORDER BY'dan
 * gelir. Ürün yoksa null.
 */
export async function probeProduct(
  db: Database,
  query: QueryObject,
  sort: TextSort,
  productId: number,
): Promise<ProductProbe | null> {
  const merchantIds = merchantIdsOf(query.filters);
  const inStockOnly = query.filters.in_stock_only ?? false;
  const text = textMatch(query);
  const predicates = filterPredicates(query.filters);
  const hasText = text.slots.length > 0;

  const productRows = await db.execute<Row>(sql`
    SELECT p.id, p.slug, p.title,
           count(o.id)::int AS total,
           count(o.id) FILTER (WHERE o.is_active)::int AS active,
           count(o.id) FILTER (WHERE o.is_active AND m.is_active)::int AS active_merchant,
           count(o.id) FILTER (WHERE o.is_active AND m.is_active AND o.in_stock)::int AS active_in_stock
    FROM product p
    LEFT JOIN offer o ON o.product_id = p.id
    LEFT JOIN merchant m ON m.id = o.merchant_id
    WHERE p.id = ${productId}
    GROUP BY p.id
  `);
  const product = productRows.rows[0];
  if (!product) return null;

  const prefilter: SQL = hasText ? headPrefilter(text.slots, sql`p.id`) : sql`TRUE`;
  const tmColumns: SQL = hasText
    ? sql`tm.matched AS tm_matched, tm.head AS tm_head, tm.rel AS tm_rel`
    : sql`NULL::int AS tm_matched, NULL::float8 AS tm_head, NULL::float8 AS tm_rel`;
  const predicateColumns = sql.join(
    predicates.map((p, i) => sql`COALESCE(${p.sql}, FALSE) AS ${sql.raw(`f${i}`)}`),
    sql`, `,
  );
  const gateRows = await db.execute<Row>(sql`
    WITH ${bestOfferCte(inStockOnly, merchantIds, productId)}
    SELECT (bo.product_id IS NOT NULL) AS has_offer,
           ${prefilter} AS prefilter_ok,
           ${tmColumns},
           COALESCE(${text.gate}, FALSE) AS gate_ok,
           (pps.product_id IS NOT NULL) AS has_stats,
           pps.list_price_inflated,
           ${predicateColumns}
    FROM product p
    LEFT JOIN best_offer bo ON bo.product_id = p.id
    LEFT JOIN product_price_stats pps ON pps.product_id = p.id
    LEFT JOIN brand b ON b.id = p.brand_id
    LEFT JOIN category c ON c.id = p.category_id
    ${text.lateral}
    WHERE p.id = ${productId}
  `);
  const gate = gateRows.rows[0] ?? {};

  const rankRows = await db.execute<Row>(sql`
    ${scoredCtes(query, sort, true)},
    ir AS (${imageRanked(sql`scored`)}),
    fin AS (
      SELECT s.id, row_number() OVER (ORDER BY ${finalOrder(sort)})::int AS final_rank,
             count(*) OVER()::int AS total
      FROM ir s WHERE s.image_rank = 1
    )
    SELECT (SELECT count(*) FROM ir WHERE ir.image_rank = 1)::int AS final_total,
           me.*, fin.final_rank, w.id AS winner_id, w.title AS winner_title
    FROM (SELECT 1) one
    LEFT JOIN ir me ON me.id = ${productId}
    LEFT JOIN fin ON fin.id = me.id
    LEFT JOIN ir w ON me.image_rank > 1 AND w.image_rank = 1
      AND COALESCE(w.primary_image_url, w.id::text) COLLATE "C"
        = COALESCE(me.primary_image_url, me.id::text) COLLATE "C"
  `);
  const probeRow = rankRows.rows[0] ?? {};
  const total = Number(probeRow.final_total ?? 0);
  const ranked = probeRow.id !== null && probeRow.id !== undefined ? probeRow : null;

  const explained = ranked ? toExplained(ranked, Number(ranked.final_rank ?? 0)) : null;
  return {
    productId: Number(product.id),
    slug: String(product.slug),
    title: String(product.title),
    offers: {
      total: Number(product.total ?? 0),
      active: Number(product.active ?? 0),
      activeOnActiveMerchant: Number(product.active_merchant ?? 0),
      activeInStock: Number(product.active_in_stock ?? 0),
    },
    hasBestOffer: gate.has_offer === true,
    prefilterPass: hasText ? gate.prefilter_ok === true : null,
    text: hasText
      ? {
          matched: Number(gate.tm_matched ?? 0),
          head: Number(gate.tm_head ?? 0),
          relevance: Number(gate.tm_rel ?? 0),
          required: text.slots.length - allowedMisses(text.slots.length),
        }
      : null,
    textGatePass: gate.gate_ok === true,
    predicates: predicates.map((p, i) => ({ name: p.name, pass: gate[`f${i}`] === true })),
    priceStats: {
      present: gate.has_stats === true,
      listPriceInflated: (gate.list_price_inflated as boolean | null) ?? null,
    },
    inCandidates: Boolean(ranked),
    hiddenByImageOf:
      ranked && ranked.winner_id !== null && ranked.winner_id !== undefined
        ? { productId: Number(ranked.winner_id), title: String(ranked.winner_title) }
        : null,
    rank: ranked && ranked.final_rank !== null ? Number(ranked.final_rank) : null,
    total,
    score: explained?.score ?? null,
    factors: explained?.factors ?? null,
  };
}
