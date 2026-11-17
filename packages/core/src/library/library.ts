/**
 * Kütüphane (karar 0217): kullanıcının aramalarında ilk 3'te çıkan gerçek ürünlerin kişisel
 * vitrini. Arama/sohbet geçmişi DEĞİLDİR: yalnızca (kullanıcı, ürün) ilişkisi saklanır; başlık,
 * görsel, fiyat ve kategori okurken güncel katalogdan gelir. `product_view` (/gecmis) ve
 * `saved_item` ile bağımsızdır.
 *
 * Yazma: yalnızca `personalization` rızası varken; ürün kimliği istemciden değil arama
 * sonucundan gelir ve katalogda doğrulanır; `is_discoverable = FALSE` kategoriler hariç.
 * Tekrar eklenmez (PK), tekrar çıkan ürün öne alınır. Kullanıcı başına en çok 60 satır.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";

export const LIBRARY_CANDIDATE_COUNT = 3;
export const LIBRARY_MAX_ROWS = 60;
export const LIBRARY_RETENTION_DAYS = 180;
export const LIBRARY_PAGE_SIZE = 20;
export const LIBRARY_QUERY_MAX_LENGTH = 80;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface LibraryCandidate {
  productId: number;
  rank: number;
}

export interface LibrarySearchSnapshot {
  /** `FallbackSearchOutcome.mode`; yalnızca `results` aday üretir. */
  mode: string;
  /** Kullanıcıya gösterilen sıralı ürünler. */
  items: readonly { productId: number }[];
  /** Yalnızca varsayılan (`balanced`) sıralama kullanıcının üst sıra sonucudur. */
  sort: string;
  isNewSearch: boolean;
  page: number;
}

/** Saf kural: hangi aramanın ilk 3 ürünü aday olur. */
export function selectLibraryCandidates(snapshot: LibrarySearchSnapshot): LibraryCandidate[] {
  if (snapshot.mode !== "results") return [];
  if (!snapshot.isNewSearch || snapshot.page !== 1) return [];
  if (snapshot.sort !== "balanced") return [];
  const seen = new Set<number>();
  const out: LibraryCandidate[] = [];
  for (const item of snapshot.items) {
    if (out.length >= LIBRARY_CANDIDATE_COUNT) break;
    const id = item.productId;
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    out.push({ productId: id, rank: out.length + 1 });
  }
  return out;
}

export type RecordLibraryOutcome = "recorded" | "no_user" | "no_consent" | "nothing";

export async function recordLibraryCandidates(
  db: Database,
  input: { userId: number | null | undefined; candidates: readonly LibraryCandidate[]; now?: Date },
): Promise<RecordLibraryOutcome> {
  const { userId } = input;
  if (typeof userId !== "number" || !Number.isInteger(userId)) return "no_user";
  const candidates = input.candidates.filter(
    (c) => Number.isInteger(c.productId) && c.productId > 0 && c.rank >= 1 && c.rank <= 3,
  );
  if (candidates.length === 0) return "nothing";
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('library_item'), ${userId}::int)`);

    const consent = await tx.execute(sql`
      SELECT granted FROM user_consent
       WHERE user_id = ${userId} AND kind = 'personalization'
       ORDER BY granted_at DESC, id DESC LIMIT 1
    `);
    if ((consent.rows[0] as { granted?: boolean } | undefined)?.granted !== true) {
      return "no_consent";
    }

    // Aynı aramanın ürünleri sıra korunsun diye 1 ms aralıklı damgalanır (1. en yeni).
    for (const c of candidates) {
      const at = new Date(now.getTime() - (c.rank - 1)).toISOString();
      await tx.execute(sql`
        INSERT INTO library_item (user_id, product_id, first_added_at, last_surfaced_at, best_rank)
        SELECT ${userId}, p.id, ${at}::timestamptz, ${at}::timestamptz, ${c.rank}
          FROM product p
         WHERE p.id = ${c.productId}
           AND NOT EXISTS (
             SELECT 1 FROM category pc
               JOIN category hidden
                 ON hidden.is_discoverable = FALSE
                AND (pc.path = hidden.path OR pc.path LIKE hidden.path || '/%')
              WHERE pc.id = p.category_id)
        ON CONFLICT (user_id, product_id) DO UPDATE
           SET last_surfaced_at = GREATEST(library_item.last_surfaced_at, EXCLUDED.last_surfaced_at),
               surfaced_count = library_item.surfaced_count + 1,
               best_rank = LEAST(library_item.best_rank, EXCLUDED.best_rank)
      `);
    }

    await tx.execute(sql`
      DELETE FROM library_item
       WHERE user_id = ${userId}
         AND product_id NOT IN (
           SELECT product_id FROM library_item WHERE user_id = ${userId}
            ORDER BY last_surfaced_at DESC, product_id DESC LIMIT ${LIBRARY_MAX_ROWS})
    `);
    return "recorded";
  });
}

export interface LibraryItemView {
  productId: number;
  slug: string;
  title: string;
  primaryImageUrl: string | null;
  brandName: string | null;
  minPrice: number | null;
  inStock: boolean;
  categorySlug: string | null;
  categoryName: string | null;
  surfacedAt: Date;
}

export interface LibraryCategory {
  slug: string;
  name: string;
}

export interface LibraryPage {
  items: LibraryItemView[];
  nextCursor: string | null;
}

export interface LibraryQuery {
  categorySlug?: string | null;
  q?: string | null;
  cursor?: string | null;
  limit?: number;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export function encodeLibraryCursor(surfacedAt: Date, productId: number): string {
  return `${surfacedAt.toISOString()}|${productId}`;
}

export function decodeLibraryCursor(
  raw: string | null | undefined,
): { at: Date; productId: number } | null {
  if (!raw) return null;
  const [iso, id] = raw.split("|");
  const at = new Date(iso ?? "");
  const productId = Number(id);
  if (Number.isNaN(at.getTime()) || !Number.isInteger(productId) || productId <= 0) return null;
  return { at, productId };
}

interface Row {
  product_id: string | number;
  slug: string;
  title: string;
  primary_image_url: string | null;
  brand_name: string | null;
  min_price: string | number | null;
  in_stock_count: number;
  root_slug: string | null;
  root_name: string | null;
  last_surfaced_at: Date | string;
}

export async function listLibrary(
  db: Database,
  userId: number,
  query: LibraryQuery = {},
): Promise<LibraryPage> {
  if (!Number.isInteger(userId)) return { items: [], nextCursor: null };
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? LIBRARY_PAGE_SIZE) || 1, 1), 50);
  const cursor = decodeLibraryCursor(query.cursor);
  const text = (query.q ?? "").trim().slice(0, LIBRARY_QUERY_MAX_LENGTH);
  const like = text ? `%${escapeLike(text.toLocaleLowerCase("tr-TR"))}%` : null;
  const cat = query.categorySlug?.trim() || null;
  const cursorAt = cursor ? cursor.at.toISOString() : null;

  const result = await db.execute(sql`
    SELECT p.id AS product_id, p.slug, p.title, p.primary_image_url,
           b.name AS brand_name, p.min_price, p.in_stock_count,
           root.slug AS root_slug, root.name AS root_name, li.last_surfaced_at
      FROM library_item li
      JOIN product p ON p.id = li.product_id
      LEFT JOIN brand b ON b.id = p.brand_id
      LEFT JOIN category c ON c.id = p.category_id
      LEFT JOIN category root ON c.path IS NOT NULL AND root.path = split_part(c.path, '/', 1)
     WHERE li.user_id = ${userId}
       AND (c.id IS NULL OR NOT EXISTS (
             SELECT 1 FROM category hidden
              WHERE hidden.is_discoverable = FALSE
                AND (c.path = hidden.path OR c.path LIKE hidden.path || '/%')))
       ${cat ? sql`AND root.slug = ${cat}` : sql``}
       ${
         like
           ? sql`AND (lower(p.title) LIKE ${like} OR lower(coalesce(b.name, '')) LIKE ${like})`
           : sql``
}
       ${
         cursor
           ? sql`AND (li.last_surfaced_at, li.product_id) < (${cursorAt}::timestamptz, ${cursor.productId})`
           : sql``
}
     ORDER BY li.last_surfaced_at DESC, li.product_id DESC
     LIMIT ${limit + 1}
  `);
  const rows = result.rows as unknown as Row[];
  const items = rows.slice(0, limit).map<LibraryItemView>((r) => ({
    productId: Number(r.product_id),
    slug: r.slug,
    title: r.title,
    primaryImageUrl: r.primary_image_url,
    brandName: r.brand_name,
    minPrice: r.min_price === null ? null : Number(r.min_price),
    inStock: r.in_stock_count > 0,
    categorySlug: r.root_slug,
    categoryName: r.root_name,
    surfacedAt: new Date(r.last_surfaced_at),
  }));
  const last = items[items.length - 1];
  return {
    items,
    nextCursor:
      rows.length > limit && last ? encodeLibraryCursor(last.surfacedAt, last.productId) : null,
  };
}

/** Çipler: yalnızca kullanıcının kütüphanesinde gerçekten bulunan ana kategoriler. */
export async function listLibraryCategories(
  db: Database,
  userId: number,
): Promise<LibraryCategory[]> {
  if (!Number.isInteger(userId)) return [];
  const result = await db.execute(sql`
    SELECT DISTINCT root.slug, root.name
      FROM library_item li
      JOIN product p ON p.id = li.product_id
      JOIN category c ON c.id = p.category_id
      JOIN category root ON root.path = split_part(c.path, '/', 1)
     WHERE li.user_id = ${userId}
       AND root.is_discoverable = TRUE
     ORDER BY root.name
  `);
  return (result.rows as { slug: string; name: string }[]).map((r) => ({
    slug: r.slug,
    name: r.name,
  }));
}

export async function removeLibraryItem(
  db: Database,
  userId: number,
  productId: number,
): Promise<boolean> {
  if (!Number.isInteger(userId) || !Number.isInteger(productId)) return false;
  const r = await db.execute(
    sql`DELETE FROM library_item WHERE user_id = ${userId} AND product_id = ${productId}`,
  );
  return (r.rowCount ?? 0) > 0;
}

export async function clearLibrary(db: Database, userId: number): Promise<number> {
  if (!Number.isInteger(userId)) return 0;
  const r = await db.execute(sql`DELETE FROM library_item WHERE user_id = ${userId}`);
  return r.rowCount ?? 0;
}

/** 180 günden eski satırlar (cleanup-auth). Partili, idempotent. */
export async function purgeExpiredLibrary(
  db: Pick<Database, "execute">,
  options: { now?: Date; batchSize?: number; maxBatches?: number } = {},
): Promise<{ deleted: number; truncated: boolean }> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? 5_000;
  const maxBatches = options.maxBatches ?? 20;
  const cutoff = new Date(now.getTime() - LIBRARY_RETENTION_DAYS * DAY_MS).toISOString();
  let deleted = 0;
  for (let i = 0; i < maxBatches; i++) {
    const r = await db.execute(sql`
      DELETE FROM library_item
       WHERE ctid IN (SELECT ctid FROM library_item
                       WHERE last_surfaced_at < ${cutoff}::timestamptz LIMIT ${batchSize})
    `);
    const n = r.rowCount ?? 0;
    deleted += n;
    if (n < batchSize) return { deleted, truncated: false };
  }
  return { deleted, truncated: true };
}

/** Arayüz boş durumu için: son `personalization` kararı açık mı. */
export async function hasLibraryConsent(db: Database, userId: number): Promise<boolean> {
  if (!Number.isInteger(userId)) return false;
  const r = await db.execute(sql`
    SELECT granted FROM user_consent
     WHERE user_id = ${userId} AND kind = 'personalization'
     ORDER BY granted_at DESC, id DESC LIMIT 1
  `);
  return (r.rows[0] as { granted?: boolean } | undefined)?.granted === true;
}
