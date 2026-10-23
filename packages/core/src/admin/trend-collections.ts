/**
 * Trend koleksiyonu yönetimi (karar 0149): oluşturma, ayrıntı düzenleme, bağ sahipliği
 * (`curation`) ve elle seçilmiş trendin ürün bağları. Durum, öne çıkarma ve sıra
 * `trends-admin.ts`'tedir (karar 0086); burada tekrar yazılmaz.
 *
 * Kurallar:
 * - Hepsi `trends.manage` (yönetici); yazımlar gerekçe ister ve denetim satırı AYNI işlemde
 *   yazılır (yazılamazsa değişiklik geri alınır).
 * - Eşzamanlılık: trend satırı `FOR UPDATE` ile kilitlenir ve istemcinin gördüğü değer
 *   (`expected*`) mevcut değerle karşılaştırılır; uyuşmazsa `conflict`, hiçbir şey yazılmaz.
 *   curate işi (karar 0147) yazmadan önce aynı satırı kilitleyip `curation`ı yeniden okur.
 * - Ürün bağları YALNIZCA `curation = 'manual'` trendde yazılır; otomatik trendin bağları
 *   curate işinindir. Bağlanan ürün var olmalı ve yayında olmalıdır.
 * - Ürün, teklif, fiyat ve stok satırlarına YAZILMAZ.
 * - `slug` oluşturulurken verilir ve değişmez: yayınlanmış bir trend adresi ölmesin.
 */
import {
  type Database,
  type TrendCategory,
  type TrendCuration,
  type TrendType,
  trend,
} from "@arilla/db";
import { eq, sql } from "drizzle-orm";
import { MIN_PUBLIC_TREND_PRODUCTS } from "../trends/types.ts";
import { type AuditValue, recordAdminEvent } from "./audit.ts";
import { readOnly } from "./bounds.ts";
import { type AdminActor, assertCapability } from "./capabilities.ts";
import { STALE_OFFER_DAYS, STALE_PRICE_DAYS, searchProducts } from "./catalog.ts";
import { offerNotSeenSince } from "./offer-seen.ts";
import { redactText } from "./redact.ts";
import {
  TREND_REASON_MAX,
  TREND_REASON_MIN,
  type TrendStatus,
  TrendValidationError,
} from "./trends-admin.ts";

export const TREND_CATEGORIES = ["moda", "guzellik", "ev-yasam", "ogrenci", "genel"] as const;
export const TREND_TYPES = ["evergreen", "seasonal", "campaign"] as const;
export const TREND_CURATIONS = ["auto", "manual"] as const;

/** Şema kısıtlarıyla aynı (0056): başlık 1–120, açıklama 1–280, slug ≤ 80, görsel ≤ 2048. */
export const TREND_TITLE_MAX = 120;
export const TREND_DESCRIPTION_MAX = 280;
export const TREND_SLUG_MAX = 80;
export const TREND_HERO_URL_MAX = 2048;
const TREND_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Elle seçilmiş trendde en çok ürün (curate hedefi 24; editör iki katına kadar seçebilir). */
export const TREND_MANUAL_MAX_PRODUCTS = 48;

/** Teklifte tek fiyat gözlemi ya da hiç gözlem yoksa geçmiş "ince" sayılır (son 90 gün). */
export const PRICE_HISTORY_DAYS = 90;
/** Mağazalar arası en yüksek / en düşük TL fiyat bu katı aşarsa teklif şüphelidir. */
export const PRICE_SPREAD_FACTOR = 3;

export function isTrendCategory(value: unknown): value is TrendCategory {
  return typeof value === "string" && (TREND_CATEGORIES as readonly string[]).includes(value);
}
export function isTrendType(value: unknown): value is TrendType {
  return typeof value === "string" && (TREND_TYPES as readonly string[]).includes(value);
}
export function isTrendCuration(value: unknown): value is TrendCuration {
  return typeof value === "string" && (TREND_CURATIONS as readonly string[]).includes(value);
}

/** Düzenlenebilir ayrıntılar. Durum, öne çıkarma ve sıra ayrı işlemlerdir (karar 0086). */
export interface TrendDetails {
  title: string;
  description: string;
  category: TrendCategory;
  trendType: TrendType;
  heroImageUrl: string | null;
  activeFrom: Date | null;
  activeUntil: Date | null;
}

function requireText(value: unknown, label: string, max: number): string {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (text.length < 1 || text.length > max) {
    throw new TrendValidationError(`${label} 1–${max} karakter olmalı.`);
  }
  return text;
}

function optionalDate(value: unknown, label: string): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) throw new TrendValidationError(`${label} geçersiz.`);
  return date;
}

function optionalHeroUrl(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new TrendValidationError("Kapak görseli adresi geçersiz.");
  const url = value.trim();
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TrendValidationError("Kapak görseli adresi geçersiz.");
  }
  if (
    parsed.protocol !== "https:" ||
    url.length > TREND_HERO_URL_MAX ||
    parsed.username ||
    parsed.password
  ) {
    throw new TrendValidationError(
      `Kapak görseli https adresi olmalı (en çok ${TREND_HERO_URL_MAX} karakter).`,
    );
  }
  return url;
}

/** İstemciden gelen ayrıntıları doğrular ve normalleştirir (veritabanına dokunmaz). */
export function parseTrendDetails(raw: unknown): TrendDetails {
  const input = (raw ?? {}) as Record<string, unknown>;
  if (!isTrendCategory(input.category)) throw new TrendValidationError("Geçersiz kategori.");
  if (!isTrendType(input.trendType)) throw new TrendValidationError("Geçersiz koleksiyon türü.");
  const activeFrom = optionalDate(input.activeFrom, "Yayın penceresi başlangıcı");
  const activeUntil = optionalDate(input.activeUntil, "Yayın penceresi bitişi");
  if (activeFrom && activeUntil && activeFrom >= activeUntil) {
    throw new TrendValidationError("Yayın penceresinin başlangıcı bitişinden önce olmalı.");
  }
  return {
    title: requireText(input.title, "Başlık", TREND_TITLE_MAX),
    description: requireText(input.description, "Açıklama", TREND_DESCRIPTION_MAX),
    category: input.category,
    trendType: input.trendType,
    heroImageUrl: optionalHeroUrl(input.heroImageUrl),
    activeFrom,
    activeUntil,
  };
}

export function parseTrendSlug(raw: unknown): string {
  const slug = typeof raw === "string" ? raw.trim() : "";
  if (!TREND_SLUG_PATTERN.test(slug) || slug.length > TREND_SLUG_MAX) {
    throw new TrendValidationError(
      `Adres yalnızca küçük harf, rakam ve tire içermeli (en çok ${TREND_SLUG_MAX} karakter).`,
    );
  }
  return slug;
}

const TURKISH_FOLD: Record<string, string> = {
  ç: "c",
  ğ: "g",
  ı: "i",
  i: "i",
  İ: "i",
  I: "i",
  ö: "o",
  ş: "s",
  ü: "u",
  â: "a",
  î: "i",
  û: "u",
};

/** Başlıktan adres önerisi (yalnızca öneri; kayıtta `parseTrendSlug` ayrıca doğrular). */
export function suggestTrendSlug(title: string): string {
  const folded = [...title].map((ch) => TURKISH_FOLD[ch] ?? ch.toLowerCase()).join("");
  return folded
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, TREND_SLUG_MAX)
    .replace(/-+$/g, "");
}

/** Sıralı, tekrarsız ürün kimliği listesi; en çok `TREND_MANUAL_MAX_PRODUCTS`. */
export function parseProductIdList(raw: unknown, label = "Ürün listesi"): number[] {
  if (!Array.isArray(raw)) throw new TrendValidationError(`${label} geçersiz.`);
  if (raw.length > TREND_MANUAL_MAX_PRODUCTS) {
    throw new TrendValidationError(`En çok ${TREND_MANUAL_MAX_PRODUCTS} ürün seçilebilir.`);
  }
  const seen = new Set<number>();
  for (const value of raw) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      throw new TrendValidationError(`${label} geçersiz ürün kimliği içeriyor.`);
    }
    if (seen.has(value)) throw new TrendValidationError(`${label} aynı ürünü iki kez içeriyor.`);
    seen.add(value);
  }
  return [...seen];
}

function requireId(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  throw new TrendValidationError("Geçersiz trend.");
}

function requireReason(value: unknown): string {
  const reason = typeof value === "string" ? value.trim() : "";
  if (reason.length < TREND_REASON_MIN || reason.length > TREND_REASON_MAX) {
    throw new TrendValidationError(
      `Gerekçe ${TREND_REASON_MIN}–${TREND_REASON_MAX} karakter olmalı.`,
    );
  }
  return redactText(reason, TREND_REASON_MAX) ?? reason;
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Num = string | number | null;

const DETAIL_KEYS = [
  "title",
  "description",
  "category",
  "trendType",
  "heroImageUrl",
  "activeFrom",
  "activeUntil",
] as const satisfies readonly (keyof TrendDetails)[];

function auditValue(value: TrendDetails[keyof TrendDetails]): AuditValue {
  return value instanceof Date ? value.toISOString() : value;
}

function sameValue(
  a: TrendDetails[keyof TrendDetails],
  b: TrendDetails[keyof TrendDetails],
): boolean {
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  return a === b;
}

/** `a`'dan `b`'ye değişen alanlar. */
export function changedTrendDetails(a: TrendDetails, b: TrendDetails): (keyof TrendDetails)[] {
  return DETAIL_KEYS.filter((key) => !sameValue(a[key], b[key]));
}

async function lockTrendForEdit(tx: Tx, id: number) {
  const rows = await tx
    .select({
      id: trend.id,
      slug: trend.slug,
      status: trend.status,
      curation: trend.curation,
      title: trend.title,
      description: trend.description,
      category: trend.category,
      trendType: trend.trendType,
      heroImageUrl: trend.heroImageUrl,
      activeFrom: trend.activeFrom,
      activeUntil: trend.activeUntil,
    })
    .from(trend)
    .where(eq(trend.id, id))
    .for("update");
  return rows[0];
}

function detailsOf(row: NonNullable<Awaited<ReturnType<typeof lockTrendForEdit>>>): TrendDetails {
  return {
    title: row.title,
    description: row.description,
    category: row.category,
    trendType: row.trendType,
    heroImageUrl: row.heroImageUrl,
    activeFrom: row.activeFrom,
    activeUntil: row.activeUntil,
  };
}

export type TrendCreateResult = { status: "created"; trendId: number } | { status: "slug_taken" };

/**
 * Yeni koleksiyon: her zaman `draft`, sıranın sonunda. `manual` seçilirse satır doğrudan
 * `manual` eklenir; curate onu hiçbir an otomatik görmez. Ürünler ayrıca eklenir.
 */
export async function createTrend(
  db: Database,
  actor: AdminActor,
  input: {
    slug: unknown;
    details: unknown;
    curation: unknown;
    featured?: unknown;
    reason: unknown;
  },
): Promise<TrendCreateResult> {
  assertCapability(actor, "trends.manage");
  const slug = parseTrendSlug(input.slug);
  const details = parseTrendDetails(input.details);
  if (!isTrendCuration(input.curation))
    throw new TrendValidationError("Geçersiz koleksiyon türü (elle/otomatik).");
  const curation = input.curation;
  const featured = input.featured ?? false;
  if (typeof featured !== "boolean") throw new TrendValidationError("Geçersiz değer.");
  const reason = requireReason(input.reason);

  return db.transaction(async (tx) => {
    const inserted = await tx.execute<{ id: Num }>(sql`
      INSERT INTO trend (slug, title, description, category, trend_type, hero_image_url,
                         active_from, active_until, status, curation, featured, sort_order)
      SELECT ${slug}, ${details.title}, ${details.description}, ${details.category},
             ${details.trendType}, ${details.heroImageUrl}, ${details.activeFrom},
             ${details.activeUntil}, 'draft', ${curation}, ${featured},
             COALESCE((SELECT max(sort_order) FROM trend), 0) + 1
      ON CONFLICT (slug) DO NOTHING
      RETURNING id
    `);
    const row = inserted.rows[0];
    if (!row) return { status: "slug_taken" };
    const trendId = Number(row.id);
    await recordAdminEvent(tx, {
      actor,
      action: "trends.create",
      targetType: "trend",
      targetId: trendId,
      before: null,
      after: {
        slug,
        status: "draft",
        curation,
        featured,
        ...Object.fromEntries(DETAIL_KEYS.map((key) => [key, auditValue(details[key])])),
      },
      reason,
    });
    return { status: "created", trendId };
  });
}

export type TrendEditResult =
  | { status: "updated" }
  | { status: "unchanged" }
  | { status: "not_found" }
  | { status: "conflict" };

/**
 * Ayrıntı düzenleme. `expected` istemcinin formu açtığı andaki değerlerdir; arada başka
 * biri değiştirdiyse `conflict`. `updated_at` sürüm olarak kullanılmaz (curate onu da yazar).
 */
export async function updateTrendDetails(
  db: Database,
  actor: AdminActor,
  input: { trendId: unknown; expected: unknown; next: unknown; reason: unknown },
): Promise<TrendEditResult> {
  assertCapability(actor, "trends.manage");
  const id = requireId(input.trendId);
  const expected = parseTrendDetails(input.expected);
  const next = parseTrendDetails(input.next);
  const reason = requireReason(input.reason);

  return db.transaction(async (tx) => {
    const current = await lockTrendForEdit(tx, id);
    if (!current) return { status: "not_found" };
    const now = detailsOf(current);
    if (changedTrendDetails(now, expected).length > 0) return { status: "conflict" };
    const changed = changedTrendDetails(now, next);
    if (changed.length === 0) return { status: "unchanged" };
    const patch: Partial<typeof trend.$inferInsert> = { updatedAt: new Date() };
    for (const key of changed) Object.assign(patch, { [key]: next[key] });
    await tx.update(trend).set(patch).where(eq(trend.id, id));
    await recordAdminEvent(tx, {
      actor,
      action: "trends.update",
      targetType: "trend",
      targetId: id,
      before: {
        slug: current.slug,
        ...Object.fromEntries(changed.map((k) => [k, auditValue(now[k])])),
      },
      after: Object.fromEntries(changed.map((k) => [k, auditValue(next[k])])),
      reason,
    });
    return { status: "updated" };
  });
}

/**
 * Bağ sahipliği. `auto` → `manual`: mevcut bağlar editörün olur, curate artık dokunmaz.
 * `manual` → `auto`: bir sonraki `curate --apply` bağları kendi seçimiyle yeniden yazar
 * (arayüz uyarır). Bağlar bu işlemde değişmez.
 */
export async function setTrendCuration(
  db: Database,
  actor: AdminActor,
  input: { trendId: unknown; next: unknown; expected: unknown; reason: unknown },
): Promise<TrendEditResult> {
  assertCapability(actor, "trends.manage");
  const id = requireId(input.trendId);
  if (!isTrendCuration(input.next) || !isTrendCuration(input.expected)) {
    throw new TrendValidationError("Geçersiz koleksiyon türü (elle/otomatik).");
  }
  const next = input.next;
  const reason = requireReason(input.reason);

  return db.transaction(async (tx) => {
    const current = await lockTrendForEdit(tx, id);
    if (!current) return { status: "not_found" };
    if (current.curation !== input.expected) return { status: "conflict" };
    if (current.curation === next) return { status: "unchanged" };
    await tx.update(trend).set({ curation: next, updatedAt: new Date() }).where(eq(trend.id, id));
    await recordAdminEvent(tx, {
      actor,
      action: "trends.curation",
      targetType: "trend",
      targetId: id,
      before: { curation: current.curation, slug: current.slug },
      after: { curation: next },
      reason,
    });
    return { status: "updated" };
  });
}

export type TrendProductsResult =
  | TrendEditResult
  /** Otomatik trendin bağları curate işinindir; önce `manual` yapılmalı. */
  | { status: "not_manual" }
  /** Arşivdeki trendin bağları değişmez; önce taslağa alınır. */
  | { status: "archived" }
  /** Yok ya da yayında olmayan ürün (kimlikleri). */
  | { status: "invalid_products"; productIds: number[] }
  /** Yayındaki trend eşik altına düşürülemez. */
  | { status: "below_threshold"; showable: number; required: number };

/**
 * Elle seçilmiş trendin bağlarını verilen sıralı listeyle birebir eşitler (tek işlem).
 * `expectedProductIds`: istemcinin gördüğü sıralı liste; mevcutla aynı değilse `conflict`.
 * Yayındaki trendde yeni liste `MIN_PUBLIC_TREND_PRODUCTS` gösterilebilir ürünün altına
 * düşemez. Sıra kısıtı ertelenmiştir (0056): silip yeniden eklemek COMMIT'te denetlenir.
 */
export async function setTrendProducts(
  db: Database,
  actor: AdminActor,
  input: { trendId: unknown; productIds: unknown; expectedProductIds: unknown; reason: unknown },
): Promise<TrendProductsResult> {
  assertCapability(actor, "trends.manage");
  const id = requireId(input.trendId);
  const next = parseProductIdList(input.productIds);
  const expected = parseProductIdList(input.expectedProductIds, "Beklenen ürün listesi");
  const reason = requireReason(input.reason);

  return db.transaction(async (tx) => {
    const current = await lockTrendForEdit(tx, id);
    if (!current) return { status: "not_found" };
    if (current.curation !== "manual") return { status: "not_manual" };
    if (current.status === "archived") return { status: "archived" };
    const existing = await tx.execute<{ product_id: Num }>(sql`
      SELECT product_id FROM trend_product WHERE trend_id = ${id} ORDER BY sort_order, product_id
    `);
    const now = existing.rows.map((row) => Number(row.product_id));
    if (!sameList(now, expected)) return { status: "conflict" };
    if (sameList(now, next)) return { status: "unchanged" };

    if (next.length > 0) {
      const found = await tx.execute<{ id: Num; showable: boolean }>(sql`
        SELECT p.id,
               (p.primary_image_url IS NOT NULL AND p.min_price > 0 AND p.in_stock_count > 0) AS showable
          FROM product p
         WHERE p.id = ANY(${pgBigintArray(next)}::bigint[]) AND p.publication_state = 'published'
      `);
      const ok = new Set(found.rows.map((row) => Number(row.id)));
      const missing = next.filter((productId) => !ok.has(productId));
      if (missing.length > 0) return { status: "invalid_products", productIds: missing };
      if (current.status === "published") {
        const showable = found.rows.filter((row) => row.showable).length;
        if (showable < MIN_PUBLIC_TREND_PRODUCTS) {
          return { status: "below_threshold", showable, required: MIN_PUBLIC_TREND_PRODUCTS };
        }
      }
    } else if (current.status === "published") {
      return { status: "below_threshold", showable: 0, required: MIN_PUBLIC_TREND_PRODUCTS };
    }

    await tx.execute(sql`DELETE FROM trend_product WHERE trend_id = ${id}`);
    if (next.length > 0) {
      await tx.execute(sql`
        INSERT INTO trend_product (trend_id, product_id, sort_order)
        SELECT ${id}, k.product_id, (k.ord - 1)::int
          FROM unnest(${pgBigintArray(next)}::bigint[]) WITH ORDINALITY AS k(product_id, ord)
      `);
    }
    await tx.update(trend).set({ updatedAt: new Date() }).where(eq(trend.id, id));
    await recordAdminEvent(tx, {
      actor,
      action: "trends.products",
      targetType: "trend",
      targetId: id,
      before: { slug: current.slug, productIds: now },
      after: { productIds: next },
      reason,
    });
    return { status: "updated" };
  });
}

function sameList(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/** Doğrulanmış pozitif tamsayılardan Postgres dizi metni (`{1,2}`); parametre olarak gider. */
function pgBigintArray(ids: readonly number[]): string {
  return `{${ids.join(",")}}`;
}

// --- Ürün kartları ve uyarılar -------------------------------------------------------------

/**
 * Kartta gösterilen uyarı. İlk dördü ürünü GÖSTERİLEMEZ yapar (public kural); diğerleri
 * editöre bilgi verir, yayını engellemez. Orijinallik iddiası değildir: yalnızca verinin
 * tazeliği ve tutarlılığıdır.
 */
export type TrendProductWarning =
  | "not_published"
  | "missing_image"
  | "no_try_price"
  | "out_of_stock"
  | "stale_price"
  | "stale_offer"
  | "thin_price_history"
  | "price_spread"
  | "no_affiliate";

export const BLOCKING_WARNINGS: ReadonlySet<TrendProductWarning> = new Set([
  "not_published",
  "missing_image",
  "no_try_price",
  "out_of_stock",
]);

export interface TrendProductCard {
  id: number;
  slug: string;
  title: string;
  brandName: string | null;
  imageUrl: string | null;
  /** TL, kuruş; TRY dışı tutar buraya girmez. */
  minPrice: number | null;
  maxPrice: number | null;
  offerCount: number;
  inStockCount: number;
  foreignOfferCount: number;
  publicationState: string;
  priceUpdatedAt: Date | null;
  sourceMerchant: { slug: string; name: string } | null;
  /** Etkin TRY teklifleri: toplam, son `STALE_OFFER_DAYS` günde görülen, affiliate bağlantılı. */
  activeTryOffers: number;
  freshTryOffers: number;
  affiliateOffers: number;
  /** Tekliflerin son `PRICE_HISTORY_DAYS` gündeki en çok fiyat gözlemi. */
  maxPriceObservations: number;
  /** Public kural: yayında + görselli + fiyatlı + stokta. */
  showable: boolean;
  warnings: TrendProductWarning[];
}

type CardFacts = Omit<TrendProductCard, "showable" | "warnings">;

/** Kart uyarıları (saf; birim testli). */
export function trendProductWarnings(card: CardFacts, now: Date): TrendProductWarning[] {
  const out: TrendProductWarning[] = [];
  if (card.publicationState !== "published") out.push("not_published");
  if (!card.imageUrl) out.push("missing_image");
  if (!card.minPrice || card.minPrice <= 0) out.push("no_try_price");
  if (card.inStockCount <= 0) out.push("out_of_stock");
  const staleBefore = now.getTime() - STALE_PRICE_DAYS * 86_400_000;
  if (!card.priceUpdatedAt || card.priceUpdatedAt.getTime() < staleBefore) out.push("stale_price");
  if (card.activeTryOffers > 0 && card.freshTryOffers === 0) out.push("stale_offer");
  if (card.activeTryOffers > 0 && card.maxPriceObservations <= 1) out.push("thin_price_history");
  if (card.minPrice && card.maxPrice && card.maxPrice > card.minPrice * PRICE_SPREAD_FACTOR) {
    out.push("price_spread");
  }
  if (card.activeTryOffers > 0 && card.affiliateOffers === 0) out.push("no_affiliate");
  return out;
}

function toCard(facts: CardFacts, now: Date): TrendProductCard {
  const warnings = trendProductWarnings(facts, now);
  return { ...facts, warnings, showable: !warnings.some((w) => BLOCKING_WARNINGS.has(w)) };
}

type CardRow = {
  id: Num;
  slug: string;
  title: string;
  brand_name: string | null;
  primary_image_url: string | null;
  min_price: Num;
  max_price: Num;
  offer_count: Num;
  in_stock_count: Num;
  foreign_offer_count: Num;
  publication_state: string;
  price_updated_at: Date | string | null;
  source_slug: string | null;
  source_name: string | null;
  active_try: Num;
  fresh_try: Num;
  affiliate: Num;
  max_obs: Num;
};

/**
 * Verilen ürünlerin kartları, verilen sırayla. Kimlik başına birincil anahtar araması;
 * teklifler `offer_product_idx`, fiyat geçmişi `price_point` birincil anahtarı (son 90 gün).
 * En çok `TREND_MANUAL_MAX_PRODUCTS` (+ arama sayfası) kimlik için çağrılır.
 */
async function loadProductCards(
  tx: Tx,
  ids: readonly number[],
  now: Date,
): Promise<TrendProductCard[]> {
  if (ids.length === 0) return [];
  const staleCutoff = sql`now() - (${STALE_OFFER_DAYS} * interval '1 day')`;
  const rows = await tx.execute<CardRow>(sql`
    SELECT p.id, p.slug, p.title, b.name AS brand_name, p.primary_image_url, p.min_price,
           p.max_price, p.offer_count, p.in_stock_count, p.foreign_offer_count,
           p.publication_state, p.price_updated_at, sm.slug AS source_slug, sm.name AS source_name,
           ev.active_try, ev.fresh_try, ev.affiliate, ev.max_obs
      FROM unnest(${pgBigintArray(ids)}::bigint[]) WITH ORDINALITY AS k(id, ord)
      JOIN product p ON p.id = k.id
      LEFT JOIN brand b ON b.id = p.brand_id
      LEFT JOIN merchant sm ON sm.id = p.source_merchant_id
      LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE o.currency = 'TRY') AS active_try,
               count(*) FILTER (WHERE o.currency = 'TRY' AND NOT ${offerNotSeenSince(staleCutoff)}) AS fresh_try,
               count(*) FILTER (WHERE o.affiliate_url IS NOT NULL) AS affiliate,
               COALESCE(max((SELECT count(*) FROM price_point pp
                              WHERE pp.offer_id = o.id
                                AND pp.observed_at > now() - (${PRICE_HISTORY_DAYS} * interval '1 day'))), 0) AS max_obs
          FROM offer o
         WHERE o.product_id = p.id AND o.is_active
      ) ev ON true
     ORDER BY k.ord
  `);
  return rows.rows.map((row) =>
    toCard(
      {
        id: Number(row.id),
        slug: row.slug,
        title: row.title,
        brandName: row.brand_name,
        imageUrl: row.primary_image_url,
        minPrice: row.min_price === null ? null : Number(row.min_price),
        maxPrice: row.max_price === null ? null : Number(row.max_price),
        offerCount: Number(row.offer_count ?? 0),
        inStockCount: Number(row.in_stock_count ?? 0),
        foreignOfferCount: Number(row.foreign_offer_count ?? 0),
        publicationState: row.publication_state,
        priceUpdatedAt: row.price_updated_at ? new Date(row.price_updated_at) : null,
        sourceMerchant: row.source_slug
          ? { slug: row.source_slug, name: row.source_name ?? row.source_slug }
          : null,
        activeTryOffers: Number(row.active_try ?? 0),
        freshTryOffers: Number(row.fresh_try ?? 0),
        affiliateOffers: Number(row.affiliate ?? 0),
        maxPriceObservations: Number(row.max_obs ?? 0),
      },
      now,
    ),
  );
}

export interface TrendEditor {
  id: number;
  slug: string;
  status: TrendStatus;
  curation: TrendCuration;
  featured: boolean;
  sortOrder: number;
  details: TrendDetails;
  /** Bağlı ürünler, trend sırasıyla. */
  products: TrendProductCard[];
  minProducts: number;
  maxProducts: number;
  showableProducts: number;
  /** Yayına alınabilir mi (eşik). Yayındaysa "yayında kalabilir mi". */
  meetsThreshold: boolean;
}

export async function getTrendEditor(
  db: Database,
  actor: AdminActor,
  trendId: unknown,
  now: Date = new Date(),
): Promise<TrendEditor | null> {
  assertCapability(actor, "trends.manage");
  const id = requireId(trendId);
  return readOnly(db, 5_000, async (tx) => {
    const rows = await tx
      .select({
        id: trend.id,
        slug: trend.slug,
        status: trend.status,
        curation: trend.curation,
        featured: trend.featured,
        sortOrder: trend.sortOrder,
        title: trend.title,
        description: trend.description,
        category: trend.category,
        trendType: trend.trendType,
        heroImageUrl: trend.heroImageUrl,
        activeFrom: trend.activeFrom,
        activeUntil: trend.activeUntil,
      })
      .from(trend)
      .where(eq(trend.id, id));
    const row = rows[0];
    if (!row) return null;
    // Otomatik trendde curate en çok hedef kadar bağ yazar; yine de üst sınır uygulanır.
    const links = await tx.execute<{ product_id: Num }>(sql`
      SELECT product_id FROM trend_product WHERE trend_id = ${id}
       ORDER BY sort_order, product_id LIMIT ${TREND_MANUAL_MAX_PRODUCTS * 2}
    `);
    const products = await loadProductCards(
      tx,
      links.rows.map((link) => Number(link.product_id)),
      now,
    );
    const showable = products.filter((product) => product.showable).length;
    return {
      id: row.id,
      slug: row.slug,
      status: row.status,
      curation: row.curation,
      featured: row.featured,
      sortOrder: row.sortOrder,
      details: {
        title: row.title,
        description: row.description,
        category: row.category,
        trendType: row.trendType,
        heroImageUrl: row.heroImageUrl,
        activeFrom: row.activeFrom,
        activeUntil: row.activeUntil,
      },
      products,
      minProducts: MIN_PUBLIC_TREND_PRODUCTS,
      maxProducts: TREND_MANUAL_MAX_PRODUCTS,
      showableProducts: showable,
      meetsThreshold: showable >= MIN_PUBLIC_TREND_PRODUCTS,
    };
  });
}

export interface TrendProductSearch {
  rows: TrendProductCard[];
  /** Sonraki sayfa imleci (katalog aramasıyla aynı: `p.id < before`). */
  nextBefore: number | null;
}

/**
 * Koleksiyona eklenecek ürün araması: katalog aramasının AYNISI (`searchProducts`, yalnızca
 * yayındaki ürünler; sayı → kimlik, 8–14 hane → GTIN, diğer → başlık), kartları uyarılarla.
 */
export async function searchTrendProducts(
  db: Database,
  actor: AdminActor,
  input: { query: unknown; before?: unknown },
  now: Date = new Date(),
): Promise<TrendProductSearch> {
  assertCapability(actor, "trends.manage");
  const query = typeof input.query === "string" ? input.query.trim().slice(0, 200) : "";
  if (query.length < 2) throw new TrendValidationError("Aramak için en az 2 karakter yaz.");
  const before = typeof input.before === "number" ? input.before : undefined;
  const result = await searchProducts(db, actor, { state: "published", query, before });
  const rows = await readOnly(db, 5_000, (tx) =>
    loadProductCards(
      tx,
      result.rows.map((row) => row.id),
      now,
    ),
  );
  return { rows, nextBefore: result.nextBefore };
}
