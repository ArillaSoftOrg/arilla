/**
 * Zamanlanmis Hepsiburada yenilemesi (karar 0220; 0117 "otomasyon" eki).
 *
 * Toplama YINE yalnizca yoneticinin kendi tarayicisinda calisir: toplayici sayfasi acik ve
 * oturum gecerliyken tarayicidaki zamanlayici sunucuya "simdi kosu acilabilir mi?" diye sorar.
 * Sunucu (burasi) bildirilen izni KOD DUZEYINDE ayrica uygular — `collection_source`
 * politikasi daha gevsek olsa bile (0124 `declared_extended`):
 *
 * - son sayilan kosudan (`released` disinda HER kosu: elle, ilk yukleme dahil) en az 7 gun;
 * - takvim ayinda (UTC) en fazla 4 kosu;
 * - acik kosu yok, kaynak acik, hacim kotasi var (`getCollectionStatus`);
 * - ortam bayragi (`CATALOG_AUTO_COLLECT_ENABLED=true`) acik — varsayilan KAPALI.
 *
 * Zamanlanmis kosu yeni parametre ALMAZ: son kapanmis arama kosusunun sorgu listesi ve sayfa
 * tavani yeniden kullanilir (istemci sorgu ya da butce secemez). Sunucuya istek yoktur; kosu
 * acildiktan sonra tarayici mevcut toplayici akisiyla (2 sn+ bekleme, butce, engelde durma,
 * otomatik yeniden deneme YOK) calisir.
 */
import { collectionRun, type Database } from "@arilla/db";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { recordAdminEvent } from "../admin/audit.ts";
import { type AdminActor, assertCapability } from "../admin/capabilities.ts";
import type { AdminFinding } from "../admin/severity.ts";
import {
  type CatalogCollectionStatus,
  CollectionError,
  getCollectionStatus,
  type RunView,
  startCollectionRun,
} from "./service.ts";

/** Bildirilen izin (0117): haftada en fazla 1, takvim ayinda en fazla 4 yenileme. */
export const AUTO_MIN_INTERVAL_DAYS = 7;
export const AUTO_MAX_RUNS_PER_MONTH = 4;
/** Hepsiburada teklif fiyatinin tazelik siniri (karar 0220): haftalik yenileme + 1 gun pay. */
export const HEPSIBURADA_MAX_PRICE_AGE_DAYS = 8;
/** Zamanlanmis kosuda sorgu listesi ust siniri (elle kosuyla ayni). */
const MAX_SCHEDULED_QUERIES = 5000;
const DAY_MS = 86_400_000;

export function autoCollectFlagEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.CATALOG_AUTO_COLLECT_ENABLED?.trim().toLowerCase() === "true";
}

export type ScheduleBlock =
  | "flag_off"
  | "no_template"
  | "interval"
  | "month"
  | "open_run"
  | "quota";

export interface ScheduleTemplate {
  runId: number;
  queries: string[];
  maxPages: number;
}

export interface ScheduleInput {
  flagEnabled: boolean;
  /** `getCollectionStatus` sonucu (kaynak acik mi, acik kosu, hacim kotasi). */
  status: Pick<CatalogCollectionStatus, "quota" | "openRun">;
  /** Sayilan (released disi) en son kosunun rezervasyon ani. */
  lastCountedAt: Date | null;
  /** Bu UTC ayinda sayilan kosu sayisi. */
  runsThisMonth: number;
  template: ScheduleTemplate | null;
  now: Date;
}

export interface ScheduleVerdict {
  due: boolean;
  blockedBy: ScheduleBlock | null;
  /** Bildirilen izne gore bir sonraki kosunun en erken ani (bilinmiyorsa null). */
  nextAllowedAt: Date | null;
  template: ScheduleTemplate | null;
}

function nextMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** Saf karar: zamanlanmis kosu simdi acilabilir mi. Sira: en kati neden once. */
export function scheduleVerdict(input: ScheduleInput): ScheduleVerdict {
  const { now } = input;
  const byInterval = input.lastCountedAt
    ? new Date(input.lastCountedAt.getTime() + AUTO_MIN_INTERVAL_DAYS * DAY_MS)
    : null;
  const monthFull = input.runsThisMonth >= AUTO_MAX_RUNS_PER_MONTH;
  let nextAllowedAt: Date | null = byInterval && byInterval > now ? byInterval : now;
  if (monthFull) {
    const m = nextMonthStart(now);
    nextAllowedAt = nextAllowedAt && nextAllowedAt > m ? nextAllowedAt : m;
  }
  const q = input.status.quota;
  const blockedBy: ScheduleBlock | null = !input.flagEnabled
    ? "flag_off"
    : input.status.openRun
      ? "open_run"
      : byInterval && now < byInterval
        ? "interval"
        : monthFull
          ? "month"
          : !q.canStart
            ? "quota"
            : !input.template
              ? "no_template"
              : null;
  return { due: blockedBy === null, blockedBy, nextAllowedAt, template: input.template };
}

/** Son kapanmis ARAMA kosusundan (kesif degil) sorgu listesi ve sayfa tavani. */
export function templateFromRun(
  run: Pick<RunView, "id" | "status" | "checkpoint"> & { options?: Record<string, unknown> },
): ScheduleTemplate | null {
  if (run.status === "open" || run.status === "released") return null;
  const cp = run.checkpoint;
  if (!cp || cp.mode === "discovery" || !Array.isArray(cp.queries)) return null;
  const queries = [
    ...new Set(
      (cp.queries as unknown[])
        .filter((q): q is string => typeof q === "string")
        .map((q) => q.trim())
        .filter((q) => q.length > 0 && q.length <= 200),
    ),
  ].slice(0, MAX_SCHEDULED_QUERIES);
  if (queries.length === 0) return null;
  const raw = Number(run.options?.maxPages);
  const maxPages = Number.isSafeInteger(raw) ? Math.min(Math.max(raw, 1), 50) : 1;
  return { runId: run.id, queries, maxPages };
}

async function readScheduleFacts(
  db: Database,
  source: string,
  now: Date,
): Promise<Pick<ScheduleInput, "lastCountedAt" | "runsThisMonth" | "template">> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [agg] = await db
    .select({
      last: sql<string | null>`max(${collectionRun.reservedAt})`,
      month: sql<number>`count(*) FILTER (WHERE ${collectionRun.reservedAt} >= ${monthStart.toISOString()}::timestamptz)`,
    })
    .from(collectionRun)
    .where(and(eq(collectionRun.source, source), ne(collectionRun.status, "released")));
  const candidates = await db
    .select()
    .from(collectionRun)
    .where(
      and(
        eq(collectionRun.source, source),
        ne(collectionRun.status, "released"),
        ne(collectionRun.status, "open"),
      ),
    )
    .orderBy(desc(collectionRun.reservedAt))
    .limit(12);
  let template: ScheduleTemplate | null = null;
  for (const r of candidates) {
    template = templateFromRun(r);
    if (template) break;
  }
  return {
    lastCountedAt: agg?.last ? new Date(agg.last) : null,
    runsThisMonth: Number(agg?.month ?? 0),
    template,
  };
}

export interface ScheduleState extends ScheduleVerdict {
  flagEnabled: boolean;
  lastCountedAt: Date | null;
  runsThisMonth: number;
}

export async function getCollectionSchedule(
  db: Database,
  actor: AdminActor,
  source: string,
  options: { flagEnabled: boolean; now?: Date },
): Promise<ScheduleState> {
  assertCapability(actor, "catalog.write");
  const now = options.now ?? new Date();
  const status = await getCollectionStatus(db, actor, source, now);
  const facts = await readScheduleFacts(db, source, now);
  const verdict = scheduleVerdict({ flagEnabled: options.flagEnabled, status, now, ...facts });
  return {
    ...verdict,
    flagEnabled: options.flagEnabled,
    lastCountedAt: facts.lastCountedAt,
    runsThisMonth: facts.runsThisMonth,
  };
}

export interface ScheduledStart {
  run: RunView;
  queries: string[];
  maxPages: number;
}

/**
 * Zamanlanmis kosuyu acar. Karar SUNUCUDA yeniden verilir; istemcinin "zamani geldi" demesi
 * yetmez. Uygun degilse `CollectionError("schedule_not_due", <neden>)`. Kota tetikleyicisi ve
 * tek-acik-kosu indeksi yine son sozu soyler (iki sekme ayni anda acamaz).
 */
export async function startScheduledCollectionRun(
  db: Database,
  actor: AdminActor,
  source: string,
  options: { flagEnabled: boolean; now?: Date },
): Promise<ScheduledStart> {
  const state = await getCollectionSchedule(db, actor, source, options);
  if (!state.due || !state.template) {
    throw new CollectionError("schedule_not_due", state.blockedBy ?? "no_template");
  }
  const { queries, maxPages, runId } = state.template;
  const run = await startCollectionRun(db, actor, {
    source,
    options: { queries: queries.length, maxPages },
  });
  await recordAdminEvent(db, {
    actor,
    action: "catalog_collection.schedule_start",
    targetType: "collection_run",
    targetId: run.id,
    before: null,
    after: { source, templateRunId: runId, queries: queries.length, maxPages },
  });
  return { run, queries, maxPages };
}

// --- yonetim bulgusu ------------------------------------------------------------

export interface CollectionFreshness {
  source: string;
  enabled: boolean;
  /** Son kapanmis (completed/aborted) kosunun kapanis ani. */
  lastClosedAt: Date | null;
  lastStatus: string | null;
  /** Kapanis ozetindeki neden (or. `expired`) ya da null. */
  lastReason: string | null;
  /** Aktif tekliflerde en yeni `last_seen_at`. */
  newestOfferSeenAt: Date | null;
  activeOffers: number;
}

/** Salt okunur: bulgu icin toplama/teklif tazeligi. */
export async function readCollectionFreshness(
  db: Database,
  source = "hepsiburada",
): Promise<CollectionFreshness> {
  const result = await db.execute<{
    enabled: boolean | null;
    closed_at: string | null;
    status: string | null;
    reason: string | null;
    newest: string | null;
    active: string | number | null;
  }>(sql`
    SELECT (SELECT enabled FROM collection_source WHERE source = ${source}) AS enabled,
           r.closed_at, r.status, r.summary ->> 'reason' AS reason,
           (SELECT max(o.last_seen_at) FROM offer o JOIN merchant m ON m.id = o.merchant_id
             WHERE m.slug = ${source} AND o.is_active) AS newest,
           (SELECT count(*) FROM offer o JOIN merchant m ON m.id = o.merchant_id
             WHERE m.slug = ${source} AND o.is_active) AS active
      FROM (SELECT 1) one
      LEFT JOIN LATERAL (
           SELECT closed_at, status, summary FROM collection_run
            WHERE source = ${source} AND status IN ('completed', 'aborted')
            ORDER BY reserved_at DESC LIMIT 1) r ON true
  `);
  const row = result.rows[0];
  return {
    source,
    enabled: row?.enabled === true,
    lastClosedAt: row?.closed_at ? new Date(row.closed_at) : null,
    lastStatus: row?.status ?? null,
    lastReason: row?.reason ?? null,
    newestOfferSeenAt: row?.newest ? new Date(row.newest) : null,
    activeOffers: Number(row?.active ?? 0),
  };
}

/**
 * Saf: Hepsiburada tazelik bulgusu. Aktif teklif yoksa (kaynak hic kullanilmadi) bulgu yok.
 * Teklifler tazelik sinirini astiysa `warning` (fiyatlar yenilenmiyor; veri kaybi yok); son
 * kosu yarida kaldiysa ayrica belirtilir.
 */
export function collectionFreshnessFindings(f: CollectionFreshness, now: Date): AdminFinding[] {
  if (f.activeOffers === 0) return [];
  const ageDays = f.newestOfferSeenAt
    ? Math.floor((now.getTime() - f.newestOfferSeenAt.getTime()) / DAY_MS)
    : null;
  const stale = ageDays === null || ageDays > HEPSIBURADA_MAX_PRICE_AGE_DAYS;
  const aborted = f.lastStatus === "aborted";
  const evidence = `Aktif teklif ${f.activeOffers.toLocaleString("tr-TR")}; en yeni görülme ${
    ageDays === null ? "yok" : `${ageDays} gün önce`
  }; son koşu ${f.lastStatus ?? "yok"}${f.lastReason ? ` (${f.lastReason})` : ""}.`;
  const base = {
    href: "/yonetim/katalog/toplama",
    capability: "catalog.write" as const,
    evidence,
    evidenceAt: now,
  };
  if (!stale) {
    return [
      {
        ...base,
        key: "collection.hepsiburada.freshness",
        severity: aborted ? "info" : "healthy",
        title: aborted
          ? "Hepsiburada: son toplama koşusu yarıda kaldı"
          : "Hepsiburada teklifleri tazelik sınırı içinde",
        meaning: `Teklifler ${HEPSIBURADA_MAX_PRICE_AGE_DAYS} gün içinde görüldü (haftalık yenileme izni, karar 0220).`,
        action: aborted
          ? "Toplama sayfasındaki koşu günlüğüne bakın; engel görüldüyse yeniden denemeyin."
          : "Eylem gerekmez.",
      },
    ];
  }
  return [
    {
      ...base,
      key: "collection.hepsiburada.freshness",
      severity: "warning",
      title: "Hepsiburada fiyatları yenilenmiyor",
      meaning: `Aktif tekliflerin hiçbiri son ${HEPSIBURADA_MAX_PRICE_AGE_DAYS} günde görülmedi; yeni ürün kapıda bayat sayılır (karar 0220).`,
      action: f.enabled
        ? "Yönetici tarayıcısında /yonetim/katalog/toplama sayfasını açın (zamanlayıcı açıksa koşu kendiliğinden başlar), ardından feeds hb-merge çalıştırın."
        : "Kaynak kapalı (collection_source.enabled = false); açılış ayrı onay ister.",
    },
  ];
}
