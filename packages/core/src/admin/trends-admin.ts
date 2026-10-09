/**
 * `/yonetim/trendler` (karar 0086): trend listesi ve yönetimi.
 *
 * Görünürlük public kuralla AYNI hesaplanır (`get-trends.ts`): yayında VE
 * `MIN_PUBLIC_TREND_PRODUCTS` kadar gösterilebilir ürün (görselli + fiyatlı +
 * stokta, `TREND_SHOWABLE_PRODUCT_SQL`). Yayın penceresi yalnızca
 * vitrin/bölüm seçimini etkiler; ayrı gösterilir.
 *
 * Değişiklikler: durum (yayınla / geri çek / arşivle / geri al), öne çıkarma ve
 * sıra. Hepsi `trends.manage` (yönetici), gerekçe zorunlu, satır kilidiyle ve
 * denetim kaydıyla AYNI işlemde; kayıt yazılamazsa değişiklik geri alınır.
 * Eşzamanlılık: beklenen eski değer (ör. `expectedStatus`) uyuşmazsa
 * `conflict` döner, hiçbir şey değişmez. `updated_at` kullanılmaz: curate işi
 * bağları yeniden yazarken onu da günceller.
 *
 * `trend_product` (ürün bağları) curate işinindir ve burada YAZILMAZ.
 */
import { type Database, trend } from "@arilla/db";
import { eq, sql } from "drizzle-orm";
import { TREND_SHOWABLE_PRODUCT_SQL } from "../trends/get-trends.ts";
import { MIN_PUBLIC_TREND_PRODUCTS } from "../trends/types.ts";
import { type AdminAction, recordAdminEvent } from "./audit.ts";
import { readOnly } from "./bounds.ts";
import { type AdminActor, assertCapability } from "./capabilities.ts";
import { redactText } from "./redact.ts";

export const TREND_STATUSES = ["draft", "published", "archived"] as const;
export type TrendStatus = (typeof TREND_STATUSES)[number];

export function isTrendStatus(value: unknown): value is TrendStatus {
  return typeof value === "string" && (TREND_STATUSES as readonly string[]).includes(value);
}

export const TREND_REASON_MIN = 5;
export const TREND_REASON_MAX = 500;

/** İzinli durum geçişleri ve denetim eylemi. Arşivden doğrudan yayına geçilmez. */
const TRANSITIONS: Readonly<Record<TrendStatus, Partial<Record<TrendStatus, AdminAction>>>> = {
  draft: { published: "trends.publish", archived: "trends.archive" },
  published: { draft: "trends.unpublish", archived: "trends.archive" },
  archived: { draft: "trends.restore" },
};

export function allowedTrendTransitions(from: TrendStatus): TrendStatus[] {
  return Object.keys(TRANSITIONS[from]) as TrendStatus[];
}

export type TrendWindowState = "none" | "upcoming" | "open" | "ended";

export function trendWindowState(
  activeFrom: Date | null,
  activeUntil: Date | null,
  now: Date,
): TrendWindowState {
  if (!activeFrom && !activeUntil) return "none";
  if (activeFrom && now < activeFrom) return "upcoming";
  if (activeUntil && now >= activeUntil) return "ended";
  return "open";
}

export interface AdminTrendRow {
  id: number;
  slug: string;
  title: string;
  category: string;
  trendType: string;
  status: TrendStatus;
  featured: boolean;
  sortOrder: number;
  activeFrom: Date | null;
  activeUntil: Date | null;
  windowState: TrendWindowState;
  linkedProducts: number;
  showableProducts: number;
  /** Public `/trendler`'de görünür mü (yayında + eşik). */
  visible: boolean;
}

export interface AdminTrendList {
  rows: AdminTrendRow[];
  minProducts: number;
  counts: { status: TrendStatus; count: number }[];
}

type Num = string | number | null;

/** Trend sayısı küçüktür (tohum 50); yine de üst sınır ve zaman aşımı var. */
const TREND_LIST_LIMIT = 500;

export async function listTrendsForAdmin(
  db: Database,
  actor: AdminActor,
  filter: { status?: TrendStatus } = {},
  now: Date = new Date(),
): Promise<AdminTrendList> {
  assertCapability(actor, "trends.manage");
  return readOnly(db, 5_000, async (tx) => {
    const where = filter.status ? sql`WHERE t.status = ${filter.status}` : sql``;
    const rows = await tx.execute<{
      id: Num;
      slug: string;
      title: string;
      category: string;
      trend_type: string;
      status: TrendStatus;
      featured: boolean;
      sort_order: Num;
      active_from: Date | string | null;
      active_until: Date | string | null;
      linked: Num;
      showable: Num;
    }>(sql`
      SELECT t.id, t.slug, t.title, t.category, t.trend_type, t.status, t.featured, t.sort_order,
             t.active_from, t.active_until,
             count(tp.product_id) AS linked,
             count(p.id) AS showable
        FROM trend t
        LEFT JOIN trend_product tp ON tp.trend_id = t.id
        LEFT JOIN product p ON p.id = tp.product_id AND ${TREND_SHOWABLE_PRODUCT_SQL}
        ${where}
       GROUP BY t.id
       ORDER BY t.sort_order, t.id
       LIMIT ${TREND_LIST_LIMIT}
    `);
    const counts = await tx.execute<{ status: TrendStatus; count: Num }>(sql`
      SELECT status, count(*) AS count FROM trend GROUP BY 1 ORDER BY 1
    `);
    return {
      minProducts: MIN_PUBLIC_TREND_PRODUCTS,
      counts: counts.rows.map((row) => ({ status: row.status, count: Number(row.count) })),
      rows: rows.rows.map((row) => {
        const activeFrom = row.active_from ? new Date(row.active_from) : null;
        const activeUntil = row.active_until ? new Date(row.active_until) : null;
        const showable = Number(row.showable ?? 0);
        return {
          id: Number(row.id),
          slug: row.slug,
          title: row.title,
          category: row.category,
          trendType: row.trend_type,
          status: row.status,
          featured: row.featured,
          sortOrder: Number(row.sort_order ?? 0),
          activeFrom,
          activeUntil,
          windowState: trendWindowState(activeFrom, activeUntil, now),
          linkedProducts: Number(row.linked ?? 0),
          showableProducts: showable,
          visible: row.status === "published" && showable >= MIN_PUBLIC_TREND_PRODUCTS,
        };
      }),
    };
  });
}

export class TrendValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrendValidationError";
  }
}

export type TrendMutationResult =
  | { status: "updated" }
  | { status: "unchanged" }
  | { status: "not_found" }
  | { status: "conflict" };

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

async function lockTrend(tx: Parameters<Parameters<Database["transaction"]>[0]>[0], id: number) {
  const rows = await tx
    .select({
      id: trend.id,
      slug: trend.slug,
      status: trend.status,
      featured: trend.featured,
      sortOrder: trend.sortOrder,
    })
    .from(trend)
    .where(eq(trend.id, id))
    .for("update");
  return rows[0];
}

/** Durum geçişi. Yayın eşik altındaysa da yapılabilir; public kural yine gizler (ekranda uyarılır). */
export async function setTrendStatus(
  db: Database,
  actor: AdminActor,
  input: { trendId: unknown; next: unknown; expectedStatus: unknown; reason: unknown },
): Promise<TrendMutationResult> {
  assertCapability(actor, "trends.manage");
  const id = requireId(input.trendId);
  if (!isTrendStatus(input.next) || !isTrendStatus(input.expectedStatus)) {
    throw new TrendValidationError("Geçersiz durum.");
  }
  const action = TRANSITIONS[input.expectedStatus][input.next];
  if (!action) throw new TrendValidationError("Bu durum geçişine izin verilmiyor.");
  const reason = requireReason(input.reason);
  const next = input.next;

  return db.transaction(async (tx) => {
    const current = await lockTrend(tx, id);
    if (!current) return { status: "not_found" };
    if (current.status !== input.expectedStatus) return { status: "conflict" };
    await tx.update(trend).set({ status: next, updatedAt: new Date() }).where(eq(trend.id, id));
    await recordAdminEvent(tx, {
      actor,
      action,
      targetType: "trend",
      targetId: id,
      before: { status: current.status, slug: current.slug },
      after: { status: next },
      reason,
    });
    return { status: "updated" };
  });
}

export async function setTrendFeatured(
  db: Database,
  actor: AdminActor,
  input: { trendId: unknown; featured: unknown; reason: unknown },
): Promise<TrendMutationResult> {
  assertCapability(actor, "trends.manage");
  const id = requireId(input.trendId);
  if (typeof input.featured !== "boolean") throw new TrendValidationError("Geçersiz değer.");
  const reason = requireReason(input.reason);
  const featured = input.featured;

  return db.transaction(async (tx) => {
    const current = await lockTrend(tx, id);
    if (!current) return { status: "not_found" };
    if (current.featured === featured) return { status: "unchanged" };
    await tx.update(trend).set({ featured, updatedAt: new Date() }).where(eq(trend.id, id));
    await recordAdminEvent(tx, {
      actor,
      action: featured ? "trends.feature" : "trends.unfeature",
      targetType: "trend",
      targetId: id,
      before: { featured: current.featured, slug: current.slug },
      after: { featured },
      reason,
    });
    return { status: "updated" };
  });
}

/**
 * Sırada bir yukarı/aşağı: komşuyla `sort_order` değiş tokuşu. Önce taşınan,
 * sonra komşu satır kilitlenir; iki yöneticinin aynı anda ters yönde taşıması
 * kilitlenmeye girerse Postgres birini iptal eder (yarım yazım olmaz, işlem
 * tekrar denenir). Eşit sıra değerinde ayrışma için komşuya ±1 verilir. Tek
 * işlem, tek denetim satırı.
 */
export async function moveTrend(
  db: Database,
  actor: AdminActor,
  input: { trendId: unknown; direction: unknown; reason: unknown },
): Promise<TrendMutationResult> {
  assertCapability(actor, "trends.manage");
  const id = requireId(input.trendId);
  if (input.direction !== "up" && input.direction !== "down") {
    throw new TrendValidationError("Geçersiz yön.");
  }
  const reason = requireReason(input.reason);
  const up = input.direction === "up";

  return db.transaction(async (tx) => {
    const current = await lockTrend(tx, id);
    if (!current) return { status: "not_found" };
    // Komşu: aynı sıralama (sort_order, id) ile hemen önceki/sonraki trend.
    const neighborRows = await tx.execute<{ id: Num; sort_order: Num }>(sql`
      SELECT id, sort_order FROM trend
       WHERE ${
         up
           ? sql`(sort_order, id) < (${current.sortOrder}, ${id})`
           : sql`(sort_order, id) > (${current.sortOrder}, ${id})`
}
       ORDER BY ${up ? sql`sort_order DESC, id DESC` : sql`sort_order ASC, id ASC`}
       LIMIT 1
       FOR UPDATE
    `);
    const neighbor = neighborRows.rows[0];
    if (!neighbor) return { status: "unchanged" };
    const neighborId = Number(neighbor.id);
    const neighborOrder = Number(neighbor.sort_order);
    const mine = neighborOrder;
    // Eşit sıra değeri: kimlik sırası belirliyordu; değiş tokuş etkisiz kalmasın.
    const theirs =
      current.sortOrder === neighborOrder ? (up ? mine + 1 : mine - 1) : current.sortOrder;
    await tx.update(trend).set({ sortOrder: mine, updatedAt: new Date() }).where(eq(trend.id, id));
    await tx
      .update(trend)
      .set({ sortOrder: theirs, updatedAt: new Date() })
      .where(eq(trend.id, neighborId));
    await recordAdminEvent(tx, {
      actor,
      action: "trends.reorder",
      targetType: "trend",
      targetId: id,
      before: { sortOrder: current.sortOrder, neighborId, neighborSortOrder: neighborOrder },
      after: { sortOrder: mine, neighborSortOrder: theirs, direction: up ? "up" : "down" },
      reason,
    });
    return { status: "updated" };
  });
}
