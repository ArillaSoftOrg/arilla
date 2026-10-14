/**
 * `/yonetim/takip-baglantilari` (docs/decisions/0115): liste, oluşturma, düzenleme,
 * pasife alma ve istatistik. İnce istemci kuralı: yetki (ikinci kez), doğrulama,
 * satır kilidi ve denetim kaydı burada; web yalnızca çağırır.
 *
 * Her mutasyon `links.manage` ister ve aynı işlemde denetime yazılır. Slug
 * oluşturulduktan sonra değişmez; bağlantı silinmez, pasife alınır.
 * Denetim kaydına hedefin yalnız ana makine adı + yolu yazılır (sorgu yazılmaz).
 */
import { type Database, trackingLink } from "@arilla/db";
import { eq, sql } from "drizzle-orm";
import { recordAdminEvent } from "./../admin/audit.ts";
import { type AdminActor, assertCapability } from "./../admin/capabilities.ts";
import { isUniqueViolation } from "../auth/unique-race.ts";
import {
  auditTarget,
  normalizeLabel,
  normalizeName,
  normalizeSlug,
  normalizeTarget,
  type TargetPolicy,
  TrackingLinkValidationError,
  targetPolicyFromEnv,
} from "./policy.ts";
import { invalidateTrackingLinkCache } from "./redirect.ts";

const STATS_TIME_ZONE = "Europe/Istanbul";
export const MAX_RANGE_DAYS = 366;
export const HOURLY_MAX_DAYS = 3;
const DEFAULT_RANGE_DAYS = 30;

type Num = number | string;

// --- Tarih aralığı ----------------------------------------------------------

export interface StatsRange {
  /** Dahil, Europe/Istanbul takvim günü (YYYY-MM-DD). */
  from: string;
  /** Dahil. */
  to: string;
  days: number;
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseDay(value: unknown): number | null {
  if (typeof value !== "string" || !DAY_PATTERN.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  // 2026-02-30 gibi taşan günler geri çevrilir.
  return new Date(ms).toISOString().slice(0, 10) === value ? ms : null;
}

function formatDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Şu anın Europe/Istanbul takvim günü (YYYY-MM-DD). */
export function istanbulToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: STATS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * Adres satırından gelen aralık güvenilmez girdidir: geçersiz, ters ya da 366
 * günden uzun aralık son 30 güne düşer (hata fırlatmaz, sayfa açılır).
 */
export function resolveStatsRange(
  input: { from?: unknown; to?: unknown },
  now: Date = new Date(),
): StatsRange {
  const today = parseDay(istanbulToday(now)) as number;
  const fromMs = parseDay(input.from);
  const toMs = parseDay(input.to);
  if (fromMs !== null && toMs !== null && fromMs <= toMs) {
    const days = Math.round((toMs - fromMs) / 86_400_000) + 1;
    if (days <= MAX_RANGE_DAYS) return { from: formatDay(fromMs), to: formatDay(toMs), days };
  }
  return {
    from: formatDay(today - (DEFAULT_RANGE_DAYS - 1) * 86_400_000),
    to: formatDay(today),
    days: DEFAULT_RANGE_DAYS,
  };
}

/** [from, to+1 gün) aralığının Istanbul gün sınırları (SQL parçası). */
function rangeBounds(range: StatsRange) {
  return {
    start: sql`((${range.from}::date)::timestamp AT TIME ZONE ${STATS_TIME_ZONE})`,
    end: sql`(((${range.to}::date) + 1)::timestamp AT TIME ZONE ${STATS_TIME_ZONE})`,
  };
}

// --- Okuma ------------------------------------------------------------------

export interface TrackingLinkRow {
  id: number;
  name: string;
  slug: string;
  targetUrl: string;
  source: string | null;
  campaign: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  clicksInRange: number;
  clicksTotal: number;
  lastClickAt: Date | null;
}

export async function listTrackingLinks(
  db: Database,
  actor: AdminActor,
  input: { range: StatsRange },
): Promise<TrackingLinkRow[]> {
  assertCapability(actor, "links.read");
  const { start, end } = rangeBounds(input.range);
  const result = await db.execute<{
    id: Num;
    name: string;
    slug: string;
    target_url: string;
    source: string | null;
    campaign: string | null;
    is_active: boolean;
    created_at: Date | string;
    updated_at: Date | string;
    range_clicks: Num | null;
    total_clicks: Num | null;
    last_hour: Date | string | null;
  }>(sql`
    SELECT l.id, l.name, l.slug, l.target_url, l.source, l.campaign, l.is_active,
           l.created_at, l.updated_at, r.clicks AS range_clicks,
           t.clicks AS total_clicks, t.last_hour
      FROM tracking_link l
      LEFT JOIN (
        SELECT link_id, SUM(clicks) AS clicks
          FROM tracking_link_click_hour
         WHERE hour >= ${start} AND hour < ${end}
         GROUP BY link_id
      ) r ON r.link_id = l.id
      LEFT JOIN (
        SELECT link_id, SUM(clicks) AS clicks, MAX(hour) AS last_hour
          FROM tracking_link_click_hour
         GROUP BY link_id
      ) t ON t.link_id = l.id
     ORDER BY l.is_active DESC, l.created_at DESC, l.id DESC
     LIMIT 500
  `);
  return result.rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    slug: row.slug,
    targetUrl: row.target_url,
    source: row.source,
    campaign: row.campaign,
    isActive: row.is_active,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    clicksInRange: Number(row.range_clicks ?? 0),
    clicksTotal: Number(row.total_clicks ?? 0),
    lastClickAt: row.last_hour ? new Date(row.last_hour) : null,
  }));
}

export async function getTrackingLink(
  db: Database,
  actor: AdminActor,
  id: number,
): Promise<Omit<TrackingLinkRow, "clicksInRange" | "clicksTotal" | "lastClickAt"> | null> {
  assertCapability(actor, "links.read");
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const rows = await db.select().from(trackingLink).where(eq(trackingLink.id, id)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    targetUrl: row.targetUrl,
    source: row.source,
    campaign: row.campaign,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface TrackingLinkStats {
  range: StatsRange;
  total: number;
  /** Boş günler sıfırla doldurulur; `day` Istanbul takvim günüdür. */
  daily: { day: string; clicks: number }[];
  /** Yalnızca aralık `HOURLY_MAX_DAYS` günden kısaysa; `label` Istanbul yerel saati. */
  hourly: { label: string; clicks: number }[] | null;
  peakDay: { day: string; clicks: number } | null;
}

export async function getTrackingLinkStats(
  db: Database,
  actor: AdminActor,
  input: { linkId: number; range: StatsRange },
): Promise<TrackingLinkStats> {
  assertCapability(actor, "links.read");
  const { start, end } = rangeBounds(input.range);
  const tz = STATS_TIME_ZONE;

  const dailyResult = await db.execute<{ day: string; clicks: Num }>(sql`
    SELECT to_char(d.day, 'YYYY-MM-DD') AS day, COALESCE(c.clicks, 0) AS clicks
      FROM generate_series(${input.range.from}::date, ${input.range.to}::date, interval '1 day') AS d(day)
      LEFT JOIN (
        SELECT (hour AT TIME ZONE ${tz})::date AS day, SUM(clicks) AS clicks
          FROM tracking_link_click_hour
         WHERE link_id = ${input.linkId} AND hour >= ${start} AND hour < ${end}
         GROUP BY 1
      ) c ON c.day = d.day::date
     ORDER BY d.day
  `);
  const daily = dailyResult.rows.map((row) => ({ day: row.day, clicks: Number(row.clicks) }));
  const total = daily.reduce((sum, row) => sum + row.clicks, 0);

  let hourly: TrackingLinkStats["hourly"] = null;
  if (input.range.days <= HOURLY_MAX_DAYS) {
    const hourlyResult = await db.execute<{ label: string; clicks: Num }>(sql`
      SELECT to_char(h.hour AT TIME ZONE ${tz}, 'YYYY-MM-DD"T"HH24:MI') AS label,
             COALESCE(c.clicks, 0) AS clicks
        FROM generate_series(${start}, ${end} - interval '1 hour', interval '1 hour') AS h(hour)
        LEFT JOIN tracking_link_click_hour c
               ON c.link_id = ${input.linkId} AND c.hour = h.hour
       ORDER BY h.hour
    `);
    hourly = hourlyResult.rows.map((row) => ({ label: row.label, clicks: Number(row.clicks) }));
  }

  let peakDay: TrackingLinkStats["peakDay"] = null;
  for (const row of daily) {
    if (row.clicks > 0 && (!peakDay || row.clicks > peakDay.clicks)) peakDay = row;
  }
  return { range: input.range, total, daily, hourly, peakDay };
}

// --- Yazma ------------------------------------------------------------------

export type TrackingLinkMutationResult =
  | { status: "created"; id: number }
  | { status: "updated" }
  | { status: "unchanged" }
  | { status: "not_found" }
  | { status: "slug_taken" }
  | { status: "conflict" };

function requireId(value: unknown): number {
  const id = typeof value === "string" ? Number(value) : value;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    throw new TrackingLinkValidationError("Geçersiz bağlantı.");
  }
  return id;
}

interface FieldInput {
  name: unknown;
  targetUrl: unknown;
  source: unknown;
  campaign: unknown;
}

function normalizeFields(input: FieldInput, policy: TargetPolicy) {
  return {
    name: normalizeName(input.name),
    targetUrl: normalizeTarget(input.targetUrl, policy),
    source: normalizeLabel(input.source, "Kaynak"),
    campaign: normalizeLabel(input.campaign, "Kampanya"),
  };
}

export async function createTrackingLink(
  db: Database,
  actor: AdminActor,
  input: FieldInput & { slug: unknown },
  policy: TargetPolicy = targetPolicyFromEnv(),
): Promise<TrackingLinkMutationResult> {
  assertCapability(actor, "links.manage");
  const slug = normalizeSlug(input.slug);
  const fields = normalizeFields(input, policy);

  try {
    return await db.transaction(async (tx) => {
      const rows = await tx
        .insert(trackingLink)
        .values({ ...fields, slug, createdBy: actor.userId })
        .returning({ id: trackingLink.id });
      const id = rows[0]?.id as number;
      await recordAdminEvent(tx, {
        actor,
        action: "links.create",
        targetType: "tracking_link",
        targetId: id,
        after: {
          slug,
          name: fields.name,
          target: auditTarget(fields.targetUrl),
          source: fields.source,
          campaign: fields.campaign,
          isActive: true,
        },
      });
      return { status: "created", id } as const;
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { status: "slug_taken" };
    throw error;
  }
}

async function lockLink(tx: Parameters<Parameters<Database["transaction"]>[0]>[0], id: number) {
  const rows = await tx.select().from(trackingLink).where(eq(trackingLink.id, id)).for("update");
  return rows[0];
}

export async function updateTrackingLink(
  db: Database,
  actor: AdminActor,
  input: FieldInput & { id: unknown; expectedUpdatedAt?: unknown },
  policy: TargetPolicy = targetPolicyFromEnv(),
): Promise<TrackingLinkMutationResult> {
  assertCapability(actor, "links.manage");
  const id = requireId(input.id);
  const fields = normalizeFields(input, policy);

  const result = await db.transaction(
    async (tx): Promise<TrackingLinkMutationResult & { slug?: string }> => {
      const current = await lockLink(tx, id);
      if (!current) return { status: "not_found" };
      if (
        typeof input.expectedUpdatedAt === "string" &&
        current.updatedAt.toISOString() !== input.expectedUpdatedAt
      ) {
        return { status: "conflict" };
      }
      const unchanged =
        current.name === fields.name &&
        current.targetUrl === fields.targetUrl &&
        current.source === fields.source &&
        current.campaign === fields.campaign;
      if (unchanged) return { status: "unchanged" };
      await tx
        .update(trackingLink)
        .set({ ...fields, updatedAt: new Date() })
        .where(eq(trackingLink.id, id));
      await recordAdminEvent(tx, {
        actor,
        action: "links.update",
        targetType: "tracking_link",
        targetId: id,
        before: {
          slug: current.slug,
          name: current.name,
          target: auditTarget(current.targetUrl),
          source: current.source,
          campaign: current.campaign,
        },
        after: {
          name: fields.name,
          target: auditTarget(fields.targetUrl),
          source: fields.source,
          campaign: fields.campaign,
        },
      });
      return { status: "updated", slug: current.slug };
    },
  );
  if (result.status === "updated" && result.slug) await invalidateTrackingLinkCache(result.slug);
  return { status: result.status } as TrackingLinkMutationResult;
}

export async function setTrackingLinkActive(
  db: Database,
  actor: AdminActor,
  input: { id: unknown; active: unknown },
): Promise<TrackingLinkMutationResult> {
  assertCapability(actor, "links.manage");
  const id = requireId(input.id);
  if (typeof input.active !== "boolean") throw new TrackingLinkValidationError("Geçersiz değer.");
  const active = input.active;

  const result = await db.transaction(
    async (tx): Promise<TrackingLinkMutationResult & { slug?: string }> => {
      const current = await lockLink(tx, id);
      if (!current) return { status: "not_found" };
      if (current.isActive === active) return { status: "unchanged" };
      await tx
        .update(trackingLink)
        .set({ isActive: active, updatedAt: new Date() })
        .where(eq(trackingLink.id, id));
      await recordAdminEvent(tx, {
        actor,
        action: active ? "links.activate" : "links.deactivate",
        targetType: "tracking_link",
        targetId: id,
        before: { slug: current.slug, isActive: current.isActive },
        after: { isActive: active },
      });
      return { status: "updated", slug: current.slug };
    },
  );
  if (result.status === "updated" && result.slug) await invalidateTrackingLinkCache(result.slug);
  return { status: result.status } as TrackingLinkMutationResult;
}
