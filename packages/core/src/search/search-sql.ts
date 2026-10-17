/**
 * `search()`'in metin sekmeleri ("Bizim seçtiklerimiz", "En iyi fırsatlar")
 * için SQL yapı taşları. Tek kaynak: `/ara` (`search.ts`) ve yönetim arama
 * tanısı (`search-explain.ts`) aynı CTE'leri, aynı filtreyi, aynı metin
 * kapısını ve aynı skor ifadesini kullanır; tanı ikinci bir sıralama yazmaz.
 *
 * Dahili detay — `index.ts`'ten dışa açılmaz.
 */
import type { Database } from "@arilla/db";
import { type SQL, sql } from "drizzle-orm";
import { MAX_RATE_AGE_DAYS } from "../pricing/fx.ts";
import { arrayParam, balancedScoreExpr, balancedScoreFactors } from "./ranking.ts";
import type { ForeignPrice } from "./result-types.ts";
import {
  candidateCtes,
  foldedDocumentExpr,
  matchTokens,
  rootCategoryJoin,
  TOKEN_MATCH_THRESHOLD,
  tokenMatchGate,
  tokenMatchLateral,
} from "./text-match.ts";
import type { QueryFilters, QueryObject } from "./types.ts";

export type TextSort = "balanced" | "best_deal";

export function merchantIdsOf(filters: QueryFilters): number[] | null {
  return filters.merchant_ids && filters.merchant_ids.length > 0 ? filters.merchant_ids : null;
}

/**
 * Eşit alakada TRY teklifli ürün önde (karar 0129): yurt dışı teklifin mağaza
 * güveni bu çarpanla düşürülür. Kargo/gümrük/teslim belirsizliğinin karşılığıdır.
 */
export const FOREIGN_OFFER_TRUST_FACTOR = 0.8;

/**
 * Yaklaşık TRY için en güncel TCMB döviz satış kuru, para birimi başına
 * (`pricing/fx.ts` ile aynı kural: `MAX_RATE_AGE_DAYS`'ten eski kur kullanılmaz,
 * kur uydurulmaz).
 */
function fxCte(): SQL {
  return sql`
    fx AS (
      SELECT DISTINCT ON (f.base) f.base, f.rate, f.effective_date
      FROM fx_rate f
      WHERE f.source = 'tcmb' AND f.quote = 'TRY' AND f.rate_kind = 'forex_selling'
        AND f.effective_date >= (now() AT TIME ZONE 'UTC')::date - ${MAX_RATE_AGE_DAYS}::int
        AND f.effective_date <= (now() AT TIME ZONE 'UTC')::date
      ORDER BY f.base, f.effective_date DESC
    )
  `;
}

/**
 * `best_offer`: urun basina en dusuk fiyatli aktif teklif, YALNIZCA sinirli bir
 * aday kumesi icin (`productIds`: metin aramasinin `cand`i, benzerlik kenarlari,
 * gorsel adaylar) ya da tek urun icin (`onlyProductId`, tani). Tum teklif tablosu
 * hicbir aramada taranmaz (karar 0129; eski metinsiz yol 2,8M teklifi tarardi).
 *
 * Karar 0129: TRY teklif her zaman once secilir. Yalnizca yurt disi teklifi olan
 * urunde `current_price` TCMB kuruyla YAKLASIK kurustur (numeric, float yok,
 * yarim yukari); orijinal tutar `original_price`/`original_currency`, kur tarihi
 * `fx_date` olarak tasinir. Guncel kur yoksa yurt disi teklif YINE secilir (karar 0132):
 * `current_price` NULL kalir (kur uydurulmaz, USD kurus gibi okunmaz), kart tutari kendi
 * para birimiyle gosterir; TL fiyat suzgeci ve TL siralamasi onu almaz.
 */
export function bestOfferCte(
  inStockOnly: boolean,
  merchantIds: number[] | null,
  onlyProductId: number | null,
  productIds: SQL | null = null,
): SQL {
  const only = onlyProductId === null ? sql`` : sql`AND o.product_id = ${onlyProductId}`;
  const scoped = productIds === null ? sql`` : sql`AND ${productIds}`;
  const merchantFilter = sql`(${arrayParam(merchantIds)}::bigint[] IS NULL OR o.merchant_id = ANY(${arrayParam(merchantIds)}::bigint[]))`;
  const priceTry = sql`(CASE WHEN o.currency = 'TRY' THEN o.current_price
                         ELSE round(o.current_price * fx.rate)::bigint END)`;
  return sql`
    ${fxCte()},
    best_offer AS (
      SELECT DISTINCT ON (o.product_id)
        o.product_id, o.id AS offer_id, ${priceTry} AS current_price, o.in_stock, o.merchant_id,
        m.trust_score,
        (o.currency <> 'TRY') AS is_foreign,
        o.current_price AS original_price, o.currency AS original_currency,
        fx.effective_date::text AS fx_date
      FROM offer o
      JOIN merchant m ON m.id = o.merchant_id
      LEFT JOIN fx ON o.currency <> 'TRY' AND fx.base = o.currency
      WHERE o.product_id IS NOT NULL
        AND o.is_active AND m.is_active
        AND (o.currency = 'TRY' OR o.current_price > 0)
        AND ${merchantFilter}
        -- "Stokta olanlar": stok bildirmeyen kaynak (stock_state=unknown, karar 0118) dogrulanmis
        -- stok sayilmaz; filtre kapaliyken (varsayilan) urun gizlenmez.
        AND (NOT ${inStockOnly} OR (o.in_stock
             AND (o.attributes_raw ->> 'stock_state') IS DISTINCT FROM 'unknown'))
        ${only}
        ${scoped}
      -- TRY once; yurt disinda kurla cevrilebilen once (kursuz tutar NULL, sona).
      ORDER BY o.product_id, (o.currency <> 'TRY'), ${priceTry} ASC NULLS LAST, o.id
    )
  `;
}

/** Yurt disi teklifte guveni `FOREIGN_OFFER_TRUST_FACTOR` ile dusurulmus guven. */
const originAdjustedTrust = sql`(bo.trust_score * CASE WHEN bo.is_foreign THEN ${FOREIGN_OFFER_TRUST_FACTOR}::numeric ELSE 1 END)`;

/** Kart icin best_offer'in yurt disi kolonlari (`foreignPriceOf` okur). */
export const BEST_OFFER_ORIGIN_COLUMNS = sql`bo.is_foreign, bo.original_price, bo.original_currency, bo.fx_date`;

/** `BEST_OFFER_ORIGIN_COLUMNS` satir tipi (LEFT JOIN'de hepsi null olabilir). */
export interface OriginColumns {
  is_foreign: boolean | null;
  original_price: string | null;
  original_currency: string | null;
  /** YYYY-MM-DD (SQL'de metne cevrilir: surucu tarih saat dilimine kaymasin); kur yoksa null. */
  fx_date: string | null;
}

/** Karar 0129: secilen teklif yurt disiysa orijinal tutar ve kur tarihi. */
export function foreignPriceOf(row: OriginColumns): ForeignPrice | undefined {
  if (!row.is_foreign || row.original_price === null || !row.original_currency) {
    return undefined;
  }
  return {
    originalMinor: Number(row.original_price),
    currency: row.original_currency.trim(),
    fxDate: row.fx_date ?? null,
  };
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
    // Kartta GOSTERILEN fiyat `best_offer.current_price`'tir (magaza/stok filtresine gore
    // en ucuz teklif). `p.min_price` tum aktif tekliflerin en dusugudur; magaza ya da stok
    // filtresi aciksa gosterilen fiyattan ayrisir ve kullanici 200 TL ustu filtrelese de
    // 100 TL'lik gizli bir teklif yuzunden 500 TL'lik karti gorurdu.
    {
      name: "price_min",
      sql: sql`(${priceMin}::bigint IS NULL OR bo.current_price >= ${priceMin})`,
    },
    {
      name: "price_max",
      sql: sql`(${priceMax}::bigint IS NULL OR bo.current_price <= ${priceMax})`,
    },
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
 *
 * `ctes`: sinirli aday kumesi (`cand`, karar 0129); `products` onu urunle
 * birlestirir. Metin olsun olmasin her sorgu `cand` uzerinden gecer.
 */
export function textMatch(
  query: QueryObject,
  tokenThreshold?: number,
  candidateLimit?: number,
  bestDeal = false,
): {
  slots: string[][];
  ctes: SQL;
  products: SQL;
  lateral: SQL;
  gate: SQL;
  relevance: SQL;
} {
  const slots = textSlotsOf(query);
  const fuzzy = tokenThreshold !== undefined && tokenThreshold < TOKEN_MATCH_THRESHOLD;
  const ctes = candidateCtes(slots, query.filters, { limit: candidateLimit, bestDeal, fuzzy });
  const products = sql`cand ca JOIN product p ON p.id = ca.id`;
  if (slots.length === 0) {
    return { slots, ctes, products, lateral: sql``, gate: sql`TRUE`, relevance: sql`1.0` };
  }
  const document = foldedDocumentExpr(sql`p.title`, sql`b.name`, sql`p.color`, sql`rc.name`);
  return {
    slots,
    ctes,
    products,
    lateral: sql`${rootCategoryJoin(sql`c.path`)} ${tokenMatchLateral(slots, document, tokenThreshold)}`,
    gate: tokenMatchGate(slots, tokenThreshold),
    relevance: sql`tm.rel`,
  };
}

/**
 * Aday sorgusunu (`cand`) iceren bir ifadeyi indeksli planla calistirir (karar 0129).
 *
 * Aday dallari `... LIMIT 1000` bicimindedir. Planlayici trigram yuklemlerinin
 * seciciligini bilemez (pg_trgm sabit tahmin verir) ve LIMIT'e guvenerek sirali
 * taramayi secer: eslesmesi olmayan bolumde (or. yurt disi ilanlarda "canta")
 * 3,77M satir tek tek denetlenir (olculdu: 39 sn; indeksle 78 ms). `enable_seqscan`
 * yalnizca bu islemde kapatilir (`set_config(..., true)`), islem bitince duser;
 * havuzdaki baglantiya sizmaz. Cagiran zaten bir islemdeyse (sohbet aramasi,
 * bulanik adim) ayar o islemin sonuna kadar surer; oradaki sorgular da ayni indeksli
 * arama sorgularidir. Kucuk tablolarda (marka, kategori) baska yol olmadigi icin
 * sirali tarama yine kullanilir.
 */
export async function withCandidatePlan<T>(
  db: Database,
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('enable_seqscan', 'off', true)`);
    return fn(tx as unknown as Database);
  });
}

/** `best_offer`in kapsami: yalnizca aday kumesi. */
export const CANDIDATE_OFFER_SCOPE = sql`o.product_id IN (SELECT id FROM cand)`;

/**
 * `WITH cand.., best_offer AS (...), scored AS (...)`: kapidan gecen her aday ve
 * skoru. `explain` yalnizca tanida: skor carpanlarini ayri kolon olarak da
 * secer (`f_relevance`, `f_trust`, `f_stock`, `f_price`). `/ara` bunu
 * `false` ile cagirir; SQL'i tanidan once ne ise odur.
 */
export function scoredCtes(
  query: QueryObject,
  sort: TextSort,
  explain = false,
  tokenThreshold?: number,
  candidateLimit?: number,
): SQL {
  const merchantIds = merchantIdsOf(query.filters);
  const inStockOnly = query.filters.in_stock_only ?? false;
  const text = textMatch(query, tokenThreshold, candidateLimit, sort === "best_deal");
  // "En iyi fiyat" sekmesi de ayni metin kapisindan gecer: alakasiz ama
  // indirimli bir urun bu sekmede de one cikmamali.
  if (sort === "best_deal") {
    const extra = explain ? sql`, ${text.relevance}::double precision AS f_relevance` : sql``;
    return sql`
    WITH ${text.ctes},
    ${bestOfferCte(inStockOnly, merchantIds, null, CANDIDATE_OFFER_SCOPE)},
    scored AS (
      SELECT p.id, p.public_id, p.slug, p.title, p.primary_image_url,
             b.name AS brand_name, c.path AS category_path,
             bo.current_price, bo.in_stock, bo.trust_score,
             pps.current_percentile, pps.list_price_inflated, p.offer_count,
             ${BEST_OFFER_ORIGIN_COLUMNS},
             (100 - COALESCE(pps.current_percentile, 100))::double precision AS score${extra}
      FROM ${text.products}
      JOIN best_offer bo ON bo.product_id = p.id
      JOIN product_price_stats pps ON pps.product_id = p.id
      LEFT JOIN brand b ON b.id = p.brand_id
      LEFT JOIN category c ON c.id = p.category_id
      ${text.lateral}
      -- Fiyat yuzdeligi TRY gecmisidir; yurt disi teklif "en iyi fiyat" sekmesine girmez (0129).
      WHERE pps.list_price_inflated = FALSE AND NOT bo.is_foreign
        AND ${buildFilterClause(query.filters)}
        AND ${text.gate}
    )
  `;
  }

  const inputs = [
    text.relevance,
    originAdjustedTrust,
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
    WITH ${text.ctes},
    ${bestOfferCte(inStockOnly, merchantIds, null, CANDIDATE_OFFER_SCOPE)},
    scored AS (
      SELECT p.id, p.public_id, p.slug, p.title, p.primary_image_url,
             b.name AS brand_name, c.path AS category_path,
             bo.current_price, bo.in_stock, bo.trust_score,
             pps.current_percentile, pps.list_price_inflated, p.offer_count,
             ${BEST_OFFER_ORIGIN_COLUMNS},
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
