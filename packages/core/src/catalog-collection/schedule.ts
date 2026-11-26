/**
 * Zamanlanmis yonetici tarayicisi toplamasi: Hepsiburada VE Trendyol icin TEK zamanlayici
 * (karar 0220 + 0221; 0117/0118 "otomasyon" ekleri).
 *
 * Toplama YINE yalnizca yoneticinin kendi tarayicisinda calisir: toplama sayfasi acik ve oturum
 * gecerliyken sayfadaki zamanlayici sunucuya "simdi kosu acilabilir mi?" diye sorar. Sunucu
 * kaynaga istek ATMAZ.
 *
 * Kota KAYNAK POLITIKASINDAN gelir (`collection_source`, sahip rol yonetir; koda gomulu sayi
 * YOK): `min_interval_days`, `max_runs_per_month`, `max_runs_per_week` (0119), hacim kotasi,
 * acik kosu. Karari `getCollectionStatus` verir; veritabani tetikleyicisi son sozu soyler.
 * Kullanici beyani (26 Kasim 2026, belge incelenmedi): HB ve Trendyol haftada en fazla 100,
 * ayda en fazla 400 kosu.
 *
 * Zamanlanmis kosu yeni parametre ALMAZ: son kapanmis kosu sablondur (istemci hedef ya da butce
 * secemez). Hepsiburada: sorgu listesi + sayfa tavani. Trendyol: o kosuda okunan urun ve liste
 * sayfalarinin adresleri (eklenti sirayla, yoneticinin tarayicisinda acar).
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
import { isCollectibleTrendyolUrl } from "./trendyol-relay.ts";

/**
 * Kaynak teklif fiyatinin tazelik siniri (gun). `services/ingest` kayit defterindeki
 * `max_price_age` ile AYNI tutulur (karar 0220/0221): haftalik ya da daha sik yenileme + pay.
 */
export const MAX_PRICE_AGE_DAYS: Readonly<Record<string, number>> = {
  hepsiburada: 8,
  trendyol: 8,
};
/** Geriye uyum (karar 0220 adi). */
export const HEPSIBURADA_MAX_PRICE_AGE_DAYS = MAX_PRICE_AGE_DAYS.hepsiburada as number;
/** Zamanlanmis kosuda sorgu listesi ust siniri (elle kosuyla ayni). */
const MAX_SCHEDULED_QUERIES = 5000;
/** Trendyol zamanlanmis kosu basina adres ust siniri (kosu istek butcesiyle ayni, 0118). */
export const MAX_SCHEDULED_URLS = 500;
const TRENDYOL_ORIGIN = "https://www.trendyol.com";
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
  | "week"
  | "month"
  | "open_run"
  | "quota";

export interface ScheduleTemplate {
  runId: number;
  /** Hepsiburada: arama sorgulari. Trendyol: bos. */
  queries: string[];
  maxPages: number;
  /** Trendyol: acilacak urun/liste adresleri. Hepsiburada: bos. */
  urls: string[];
}

export interface ScheduleInput {
  flagEnabled: boolean;
  /** `getCollectionStatus` sonucu: politika kotasi (aralik/hafta/ay/hacim), acik kosu. */
  status: Pick<CatalogCollectionStatus, "quota" | "openRun">;
  template: ScheduleTemplate | null;
  now: Date;
}

export interface ScheduleVerdict {
  due: boolean;
  blockedBy: ScheduleBlock | null;
  /** Politikaya gore bir sonraki kosunun en erken ani (bilinmiyorsa null). */
  nextAllowedAt: Date | null;
  template: ScheduleTemplate | null;
}

function nextMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** Saf karar: zamanlanmis kosu simdi acilabilir mi. Kota politikadan; kod gevsetmez/sikilastirmaz. */
export function scheduleVerdict(input: ScheduleInput): ScheduleVerdict {
  const { now } = input;
  const q = input.status.quota;
  const quotaBlock: ScheduleBlock | null = q.canStart
    ? null
    : q.blockedBy === "interval" || q.blockedBy === "week" || q.blockedBy === "month"
      ? q.blockedBy
      : q.blockedBy === "open_run"
        ? "open_run"
        : "quota";
  const blockedBy: ScheduleBlock | null = !input.flagEnabled
    ? "flag_off"
    : input.status.openRun
      ? "open_run"
      : quotaBlock
        ? quotaBlock
        : !input.template
          ? "no_template"
          : null;
  let nextAllowedAt: Date | null = q.nextAllowedAt && q.nextAllowedAt > now ? q.nextAllowedAt : now;
  if (q.blockedBy === "month") nextAllowedAt = nextMonthStart(now);
  return { due: blockedBy === null, blockedBy, nextAllowedAt, template: input.template };
}

/** Hepsiburada: son kapanmis ARAMA kosusundan (kesif degil) sorgu listesi ve sayfa tavani. */
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
  return { runId: run.id, queries, maxPages, urls: [] };
}

export interface TrendyolUnitRow {
  kind: string;
  unitKey: string;
  /** Urun sayfasi biriminde ayni kosuda kabul edilen kaydin kanonik adresi. */
  url: string | null;
}

/**
 * Trendyol: bir kosuda basariyla okunan sayfalardan adres listesi. Urun sayfasi -> o kosuda
 * kaydedilen kanonik urun adresi; liste sayfasi -> koken + yol (arama `/sr` sorgusu
 * saklanmadigi icin yeniden kurulamaz, atlanir). Yalniz toplanabilir adresler; tekrar yok.
 */
export function trendyolTemplateFromUnits(
  runId: number,
  units: readonly TrendyolUnitRow[],
): ScheduleTemplate | null {
  const urls: string[] = [];
  for (const u of units) {
    let url: string | null = null;
    if (u.kind === "product_page") url = u.url;
    else if (u.kind === "listing_page" && u.unitKey.startsWith("/") && u.unitKey !== "/sr") {
      url = `${TRENDYOL_ORIGIN}${u.unitKey}`;
    }
    if (!url || !isCollectibleTrendyolUrl(url) || urls.includes(url)) continue;
    urls.push(url);
    if (urls.length >= MAX_SCHEDULED_URLS) break;
  }
  return urls.length > 0 ? { runId, queries: [], maxPages: 1, urls } : null;
}

async function trendyolUnits(db: Database, runId: number): Promise<TrendyolUnitRow[]> {
  const result = await db.execute<{ kind: string; unit_key: string; url: string | null }>(sql`
    SELECT u.kind, u.unit_key,
           (SELECT i.url FROM catalog_intake_record i
             WHERE i.run_id = u.run_id AND i.external_id = u.unit_key LIMIT 1) AS url
      FROM collection_unit u
     WHERE u.run_id = ${runId} AND u.status IN ('done', 'empty')
     ORDER BY u.fetched_at, u.recorded_at, u.unit_key
     LIMIT ${MAX_SCHEDULED_URLS * 2}
  `);
  return result.rows.map((r) => ({ kind: r.kind, unitKey: r.unit_key, url: r.url }));
}

async function readTemplate(db: Database, source: string): Promise<ScheduleTemplate | null> {
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
  for (const r of candidates) {
    const template =
      source === "trendyol"
        ? trendyolTemplateFromUnits(r.id, await trendyolUnits(db, r.id))
        : templateFromRun(r);
    if (template) return template;
  }
  return null;
}

export interface ScheduleState extends ScheduleVerdict {
  flagEnabled: boolean;
  runsThisWeek: number;
  maxRunsPerWeek: number | null;
  runsThisMonth: number;
  maxRunsPerMonth: number | null;
  minIntervalDays: number;
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
  const template = await readTemplate(db, source);
  const verdict = scheduleVerdict({ flagEnabled: options.flagEnabled, status, now, template });
  const q = status.quota;
  return {
    ...verdict,
    flagEnabled: options.flagEnabled,
    runsThisWeek: q.runsThisWeek,
    maxRunsPerWeek: q.maxRunsPerWeek,
    runsThisMonth: q.runsThisMonth,
    maxRunsPerMonth: q.maxRunsPerMonth,
    minIntervalDays: q.minIntervalDays,
  };
}

export interface ScheduledStart {
  run: RunView;
  queries: string[];
  maxPages: number;
  urls: string[];
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
  const { queries, maxPages, urls, runId } = state.template;
  const run = await startCollectionRun(db, actor, {
    source,
    options: { queries: queries.length || urls.length, maxPages },
  });
  await recordAdminEvent(db, {
    actor,
    action: "catalog_collection.schedule_start",
    targetType: "collection_run",
    targetId: run.id,
    before: null,
    after: { source, templateRunId: runId, queries: queries.length, maxPages, urls: urls.length },
  });
  return { run, queries, maxPages, urls: urls.slice(0, run.maxRequests) };
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

/** Zamanlayicili kaynaklar (bulgu ve tazelik). */
export const SCHEDULED_SOURCES = ["hepsiburada", "trendyol"] as const;

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

const SOURCE_LABEL: Record<string, string> = { hepsiburada: "Hepsiburada", trendyol: "Trendyol" };
const SOURCE_PAGE: Record<string, string> = {
  hepsiburada: "/yonetim/katalog/toplama",
  trendyol: "/yonetim/katalog/toplama/trendyol",
};
const MERGE_HINT: Record<string, string> = {
  hepsiburada: "feeds hb-merge",
  trendyol: "feeds collect-merge --run <N>",
};

/**
 * Saf: kaynak tazelik bulgusu. Aktif teklif yoksa (kaynak hic kullanilmadi) bulgu yok.
 * Teklifler tazelik sinirini astiysa `warning` (fiyatlar yenilenmiyor; veri kaybi yok); son
 * kosu yarida kaldiysa ayrica belirtilir.
 */
export function collectionFreshnessFindings(f: CollectionFreshness, now: Date): AdminFinding[] {
  if (f.activeOffers === 0) return [];
  const label = SOURCE_LABEL[f.source] ?? f.source;
  const page = SOURCE_PAGE[f.source] ?? "/yonetim/katalog/toplama";
  const maxAge = MAX_PRICE_AGE_DAYS[f.source] ?? 8;
  const key = `collection.${f.source}.freshness`;
  const ageDays = f.newestOfferSeenAt
    ? Math.floor((now.getTime() - f.newestOfferSeenAt.getTime()) / DAY_MS)
    : null;
  const stale = ageDays === null || ageDays > maxAge;
  const aborted = f.lastStatus === "aborted";
  const evidence = `Aktif teklif ${f.activeOffers.toLocaleString("tr-TR")}; en yeni görülme ${
    ageDays === null ? "yok" : `${ageDays} gün önce`
  }; son koşu ${f.lastStatus ?? "yok"}${f.lastReason ? ` (${f.lastReason})` : ""}.`;
  const base = { href: page, capability: "catalog.write" as const, evidence, evidenceAt: now };
  if (!stale) {
    return [
      {
        ...base,
        key,
        severity: aborted ? "info" : "healthy",
        title: aborted
          ? `${label}: son toplama koşusu yarıda kaldı`
          : `${label} teklifleri tazelik sınırı içinde`,
        meaning: `Teklifler ${maxAge} gün içinde görüldü (karar 0220/0221).`,
        action: aborted
          ? "Toplama sayfasındaki koşu günlüğüne bakın; engel görüldüyse yeniden denemeyin."
          : "Eylem gerekmez.",
      },
    ];
  }
  return [
    {
      ...base,
      key,
      severity: "warning",
      title: `${label} fiyatları yenilenmiyor`,
      meaning: `Aktif tekliflerin hiçbiri son ${maxAge} günde görülmedi; yeni ürün kapıda bayat sayılır (karar 0220/0221).`,
      action: f.enabled
        ? `Yönetici tarayıcısında ${page} sayfasını açın (zamanlayıcı açıksa koşu kendiliğinden başlar), ardından ${MERGE_HINT[f.source] ?? "birleştirmeyi"} çalıştırın.`
        : "Kaynak kapalı (collection_source.enabled = false); açılış ayrı onay ister.",
    },
  ];
}
