/**
 * `search()`'in metin sekmeleri ("Bizim seçtiklerimiz", "En iyi fırsatlar")
 * için SQL yapı taşları. Tek kaynak: `/ara` (`search.ts`) ve yönetim arama
 * tanısı (`search-explain.ts`) aynı CTE'leri, aynı filtreyi, aynı metin
 * kapısını ve aynı skor ifadesini kullanır; tanı ikinci bir sıralama yazmaz.
 *
 * Dahili detay — `index.ts`'ten dışa açılmaz.
 */
import { type SQL, sql } from "drizzle-orm";
import { arrayParam, balancedScoreExpr, balancedScoreFactors } from "./ranking.ts";
import {
  foldedDocumentExpr,
  headPrefilter,
  matchTokens,
  rootCategoryJoin,
  tokenMatchGate,
  tokenMatchLateral,
} from "./text-match.ts";
import type { QueryFilters, QueryObject } from "./types.ts";

export type TextSort = "balanced" | "best_deal";

export function merchantIdsOf(filters: QueryFilters): number[] | null {
  return filters.merchant_ids && filters.merchant_ids.length > 0 ? filters.merchant_ids : null;
}

/**
 * `best_offer`: urun basina en dusuk fiyatli aktif teklif. `onlyProductId`
 * yalnizca tani icindir: tek urunun satirini ayni kuralla hesaplar.
 */
export function bestOfferCte(
  inStockOnly: boolean,
  merchantIds: number[] | null,
  onlyProductId: number | null = null,
): SQL {
  const only = onlyProductId === null ? sql`` : sql`AND o.product_id = ${onlyProductId}`;
  return sql`
    best_offer AS (
      SELECT DISTINCT ON (o.product_id)
        o.product_id, o.id AS offer_id, o.current_price, o.in_stock, o.merchant_id, m.trust_score
      FROM offer o
      JOIN merchant m ON m.id = o.merchant_id
      WHERE o.product_id IS NOT NULL
        AND o.is_active AND m.is_active
        AND (${arrayParam(merchantIds)}::bigint[] IS NULL OR o.merchant_id = ANY(${arrayParam(merchantIds)}::bigint[]))
        AND (NOT ${inStockOnly} OR o.in_stock)
        ${only}
      ORDER BY o.product_id, o.current_price ASC NULLS LAST
    )
  `;
}

/**
 * Ayni gorseli tasiyan sonuclardan yalnizca en yuksek skorlusu (0029).
 * Normod'da 16 kumas rengi tek fotografi paylasiyor: kullaniciya ayni resmi
 * 16 kez gostermek 24'luk listeyi doldurur ama bilgi eklemez. Urun modeli
 * degismez (renk hala kanonik, 0005); yalnizca liste cesitlenir. Gorseli
 * olmayan urunler kendi basina bir gruptur.
 */
export function imageRanked(scored: SQL): SQL {
  return sql`
      SELECT x.*, row_number() OVER (
        -- COLLATE "C": URL'ler bayt olarak karsilastirilir; yerel duyarli
        -- siralama 4 bin satirda ~70 ms suruyordu (olculdu).
        PARTITION BY COALESCE(x.primary_image_url, x.id::text) COLLATE "C"
        ORDER BY x.score DESC, x.id ASC
      ) AS image_rank
      FROM ${scored} x
  `;
}

export function distinctImage(scored: SQL): SQL {
  return sql`
    SELECT * FROM (${imageRanked(scored)}) ranked WHERE ranked.image_rank = 1
  `;
}

/** Filtre kosullarinin adlari; tani her birini ayri degerlendirir. */
export type FilterPredicateName =
  | "category"
  | "color"
  | "price_min"
  | "price_max"
  | "size"
  | "brand_include"
  | "brand_exclude";

/**
 * docs/search.md filtre tablosu: her alan bir indekse karsilik gelir.
 * Sirasi ve icerigi `buildFilterClause` ile aynidir (o bunlarin AND'idir).
 */
export function filterPredicates(filters: QueryFilters): { name: FilterPredicateName; sql: SQL }[] {
  const categoryPath = filters.category_path ?? null;
  const colors = filters.color && filters.color.length > 0 ? filters.color : null;
  const priceMin = filters.price_min ?? null;
  const priceMax = filters.price_max ?? null;
  const sizeNorm = filters.size_norm ?? null;
  const brandInclude =
    filters.brand_include && filters.brand_include.length > 0 ? filters.brand_include : null;
  const brandExclude =
    filters.brand_exclude && filters.brand_exclude.length > 0 ? filters.brand_exclude : null;
  const inStockOnly = filters.in_stock_only ?? false;

  return [
    {
      name: "category",
      sql: sql`(${categoryPath}::text IS NULL OR c.path = ${categoryPath} OR c.path LIKE ${categoryPath} || '/%')`,
    },
    {
      name: "color",
      sql: sql`(${arrayParam(colors)}::text[] IS NULL OR p.color = ANY(${arrayParam(colors)}::text[]))`,
    },
    { name: "price_min", sql: sql`(${priceMin}::bigint IS NULL OR p.min_price >= ${priceMin})` },
    { name: "price_max", sql: sql`(${priceMax}::bigint IS NULL OR p.min_price <= ${priceMax})` },
    {
      name: "size",
      sql: sql`(${sizeNorm}::text IS NULL OR EXISTS (
      SELECT 1 FROM offer_variant ov
      WHERE ov.offer_id = bo.offer_id AND ov.size_norm = ${sizeNorm}
        AND (NOT ${inStockOnly} OR ov.in_stock)
    ))`,
    },
    {
      name: "brand_include",
      sql: sql`(${arrayParam(brandInclude)}::text[] IS NULL OR b.name_norm = ANY(${arrayParam(brandInclude)}::text[]))`,
    },
    {
      name: "brand_exclude",
      sql: sql`(${arrayParam(brandExclude)}::text[] IS NULL OR b.name_norm IS NULL OR NOT (b.name_norm = ANY(${arrayParam(brandExclude)}::text[])))`,
    },
  ];
}

export function buildFilterClause(filters: QueryFilters): SQL {
  return sql.join(
    filterPredicates(filters).map((predicate) => predicate.sql),
    sql`\n    AND `,
  );
}

/** Metin kapisinin slotlari: onbellekteki eski satirlarda `text_slots` yoktur. */
export function textSlotsOf(query: QueryObject): string[][] {
  return query.text_slots ?? matchTokens(query.unparsed).map((token) => [token]);
}

/**
 * Metin kosulu (docs/decisions/0029). Ayristiricinin filtreye cevirdigi
 * kelimeler (fiyat, beden, renk, marka) `unparsed`'ta yoktur; kapi yalnizca
 * geriye kalan metne uygulanir. Metin yoksa kapi ve LATERAL yoktur.
 */
export function textMatch(query: QueryObject): {
  slots: string[][];
  products: SQL;
  lateral: SQL;
  gate: SQL;
  relevance: SQL;
} {
  const slots = textSlotsOf(query);
  if (slots.length === 0) {
    return {
      slots,
      products: sql`product p`,
      lateral: sql``,
      gate: sql`TRUE`,
      relevance: sql`1.0`,
    };
  }
  const document = foldedDocumentExpr(sql`p.title`, sql`b.name`, sql`p.color`, sql`rc.name`);
  return {
    slots,
    // Indeksli on filtre ONCE: `OFFSET 0` planlayicinin alt sorguyu
    // duzlestirip pahali token LATERAL'ini tum katalogda kosmasini engeller
    // (olculdu: 4.5 bin urunde 270 ms -> ~20 ms).
    products: sql`(SELECT * FROM product pr WHERE ${headPrefilter(slots, sql`pr.id`)} OFFSET 0) p`,
    lateral: sql`${rootCategoryJoin(sql`c.path`)} ${tokenMatchLateral(slots, document)}`,
    gate: tokenMatchGate(slots),
    relevance: sql`tm.rel`,
  };
}

/**
 * `WITH best_offer AS (...), scored AS (...)`: kapidan gecen her urun ve
 * skoru. `explain` yalnizca tanida: skor carpanlarini ayri kolon olarak da
 * secer (`f_relevance`, `f_trust`, `f_stock`, `f_price`). `/ara` bunu
 * `false` ile cagirir; SQL'i tanidan once ne ise odur.
 */
export function scoredCtes(query: QueryObject, sort: TextSort, explain = false): SQL {
  const merchantIds = merchantIdsOf(query.filters);
  const inStockOnly = query.filters.in_stock_only ?? false;
  const text = textMatch(query);
  // "En iyi fiyat" sekmesi de ayni metin kapisindan gecer: alakasiz ama
  // indirimli bir urun bu sekmede de one cikmamali.
  if (sort === "best_deal") {
    const extra = explain ? sql`, ${text.relevance}::double precision AS f_relevance` : sql``;
    return sql`
    WITH ${bestOfferCte(inStockOnly, merchantIds)},
    scored AS (
      SELECT p.id, p.public_id, p.slug, p.title, p.primary_image_url,
             b.name AS brand_name, c.path AS category_path,
             bo.current_price, bo.in_stock, bo.trust_score,
             pps.current_percentile, pps.list_price_inflated, p.offer_count,
             (100 - COALESCE(pps.current_percentile, 100))::double precision AS score${extra}
      FROM ${text.products}
      JOIN best_offer bo ON bo.product_id = p.id
      JOIN product_price_stats pps ON pps.product_id = p.id
      LEFT JOIN brand b ON b.id = p.brand_id
      LEFT JOIN category c ON c.id = p.category_id
      ${text.lateral}
      WHERE pps.list_price_inflated = FALSE
        AND ${buildFilterClause(query.filters)}
        AND ${text.gate}
    )
  `;
  }

  const inputs = [
    text.relevance,
    sql`bo.trust_score`,
    sql`bo.in_stock`,
    sql`pps.current_percentile`,
  ] as const;
  const score = balancedScoreExpr(...inputs);
  let extra = sql``;
  if (explain) {
    const f = balancedScoreFactors(...inputs);
    extra = sql`,
             ${f.relevance}::double precision AS f_relevance,
             ${f.trust}::double precision AS f_trust,
             ${f.stock}::double precision AS f_stock,
             ${f.price}::double precision AS f_price`;
  }
  return sql`
    WITH ${bestOfferCte(inStockOnly, merchantIds)},
    scored AS (
      SELECT p.id, p.public_id, p.slug, p.title, p.primary_image_url,
             b.name AS brand_name, c.path AS category_path,
             bo.current_price, bo.in_stock, bo.trust_score,
             pps.current_percentile, pps.list_price_inflated, p.offer_count,
             ${score} AS score${extra}
      FROM ${text.products}
      JOIN best_offer bo ON bo.product_id = p.id
      LEFT JOIN product_price_stats pps ON pps.product_id = p.id
      LEFT JOIN brand b ON b.id = p.brand_id
      LEFT JOIN category c ON c.id = p.category_id
      ${text.lateral}
      WHERE ${buildFilterClause(query.filters)}
        AND ${text.gate}
    )
  `;
}

/** Son siralama; `row_number()` ile tanida da ayni ifade kullanilir. */
export function finalOrder(sort: TextSort): SQL {
  return sort === "best_deal"
    ? sql`s.current_percentile ASC NULLS LAST, s.id ASC`
    : sql`s.score DESC, s.id ASC`;
}
