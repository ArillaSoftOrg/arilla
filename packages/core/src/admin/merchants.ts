/**
 * `/yonetim/magazalar` (docs/decisions/0039, Faz 2). Mağaza listesi, ayrıntı
 * ve tek mutasyon: `merchant.is_active` aç/kapat.
 *
 * Gösterilmeyenler: `feed_url`'in sorgu dizisi (API anahtarı taşıyabilir),
 * `deeplink_template` (affiliate kimliği), `feed_config`'in iç içe nesneleri
 * (`mapping`, `transport`, `currency_evidence`). `feed_config` yalnızca izin
 * listesindeki düz alanlarla ve anahtar adlarıyla gösterilir.
 *
 * Düzenlenemeyenler: feed adresi, `feed_config`, komisyon, deeplink, para
 * birimi kanıtı. Bunlar kaynak (bootstrap JSON) ve CLI'da kalır.
 */
import { type Database, merchant } from "@arilla/db";
import { eq, sql } from "drizzle-orm";
import { recordAdminEvent } from "./audit.ts";
import { clampPage, containsPattern, readOnly } from "./bounds.ts";
import { type AdminActor, assertCapability } from "./capabilities.ts";
import { redactText, safeUrl } from "./redact.ts";

export const MERCHANT_SOURCE_TYPES = [
  "xml_feed",
  "api",
  "affiliate_network",
  "user_discovered",
  "shopify",
] as const;
export type MerchantSourceType = (typeof MERCHANT_SOURCE_TYPES)[number];

export function isMerchantSourceType(value: unknown): value is MerchantSourceType {
  return typeof value === "string" && (MERCHANT_SOURCE_TYPES as readonly string[]).includes(value);
}

export type IngestStatus = "running" | "success" | "partial" | "failed";

export interface FeedConfigView {
  currency: string | null;
  /** `collect/gate.py`: yalnızca JSON `true` geçer. */
  currencyVerified: boolean;
  categoryHint: string | null;
  bootstrapSource: string | null;
  /** Tüm üst düzey anahtar adları (değerler değil). */
  keys: string[];
}

function shortString(value: unknown, max = 120): string | null {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;
}

/** İzin listesi: bilinmeyen ya da iç içe alan hiçbir zaman değeriyle dönmez. */
export function feedConfigView(raw: unknown): FeedConfigView {
  const config =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    currency: shortString(config.currency, 8),
    currencyVerified: config.currency_verified === true,
    categoryHint: shortString(config.category_hint),
    bootstrapSource: shortString(config.bootstrap_source, 60),
    keys: Object.keys(config).sort().slice(0, 50),
  };
}

export interface MerchantListRow {
  id: number;
  slug: string;
  name: string;
  domain: string;
  sourceType: MerchantSourceType;
  isActive: boolean;
  affiliateStatus: string;
  refreshMinutes: number;
  currency: string | null;
  currencyVerified: boolean;
  offersTotal: number;
  offersActive: number;
  offersUnmatched: number;
  lastRun: { status: IngestStatus; startedAt: Date; finishedAt: Date | null } | null;
  lastSuccessAt: Date | null;
  /** Son başarılı koşudan bu yana `failed`/`partial` biten koşu sayısı. */
  failuresSinceSuccess: number;
}

export interface MerchantFilter {
  active?: boolean;
  sourceType?: MerchantSourceType;
  search?: string;
  page?: number;
}

export const MERCHANT_PAGE_SIZE = 50;

type MerchantSqlRow = {
  id: string;
  slug: string;
  name: string;
  domain: string;
  source_type: MerchantSourceType;
  is_active: boolean;
  affiliate_status: string;
  refresh_minutes: number;
  feed_config: unknown;
  offers_total: string;
  offers_active: string;
  offers_unmatched: string;
  last_status: IngestStatus | null;
  last_started_at: string | null;
  last_finished_at: string | null;
  last_success_at: string | null;
  failures_since_success: string;
};

/** Mağaza başına sayımlar + son koşu. `ingest_run_merchant_idx` ve `offer (merchant_id, …)` indeksleri. */
const MERCHANT_COLUMNS = sql`
  m.id, m.slug, m.name, m.domain, m.source_type, m.is_active, m.affiliate_status,
  m.refresh_minutes, m.feed_config,
  (SELECT count(*) FROM offer o WHERE o.merchant_id = m.id) AS offers_total,
  (SELECT count(*) FROM offer o WHERE o.merchant_id = m.id AND o.is_active) AS offers_active,
  (SELECT count(*) FROM offer o
    WHERE o.merchant_id = m.id AND o.is_active AND o.product_id IS NULL) AS offers_unmatched,
  lr.status AS last_status, lr.started_at AS last_started_at, lr.finished_at AS last_finished_at,
  ls.started_at AS last_success_at,
  (SELECT count(*) FROM ingest_run r
    WHERE r.merchant_id = m.id AND r.status IN ('failed','partial')
      AND r.started_at > coalesce(ls.started_at, '-infinity'::timestamptz)) AS failures_since_success
`;

const MERCHANT_JOINS = sql`
  LEFT JOIN LATERAL (
    SELECT r.status, r.started_at, r.finished_at FROM ingest_run r
     WHERE r.merchant_id = m.id ORDER BY r.started_at DESC LIMIT 1
  ) lr ON true
  LEFT JOIN LATERAL (
    SELECT r.started_at FROM ingest_run r
     WHERE r.merchant_id = m.id AND r.status = 'success' ORDER BY r.started_at DESC LIMIT 1
  ) ls ON true
`;

function toDate(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

function toListRow(row: MerchantSqlRow): MerchantListRow {
  const feed = feedConfigView(row.feed_config);
  return {
    id: Number(row.id),
    slug: row.slug,
    name: row.name,
    domain: row.domain,
    sourceType: row.source_type,
    isActive: row.is_active,
    affiliateStatus: row.affiliate_status,
    refreshMinutes: row.refresh_minutes,
    currency: feed.currency,
    currencyVerified: feed.currencyVerified,
    offersTotal: Number(row.offers_total),
    offersActive: Number(row.offers_active),
    offersUnmatched: Number(row.offers_unmatched),
    lastRun:
      row.last_status && row.last_started_at
        ? {
            status: row.last_status,
            startedAt: new Date(row.last_started_at),
            finishedAt: toDate(row.last_finished_at),
          }
        : null,
    lastSuccessAt: toDate(row.last_success_at),
    failuresSinceSuccess: Number(row.failures_since_success),
  };
}

export async function listMerchants(
  db: Database,
  actor: AdminActor,
  filter: MerchantFilter = {},
): Promise<{ rows: MerchantListRow[]; hasNext: boolean; page: number }> {
  assertCapability(actor, "merchant.read");
  const page = clampPage(filter.page, 100);
  const conditions = [sql`true`];
  if (filter.active !== undefined) conditions.push(sql`m.is_active = ${filter.active}`);
  if (filter.sourceType && isMerchantSourceType(filter.sourceType)) {
    conditions.push(sql`m.source_type = ${filter.sourceType}`);
  }
  const pattern = filter.search ? containsPattern(filter.search) : null;
  if (pattern) {
    conditions.push(
      sql`(m.name ILIKE ${pattern} OR m.slug ILIKE ${pattern} OR m.domain ILIKE ${pattern})`,
    );
  }

  const rows = await readOnly(db, 5_000, async (tx) => {
    const result = await tx.execute<MerchantSqlRow>(sql`
      SELECT ${MERCHANT_COLUMNS}
        FROM merchant m ${MERCHANT_JOINS}
       WHERE ${sql.join(conditions, sql` AND `)}
       ORDER BY m.name, m.id
       LIMIT ${MERCHANT_PAGE_SIZE + 1} OFFSET ${(page - 1) * MERCHANT_PAGE_SIZE}
    `);
    return result.rows;
  });

  return {
    rows: rows.slice(0, MERCHANT_PAGE_SIZE).map(toListRow),
    hasNext: rows.length > MERCHANT_PAGE_SIZE,
    page,
  };
}

export interface MerchantDetail extends MerchantListRow {
  feed: FeedConfigView;
  /** `feed_url` sorgu dizisi ve kimlik bilgisi olmadan. */
  feedUrl: string | null;
  hasDeeplinkTemplate: boolean;
  affiliateNetwork: string | null;
  commissionRateBp: number | null;
  trustScore: number;
  createdAt: Date;
  updatedAt: Date;
}

export async function getMerchantDetail(
  db: Database,
  actor: AdminActor,
  slug: string,
): Promise<MerchantDetail | null> {
  assertCapability(actor, "merchant.read");
  if (typeof slug !== "string" || slug.length === 0 || slug.length > 120) return null;

  const row = await readOnly(db, 5_000, async (tx) => {
    const result = await tx.execute<
      MerchantSqlRow & {
        feed_url: string | null;
        has_deeplink: boolean;
        affiliate_network: string | null;
        commission_rate_bp: number | null;
        trust_score: number;
        created_at: string;
        updated_at: string;
      }
    >(sql`
      SELECT ${MERCHANT_COLUMNS}, m.feed_url, (m.deeplink_template IS NOT NULL) AS has_deeplink,
             m.affiliate_network, m.commission_rate_bp, m.trust_score, m.created_at, m.updated_at
        FROM merchant m ${MERCHANT_JOINS}
       WHERE m.slug = ${slug}
    `);
    return result.rows[0];
  });
  if (!row) return null;

  return {
    ...toListRow(row),
    feed: feedConfigView(row.feed_config),
    feedUrl: safeUrl(row.feed_url),
    hasDeeplinkTemplate: row.has_deeplink,
    affiliateNetwork: row.affiliate_network,
    commissionRateBp: row.commission_rate_bp,
    trustScore: row.trust_score,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export class MerchantValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MerchantValidationError";
  }
}

export const MERCHANT_REASON_MIN = 5;
export const MERCHANT_REASON_MAX = 500;

export interface SetMerchantActiveInput {
  merchantId: number;
  active: boolean;
  reason: string;
  /** Yanlış mağazayı kapatmamak için kullanıcı mağaza kısa adını yazar. */
  confirmSlug: string;
}

export interface SetMerchantActiveResult {
  found: boolean;
  /** false: zaten istenen durumdaydı, hiçbir şey yazılmadı. */
  changed: boolean;
}

/**
 * Mağazayı veri toplamaya aç/kapat. Kapalı mağaza için `collect/gate.py`
 * `refused:merchant_inactive` ile durur; açmak Shopify para birimi kapısını
 * ATLAMAZ (o kapı `feed_config.currency_verified` ister, burada değişmez).
 * Değişiklik ve gerekçe aynı işlemde denetim kaydına yazılır.
 */
export async function setMerchantActive(
  db: Database,
  actor: AdminActor,
  input: SetMerchantActiveInput,
): Promise<SetMerchantActiveResult> {
  assertCapability(actor, "merchant.manage");
  if (!(Number.isSafeInteger(input.merchantId) && input.merchantId > 0)) {
    throw new MerchantValidationError("Geçersiz mağaza.");
  }
  if (typeof input.active !== "boolean") throw new MerchantValidationError("Geçersiz durum.");
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < MERCHANT_REASON_MIN || reason.length > MERCHANT_REASON_MAX) {
    throw new MerchantValidationError(
      `Gerekçe ${MERCHANT_REASON_MIN}–${MERCHANT_REASON_MAX} karakter olmalı.`,
    );
  }

  return db.transaction(async (tx) => {
    const locked = await tx
      .select({ slug: merchant.slug, isActive: merchant.isActive })
      .from(merchant)
      .where(eq(merchant.id, input.merchantId))
      .for("update");
    const current = locked[0];
    if (!current) return { found: false, changed: false };
    if (input.confirmSlug?.trim() !== current.slug) {
      throw new MerchantValidationError("Onay için mağazanın kısa adını aynen yaz.");
    }
    if (current.isActive === input.active) return { found: true, changed: false };

    await tx
      .update(merchant)
      .set({ isActive: input.active, updatedAt: new Date() })
      .where(eq(merchant.id, input.merchantId));
    await recordAdminEvent(tx, {
      actor,
      action: input.active ? "merchant.activate" : "merchant.deactivate",
      targetType: "merchant",
      targetId: input.merchantId,
      before: { isActive: current.isActive, slug: current.slug },
      after: { isActive: input.active },
      reason: redactText(reason, MERCHANT_REASON_MAX),
    });
    return { found: true, changed: true };
  });
}
