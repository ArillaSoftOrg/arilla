/**
 * `/ara/link` — yapıştırılan ürün linkine benzer katalog ürünleri
 * (docs/decisions/0031). Bu dosya yalnızca OKUR.
 *
 * İstek yolunda model çağrısı yok (CLAUDE.md kural 1): kaynak görselin
 * embedding'ini Python worker'ı üretir ve `link_resolution_request.image_embedding_id`
 * ile bağlar. Burada yapılan, `/ara/gorsel` ile aynı pgvector komşu okuması,
 * başlık üzerinde pg_trgm benzerliği (0019 indeksi) ve barkod/üretici kodu
 * eşitliğidir. `similarity_edge` kullanılmaz: kaynak ürün katalogda değil.
 */
import { type Database, embedding, offer } from "@arilla/db";
import { and, eq, sql } from "drizzle-orm";
import { foldedTitleExpr, foldForMatch } from "../search/text-match.ts";
import { searchByImageVector } from "../search/visual-search.ts";
import {
  type IdentityEvidence,
  type LinkCandidate,
  normalizeGtin,
  rankLinkCandidates,
} from "./link-ranking.ts";
import { findReusableLinkRequest, IN_FLIGHT_TTL_MS } from "./link-resolution.ts";

/** Sayfadan okunan kaynak ürün. Yalnızca bulunan alanlar dolu; hiçbiri tahmin değil. */
export interface LinkSource {
  site: string;
  title: string | null;
  brand: string | null;
  category: string | null;
  gtin: string | null;
  mpn: string | null;
  sku: string | null;
  imageUrl: string | null;
  /** Kuruş; yalnızca yapılandırılmış veriden ve para birimiyle birlikte. */
  price: number | null;
  currency: string | null;
  extractionLayer: "json_ld" | "opengraph" | "heuristic" | null;
  imageStatus: string | null;
}

export type LinkSearchState =
  | { kind: "none" }
  | { kind: "pending"; requestId: string }
  | { kind: "failed"; errorCode: string }
  | {
      kind: "resolved";
      requestId: string;
      offerId: number | null;
      imageEmbeddingId: number | null;
      source: LinkSource;
    };

function str(value: unknown, max = 500): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function safeImageUrl(value: unknown): string | null {
  const raw = str(value, 2048);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * `source` JSONB'sini savunmacı biçimde okur. Worker'ın yazdığı her alan tip
 * denetiminden geçer: sayfa kullanıcı kaynaklıdır, içinden `javascript:` bir
 * görsel adresi ya da sayı olmayan bir fiyat gelebilir.
 */
export function parseLinkSource(raw: unknown): LinkSource | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const site = str(value.site, 255);
  if (!site) return null;

  const price =
    typeof value.price === "number" && Number.isSafeInteger(value.price) && value.price > 0
      ? value.price
      : null;
  const currency =
    typeof value.currency === "string" && /^[A-Z]{3}$/.test(value.currency) ? value.currency : null;
  const layer = value.extraction_layer;

  return {
    site,
    title: str(value.title),
    brand: str(value.brand, 200),
    category: str(value.category, 300),
    gtin: str(value.gtin, 32),
    mpn: str(value.mpn, 100),
    sku: str(value.sku, 100),
    imageUrl: safeImageUrl(value.image_url),
    // Fiyat ve para birimi birlikte vardır ya da ikisi de yoktur.
    price: price !== null && currency !== null ? price : null,
    currency: price !== null && currency !== null ? currency : null,
    extractionLayer:
      layer === "json_ld" || layer === "opengraph" || layer === "heuristic" ? layer : null,
    imageStatus: str(value.image_status, 40),
  };
}

/**
 * Kanonik adres için sayfanın göstereceği durum. Karar penceresi
 * `findReusableLinkRequest` ile aynıdır: sayfanın gösterdiği ile kuyruğun
 * yeniden kullandığı istek hiçbir zaman ayrışmaz.
 */
export async function getLinkSearchState(
  db: Database,
  normalizedUrl: string,
  now: Date = new Date(),
): Promise<LinkSearchState> {
  const row = await findReusableLinkRequest(db, normalizedUrl, now);
  if (!row) return { kind: "none" };

  if (row.status === "queued" || row.status === "processing") {
    return { kind: "pending", requestId: row.id };
  }
  if (row.status === "failed") {
    return { kind: "failed", errorCode: row.errorCode ?? "unexpected" };
  }
  const source = parseLinkSource(row.source);
  if (!source) {
    // Eski worker'ın çözdüğü satır (0021 öncesi): sinyal yok, arama yapılamaz.
    return { kind: "failed", errorCode: "no_product" };
  }
  return {
    kind: "resolved",
    requestId: row.id,
    offerId: row.offerId,
    imageEmbeddingId: row.imageEmbeddingId,
    source,
  };
}

/** Bekleme istemcisinin ne kadar süre sonra vazgeçeceği: sunucunun ölü saydığı süre. */
export const LINK_SEARCH_CLIENT_TIMEOUT_MS = IN_FLIGHT_TTL_MS;

export interface LinkResultItem {
  productId: number;
  slug: string;
  title: string;
  primaryImageUrl: string | null;
  minPrice: number | null;
  offerCount: number;
  brandName: string | null;
  score: number;
}

export interface LinkSameProduct extends LinkResultItem {
  evidence: IdentityEvidence;
}

export interface LinkSearchResults {
  same: LinkSameProduct[];
  similar: LinkResultItem[];
  signals: { image: boolean; text: boolean; identity: boolean };
}

interface ProductRow extends Record<string, unknown> {
  id: string;
  slug: string;
  title: string;
  primary_image_url: string | null;
  brand_name: string | null;
  current_price: string | null;
  offer_count: number;
}

/** Aday listesinin kaç katı çekilir: birleşince tekrarlar düşer. */
const CANDIDATE_POOL = 48;
const RESULT_LIMIT = 24;

/**
 * Görsel benzerlik tabanı (jina-clip-v2, img512-v1). Yerel katalogdaki gerçek
 * vektörlerin tüm çiftleri (0031): farklı kategori + farklı marka p90 0.650,
 * p99 0.742; aynı kategori + farklı marka p90 0.718; aynı kategori + aynı
 * marka p50 0.748. 0.72 ilgisiz çiftlerin ~%95-99'unu eler, kategorideki
 * başka markaların üst dilimini (asıl "benzer ürün") tutar. Altındaki görsel
 * komşu gösterilmez: kötü bir benzer göstermek, az göstermekten kötüdür (0018).
 */
export const VISUAL_MIN_SIMILARITY = 0.72;

/** pg_trgm `%` eşiği (varsayılan 0.3) indeksle çalışır; ölçüm: 0031. */
async function textCandidates(
  db: Database,
  text: string,
  brand: string | null,
): Promise<{ candidates: LinkCandidate[]; rows: ProductRow[] }> {
  const folded = foldForMatch(text).slice(0, 300);
  if (folded.replace(/[^\p{L}\p{N}]/gu, "").length < 3) return { candidates: [], rows: [] };
  const brandFolded = brand ? foldForMatch(brand) : null;
  const titleExpr = foldedTitleExpr(sql`p.title`);
  const brandExpr = foldedTitleExpr(sql`b.name`);

  const result = await db.execute<ProductRow & { text_score: number; brand_match: boolean }>(sql`
    WITH best_offer AS (
      SELECT DISTINCT ON (o.product_id) o.product_id, o.current_price
      FROM offer o
      WHERE o.product_id IS NOT NULL AND o.is_active
      ORDER BY o.product_id, o.current_price ASC NULLS LAST
    )
    SELECT p.id, p.slug, p.title, p.primary_image_url, b.name AS brand_name,
           bo.current_price, p.offer_count,
           similarity(${titleExpr}, ${folded})::double precision AS text_score,
           (${brandFolded}::text IS NOT NULL AND b.name IS NOT NULL AND ${brandExpr} = ${brandFolded}) AS brand_match
    FROM product p
    LEFT JOIN brand b ON b.id = p.brand_id
    LEFT JOIN best_offer bo ON bo.product_id = p.id
    WHERE p.offer_count > 0 AND ${titleExpr} % ${folded}
    ORDER BY text_score DESC, p.id ASC
    LIMIT ${CANDIDATE_POOL}
  `);
  return {
    rows: result.rows,
    candidates: result.rows.map((row) => ({
      productId: Number(row.id),
      text: Number(row.text_score),
      brandMatch: Boolean(row.brand_match),
    })),
  };
}

/** Barkod ya da (aynı marka + üretici kodu) eşitliği — "aynı ürün" kanıtı. */
async function identityCandidates(
  db: Database,
  source: LinkSource,
): Promise<{ candidates: LinkCandidate[]; rows: ProductRow[] }> {
  const gtin = normalizeGtin(source.gtin);
  const mpn = source.mpn ? foldForMatch(source.mpn).replace(/\s+/g, "") : null;
  const brand = source.brand ? foldForMatch(source.brand) : null;
  if (!gtin && !(mpn && brand)) return { candidates: [], rows: [] };

  const brandExpr = foldedTitleExpr(sql`b.name`);
  const result = await db.execute<ProductRow & { evidence: IdentityEvidence }>(sql`
    WITH best_offer AS (
      SELECT DISTINCT ON (o.product_id) o.product_id, o.current_price
      FROM offer o
      WHERE o.product_id IS NOT NULL AND o.is_active
      ORDER BY o.product_id, o.current_price ASC NULLS LAST
    )
    SELECT p.id, p.slug, p.title, p.primary_image_url, b.name AS brand_name,
           bo.current_price, p.offer_count,
           CASE WHEN ${gtin}::text IS NOT NULL
                 AND lpad(regexp_replace(coalesce(p.gtin, ''), '\\D', '', 'g'), 14, '0') = ${gtin}
                THEN 'gtin' ELSE 'mpn' END AS evidence
    FROM product p
    LEFT JOIN brand b ON b.id = p.brand_id
    LEFT JOIN best_offer bo ON bo.product_id = p.id
    WHERE p.offer_count > 0 AND (
      (${gtin}::text IS NOT NULL AND p.gtin IS NOT NULL
        AND lpad(regexp_replace(p.gtin, '\\D', '', 'g'), 14, '0') = ${gtin})
      OR (${mpn}::text IS NOT NULL AND ${brand}::text IS NOT NULL AND p.mpn IS NOT NULL
        AND b.name IS NOT NULL AND ${brandExpr} = ${brand}
        AND replace(lower(p.mpn), ' ', '') = ${mpn})
    )
    LIMIT 10
  `);
  return {
    rows: result.rows,
    candidates: result.rows.map((row) => ({
      productId: Number(row.id),
      brandMatch: true,
      identity: row.evidence,
    })),
  };
}

async function sourceVector(
  db: Database,
  embeddingId: number | null,
): Promise<{ vector: number[]; modelVersion: string } | null> {
  if (embeddingId === null) return null;
  const rows = await db
    .select({ vector: embedding.vector, modelVersion: embedding.modelVersion })
    .from(embedding)
    .where(and(eq(embedding.id, embeddingId), eq(embedding.kind, "image")))
    .limit(1);
  return rows[0] ?? null;
}

async function sourceProductId(db: Database, offerId: number | null): Promise<number | null> {
  if (offerId === null) return null;
  const rows = await db
    .select({ productId: offer.productId })
    .from(offer)
    .where(eq(offer.id, offerId))
    .limit(1);
  return rows[0]?.productId ?? null;
}

/**
 * Hibrit arama: görsel komşular + başlık benzerliği + marka + kimlik.
 * Hiçbir sinyal yoksa boş döner; sahte ya da "popüler" sonuçla doldurulmaz.
 */
export async function findLinkSearchResults(
  db: Database,
  state: Extract<LinkSearchState, { kind: "resolved" }>,
): Promise<LinkSearchResults> {
  const { source } = state;
  const query = [source.brand, source.title].filter(Boolean).join(" ");

  const [vector, excludedProductId] = await Promise.all([
    sourceVector(db, state.imageEmbeddingId),
    sourceProductId(db, state.offerId),
  ]);

  const [visualItems, text, identity] = await Promise.all([
    vector
      ? searchByImageVector(db, vector.vector, vector.modelVersion, { limit: CANDIDATE_POOL })
      : Promise.resolve([]),
    source.title ? textCandidates(db, query, source.brand) : Promise.resolve(null),
    identityCandidates(db, source),
  ]);

  const visualKept = visualItems.filter((item) => item.similarityScore >= VISUAL_MIN_SIMILARITY);
  const visual: LinkCandidate[] = visualKept.map((item) => ({
    productId: item.productId,
    visual: item.similarityScore,
    brandMatch: false,
  }));
  // Görsel sinyal yalnızca tabanı geçen bir komşu varsa "kullanıldı" sayılır;
  // yoksa ağırlıklar metin + markaya döner.
  const imageUsed = visual.length > 0;

  const ranked = rankLinkCandidates([visual, text?.candidates ?? [], identity.candidates], {
    hasImage: imageUsed,
    limit: RESULT_LIMIT,
    excludeProductIds: excludedProductId !== null ? [excludedProductId] : [],
  });

  // Kart verisi: görsel sonuçlar tipli nesne, metin/kimlik ham satır.
  const details = new Map<number, Omit<LinkResultItem, "score">>();
  for (const item of visualKept) {
    details.set(item.productId, {
      productId: item.productId,
      slug: item.slug,
      title: item.title,
      primaryImageUrl: item.primaryImageUrl,
      minPrice: item.minPrice,
      offerCount: item.offerCount,
      brandName: null,
    });
  }
  for (const row of [...(text?.rows ?? []), ...identity.rows]) {
    const productId = Number(row.id);
    details.set(productId, {
      productId,
      slug: row.slug,
      title: row.title,
      primaryImageUrl: row.primary_image_url,
      minPrice: row.current_price === null ? null : Number(row.current_price),
      offerCount: Number(row.offer_count),
      brandName: row.brand_name,
    });
  }

  const same: LinkSameProduct[] = [];
  for (const candidate of ranked.same) {
    const detail = details.get(candidate.productId);
    if (detail && candidate.identity) {
      same.push({ ...detail, score: candidate.score, evidence: candidate.identity });
    }
  }
  const similar: LinkResultItem[] = [];
  for (const candidate of ranked.similar) {
    const detail = details.get(candidate.productId);
    if (detail) similar.push({ ...detail, score: candidate.score });
  }

  return {
    same,
    similar,
    signals: {
      image: imageUsed,
      text: (text?.candidates.length ?? 0) > 0,
      identity: identity.candidates.length > 0,
    },
  };
}
