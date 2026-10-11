/**
 * Veri seti üretimi (Faz 2–4). Kaynak: yalnızca rızalı `user_activity_event`
 * (product_viewed, merchant_exit). Çıktı: hafta × boyut hücreleri, kişi başına
 * katkı sınırlı, k-eşikli, kişi sayısı bandı; kimlik yok.
 *
 * Kurallar:
 * - Kapalı politikada kaynak OKUNMAZ; "blocked" kaydı bırakılır.
 * - Kaynağı olmayan veri seti (alternatif tercihi) satır üretmez; "blocked".
 * - Yetersiz veri uydurma satır yerine "insufficient_data".
 * - Aynı kaynak + dönem + sürümde çıktı belirleyicidir (sıralı, kanonik JSON, SHA-256).
 * - Her üretim aynı işlemde denetim kaydı yazar (`data.build`).
 */
import { createHash } from "node:crypto";
import { type Database, type DiDatasetKey, diDatasetBuild } from "@arilla/db";
import { sql } from "drizzle-orm";
import { recordAdminEvent } from "../admin/audit.ts";
import { readOnly } from "../admin/bounds.ts";
import { type AdminActor, assertCapability } from "../admin/capabilities.ts";
import { readAccuracy } from "./accuracy.ts";
import { DataIntelligenceInputError } from "./builder-errors.ts";
import { DATASET_SPECS, type DatasetSpec, isDatasetKey } from "./datasets.ts";
import {
  CONTRIBUTION_CAP,
  type DataIntelligencePolicy,
  GENERATOR_VERSION,
  K_MIN_USERS,
  MAX_PERIOD_DAYS,
  MAX_ROWS,
  PRICE_BANDS,
  PRICE_MAX_KURUS,
  PRICE_MIN_KURUS,
  SUSPICIOUS_DAILY_EVENTS,
} from "./policy.ts";
import {
  assessAnonymity,
  type Row,
  suppressSmallCells,
  usersBand,
  validateRows,
} from "./privacy.ts";
import {
  type AccuracyInputs,
  type CoverageInputs,
  computeQualityReport,
  type SourceCounters,
} from "./quality.ts";

export { DataIntelligenceInputError };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(value: string): Date {
  if (!DATE_RE.test(value)) throw new DataIntelligenceInputError("tarih YYYY-MM-DD olmalı");
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new DataIntelligenceInputError("geçersiz tarih");
  }
  return d;
}

function mondayOf(d: Date): Date {
  const day = d.getUTCDay(); // 0 = Pazar
  const diff = (day + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diff));
}

const DAY_MS = 86_400_000;

/**
 * Dönem: başlangıç ve bitiş (hariç) Pazartesi olmalı, tamamlanmış haftalardan
 * oluşmalı (bitiş ≤ bu haftanın Pazartesi'si), en çok 93 gün. Kısmi hafta yanlı
 * eğilim üretir, bu yüzden kabul edilmez.
 */
export function validatePeriod(start: string, end: string, now: Date): void {
  const s = parseDate(start);
  const e = parseDate(end);
  if (s.getUTCDay() !== 1 || e.getUTCDay() !== 1) {
    throw new DataIntelligenceInputError("dönem Pazartesi başlamalı ve Pazartesi bitmeli");
  }
  if (e <= s) throw new DataIntelligenceInputError("bitiş başlangıçtan sonra olmalı");
  if ((e.getTime() - s.getTime()) / DAY_MS > MAX_PERIOD_DAYS) {
    throw new DataIntelligenceInputError(`dönem en çok ${MAX_PERIOD_DAYS} gün`);
  }
  if (e > mondayOf(now)) {
    throw new DataIntelligenceInputError("dönem tamamlanmış haftalardan oluşmalı");
  }
}

function compact(date: string): string {
  return date.replaceAll("-", "");
}

/** Satırların kanonik, belirleyici JSON metni ve özeti. */
export function canonicalRows(spec: DatasetSpec, rows: readonly Row[]): string {
  const ordered = rows.map((row) => {
    const out: Record<string, string | number> = {};
    for (const col of spec.columns) out[col.name] = row[col.name] as string | number;
    return out;
  });
  return JSON.stringify(ordered);
}

export function rowsSha256(spec: DatasetSpec, rows: readonly Row[]): string {
  return createHash("sha256").update(canonicalRows(spec, rows)).digest("hex");
}

/** Belirleyici satır sırası: anahtar sütunlar sırayla. */
export function sortRows(spec: DatasetSpec, rows: Row[]): Row[] {
  return [...rows].sort((a, b) => {
    for (const key of spec.keyColumns) {
      const av = String(a[key]);
      const bv = String(b[key]);
      if (av !== bv) return av < bv ? -1 : 1;
    }
    return 0;
  });
}

// ---------------------------------------------------------------------------
// Kaynak okuma
// ---------------------------------------------------------------------------

import type { Tx } from "./accuracy.ts";

const BRAND_SLUG_SQL = "^[a-z0-9][a-z0-9-]{0,79}$";

function priceBandSql(): string {
  const parts = PRICE_BANDS.map(
    (b) =>
      `WHEN price_at_click >= ${b.min} AND price_at_click < ${b.max === Number.MAX_SAFE_INTEGER ? 9_000_000_000_000 : b.max} THEN '${b.key}'`,
  );
  return `CASE ${parts.join(" ")} END`;
}

/** Ortak CTE zinciri: yinelenenler, şüpheli trafik, zenginleştirme. */
function eventCtes(start: string, end: string) {
  return sql`
    WITH raw AS (
      SELECT ue.id, ue.user_id, ue.kind, ue.created_at, ue.event_id,
             ue.product_id AS ue_product_id, ue.offer_id, ue.click_id
        FROM user_activity_event ue
       WHERE ue.kind IN ('product_viewed','merchant_exit')
         AND ue.created_at >= (${start}::date)::timestamp AT TIME ZONE 'UTC'
         AND ue.created_at <  (${end}::date)::timestamp AT TIME ZONE 'UTC'
    ), dedup AS (
      SELECT DISTINCT ON (user_id, kind, ue_product_id, offer_id, click_id, created_at) *
        FROM raw
       ORDER BY user_id, kind, ue_product_id, offer_id, click_id, created_at, id
    ), dayn AS (
      SELECT d.*, count(*) OVER (
               PARTITION BY d.user_id, (d.created_at AT TIME ZONE 'UTC')::date) AS day_n
        FROM dedup d
    ), ok AS (
      SELECT * FROM dayn WHERE day_n <= ${SUSPICIOUS_DAILY_EVENTS}
    ), enr AS (
      SELECT ok.user_id, ok.kind, ok.created_at,
             to_char(date_trunc('week', ok.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS week_start,
             p.id AS product_id,
             c.id AS category_id,
             c.is_discoverable AS is_discoverable,
             array_to_string((string_to_array(c.path, '/'))[1:2], '/') AS category_path,
             b.slug AS brand_slug,
             o.id AS offer_row_id,
             o.currency AS currency,
             cl.price_at_click AS price_at_click
        FROM ok
        LEFT JOIN offer o    ON o.id = ok.offer_id
        LEFT JOIN product p  ON p.id = COALESCE(ok.ue_product_id, o.product_id)
        LEFT JOIN category c ON c.id = p.category_id
        LEFT JOIN brand b    ON b.id = p.brand_id
        LEFT JOIN click cl   ON cl.id = ok.click_id
    )`;
}

const ELIGIBLE: Record<DiDatasetKey, string> = {
  category_trends: "product_id IS NOT NULL AND category_id IS NOT NULL AND is_discoverable",
  brand_interest_trends: `product_id IS NOT NULL AND brand_slug ~ '${BRAND_SLUG_SQL}' AND is_discoverable IS NOT FALSE`,
  price_range_trends: `kind = 'merchant_exit' AND product_id IS NOT NULL AND category_id IS NOT NULL
      AND is_discoverable AND currency = 'TRY'
      AND price_at_click BETWEEN ${PRICE_MIN_KURUS} AND ${PRICE_MAX_KURUS}`,
  alternative_search_trends: "FALSE",
};

const DIMENSIONS: Record<DiDatasetKey, { select: string; names: string[] }> = {
  category_trends: { select: "category_path", names: ["category_path"] },
  brand_interest_trends: { select: "brand_slug", names: ["brand_slug"] },
  price_range_trends: {
    select: `category_path, ${priceBandSql()} AS price_band`,
    names: ["category_path", "price_band"],
  },
  alternative_search_trends: { select: "NULL::text AS none", names: [] },
};

interface Cell {
  week_start: string;
  dims: Record<string, string>;
  event_type: string;
  users: number;
  events: number;
}

interface SourceRead {
  counters: SourceCounters;
  cells: Cell[];
}

const num = (v: unknown): number => Number(v ?? 0);

async function readSource(
  tx: Tx,
  key: DiDatasetKey,
  start: string,
  end: string,
): Promise<SourceRead> {
  const ctes = eventCtes(start, end);

  const counters = await tx.execute(sql`${ctes}
    SELECT
      (SELECT count(*) FROM raw) AS raw_events,
      (SELECT count(*) FROM raw WHERE event_id IS NULL) AS legacy,
      (SELECT count(*) FROM dedup) AS dedup_events,
      (SELECT count(*) FROM ok) AS ok_events,
      (SELECT min(created_at) FROM raw) AS min_at,
      (SELECT max(created_at) FROM raw) AS max_at,
      (SELECT count(*) FROM enr WHERE product_id IS NULL) AS unresolved_product,
      (SELECT count(*) FROM enr WHERE product_id IS NOT NULL AND category_id IS NULL) AS no_category,
      (SELECT count(*) FROM enr WHERE is_discoverable = FALSE) AS sensitive,
      (SELECT count(*) FROM enr WHERE product_id IS NOT NULL AND brand_slug IS NULL) AS no_brand,
      (SELECT count(*) FROM enr WHERE brand_slug IS NOT NULL
          AND brand_slug !~ ${BRAND_SLUG_SQL}) AS invalid_brand,
      (SELECT count(*) FROM enr WHERE kind = 'merchant_exit') AS exit_events,
      (SELECT count(*) FROM enr WHERE kind = 'merchant_exit' AND offer_row_id IS NULL) AS offer_missing,
      (SELECT count(*) FROM enr WHERE kind = 'merchant_exit' AND price_at_click IS NULL) AS price_missing,
      (SELECT count(*) FROM enr WHERE kind = 'merchant_exit' AND price_at_click IS NOT NULL
          AND price_at_click NOT BETWEEN ${PRICE_MIN_KURUS} AND ${PRICE_MAX_KURUS}) AS price_invalid,
      (SELECT count(*) FROM enr WHERE kind = 'merchant_exit' AND currency IS NOT NULL
          AND currency <> 'TRY') AS currency_invalid,
      (SELECT count(*) FROM enr WHERE ${sql.raw(ELIGIBLE[key])}) AS eligible,
      (SELECT count(DISTINCT user_id) FROM enr WHERE ${sql.raw(ELIGIBLE[key])}) AS population
  `);
  const c = (counters.rows[0] ?? {}) as Record<string, unknown>;
  const rawEvents = num(c.raw_events);
  const dedupEvents = num(c.dedup_events);
  const okEvents = num(c.ok_events);

  const dim = DIMENSIONS[key];
  const dimCols = dim.names.join(", ");
  const groupBy = ["week_start", ...dim.names, "kind"].join(", ");
  const cellRows =
    ELIGIBLE[key] === "FALSE"
      ? []
      : (
          await tx.execute(sql`${ctes},
        elig AS (
          SELECT user_id, week_start, kind, ${sql.raw(dim.select)}
            FROM enr WHERE ${sql.raw(ELIGIBLE[key])}
        ), per_user AS (
          SELECT week_start, ${sql.raw(dimCols)}, kind, user_id,
                 LEAST(count(*), ${CONTRIBUTION_CAP}) AS n
            FROM elig GROUP BY week_start, ${sql.raw(dimCols)}, kind, user_id
        )
        SELECT week_start, ${sql.raw(dimCols)}, kind,
               count(*) AS users, sum(n) AS events
          FROM per_user GROUP BY ${sql.raw(groupBy)}
          ORDER BY ${sql.raw(groupBy)}
      `)
        ).rows;

  const cells: Cell[] = (cellRows as Record<string, unknown>[]).map((r) => ({
    week_start: String(r.week_start),
    dims: Object.fromEntries(dim.names.map((n) => [n, String(r[n])])),
    event_type: r.kind === "merchant_exit" ? "merchant_exit" : "product_view",
    users: num(r.users),
    events: num(r.events),
  }));

  return {
    counters: {
      rawEvents,
      duplicatesRemoved: rawEvents - dedupEvents,
      legacyWithoutEventId: num(c.legacy),
      suspiciousExcluded: dedupEvents - okEvents,
      unresolvedProduct: num(c.unresolved_product),
      noCategory: num(c.no_category),
      sensitiveCategory: num(c.sensitive),
      noBrand: num(c.no_brand),
      invalidBrand: num(c.invalid_brand),
      exitEvents: num(c.exit_events),
      offerMissing: num(c.offer_missing),
      priceMissing: num(c.price_missing),
      priceInvalid: num(c.price_invalid),
      currencyInvalid: num(c.currency_invalid),
      eligibleEvents: num(c.eligible),
      populationUsers: num(c.population),
      minEventAt: c.min_at ? new Date(c.min_at as string | Date) : null,
      maxEventAt: c.max_at ? new Date(c.max_at as string | Date) : null,
    },
    cells,
  };
}

async function readCoverage(tx: Tx): Promise<CoverageInputs> {
  const r = await tx.execute(sql`
    SELECT (SELECT count(*) FROM app_user) AS registered,
           (SELECT count(*) FROM (
              SELECT DISTINCT ON (user_id) granted FROM user_consent
               WHERE kind = 'cookie_analytics'
               ORDER BY user_id, granted_at DESC, id DESC) t WHERE t.granted) AS consenting
  `);
  const row = (r.rows[0] ?? {}) as Record<string, unknown>;
  return { registeredUsers: num(row.registered), analyticsConsentUsers: num(row.consenting) };
}

// ---------------------------------------------------------------------------
// Üretim
// ---------------------------------------------------------------------------

export interface BuildRequest {
  datasetKey: DiDatasetKey;
  periodStart: string;
  periodEnd: string;
}

export interface BuildOutcome {
  id: number;
  version: string;
  status: "ready" | "insufficient_data" | "blocked" | "failed";
  statusReason: string | null;
  rowCount: number;
  anonymityOk: boolean;
}

/** `rows` üretimi (saf): hücre → bastırma → bant → doğrulama → sıralama. */
export function materializeRows(
  spec: DatasetSpec,
  cells: readonly Cell[],
): {
  rows: Row[];
  suppressed: number;
  dropped: number;
  minUsers: number | null;
  keyDuplicates: number;
} {
  const { kept, suppressed } = suppressSmallCells(cells, K_MIN_USERS);
  const rows: Row[] = [];
  let dropped = 0;
  let minUsers: number | null = null;
  for (const cell of kept) {
    const band = usersBand(cell.users);
    if (band === null) continue;
    const row: Row = {
      week_start: cell.week_start,
      ...cell.dims,
      event_type: cell.event_type,
      events: cell.events,
      users_band: band,
    };
    // Biçim desenine uymayan/kimlik benzeri değer: satırı at (tüm çıktıyı değil).
    if (validateRows(spec, [row]).length > 0) {
      dropped += 1;
      continue;
    }
    rows.push(row);
    minUsers = minUsers === null ? cell.users : Math.min(minUsers, cell.users);
  }
  const sorted = sortRows(spec, rows);
  const seen = new Set<string>();
  let keyDuplicates = 0;
  for (const r of sorted) {
    const k = spec.keyColumns.map((c) => String(r[c])).join("\u0000");
    if (seen.has(k)) keyDuplicates += 1;
    seen.add(k);
  }
  return { rows: sorted, suppressed, dropped, minUsers, keyDuplicates };
}

export async function buildDataset(
  db: Database,
  actor: AdminActor,
  request: BuildRequest,
  policy: DataIntelligencePolicy,
  opts: { now?: Date } = {},
): Promise<BuildOutcome> {
  assertCapability(actor, "data.build");
  const now = opts.now ?? new Date();
  if (!isDatasetKey(request.datasetKey))
    throw new DataIntelligenceInputError("bilinmeyen veri seti");
  validatePeriod(request.periodStart, request.periodEnd, now);
  const spec = DATASET_SPECS[request.datasetKey];

  // 1) Üretilemez ya da kapalı: kaynak OKUNMADAN sabit nedenli kayıt.
  let blockedReason: string | null = null;
  if (!spec.producible) blockedReason = "no_event_source";
  else if (!policy.buildEnabled) blockedReason = "build_disabled";
  if (blockedReason) {
    return insertBuild(db, actor, spec, request, now, {
      status: "blocked",
      statusReason: blockedReason,
      rows: [],
      sha: null,
      maxEventAt: null,
      lineage: { sources: [], note: spec.notProducibleReason ?? "Hukuki bayrak kapalı." },
      quality: {},
      anonymity: {},
      anonymityOk: false,
    });
  }

  // 2) Kaynağı oku (salt okunur, zaman aşımlı).
  let read: SourceRead;
  let coverage: CoverageInputs;
  let accuracy: AccuracyInputs;
  try {
    ({ read, coverage, accuracy } = await readOnly(db, 15_000, async (tx) => ({
      read: await readSource(tx, spec.key, request.periodStart, request.periodEnd),
      coverage: await readCoverage(tx),
      accuracy: await readAccuracy(tx, spec.key, request.periodStart, request.periodEnd),
    })));
  } catch {
    return insertBuild(db, actor, spec, request, now, {
      status: "failed",
      statusReason: "source_read_failed",
      rows: [],
      sha: null,
      maxEventAt: null,
      lineage: {},
      quality: {},
      anonymity: {},
      anonymityOk: false,
    });
  }

  const m = materializeRows(spec, read.cells);
  const rows = m.rows.slice(0, MAX_ROWS);
  const anonymity = assessAnonymity({
    spec,
    rows,
    minPublishedUsers: m.minUsers,
    populationUsers: read.counters.populationUsers,
  });
  const version = await nextVersion(db, spec, request);
  const quality = computeQualityReport({
    spec,
    version,
    periodStart: request.periodStart,
    periodEnd: request.periodEnd,
    rowCount: rows.length,
    suppressedCells: m.suppressed,
    droppedInvalidRows: m.dropped,
    rowKeyDuplicates: m.keyDuplicates,
    counters: read.counters,
    coverage,
    accuracy,
    anonymity,
    now,
  });

  if (rows.length === 0) {
    return insertBuild(db, actor, spec, request, now, {
      status: "insufficient_data",
      statusReason:
        read.counters.rawEvents === 0
          ? "no_events_in_period"
          : read.counters.eligibleEvents === 0
            ? "no_eligible_events"
            : "all_cells_below_k",
      rows: [],
      sha: null,
      maxEventAt: read.counters.maxEventAt,
      lineage: quality.lineage,
      quality,
      anonymity,
      anonymityOk: false,
    });
  }

  return insertBuild(db, actor, spec, request, now, {
    status: "ready",
    statusReason: null,
    rows,
    sha: rowsSha256(spec, rows),
    maxEventAt: read.counters.maxEventAt,
    lineage: quality.lineage,
    quality,
    anonymity,
    anonymityOk: anonymity.ok,
    version,
  });
}

async function nextVersion(db: Database, spec: DatasetSpec, req: BuildRequest): Promise<string> {
  const prefix = `${spec.specVersion}+${compact(req.periodStart)}_${compact(req.periodEnd)}.b`;
  const r = await db.execute(sql`
    SELECT count(*) AS n FROM di_dataset_build
     WHERE dataset_key = ${spec.key} AND version LIKE ${`${prefix}%`}
  `);
  const n = num((r.rows[0] as Record<string, unknown> | undefined)?.n) + 1;
  return `${prefix}${n}`;
}

interface InsertPayload {
  status: BuildOutcome["status"];
  statusReason: string | null;
  rows: Row[];
  sha: string | null;
  maxEventAt: Date | null;
  lineage: Record<string, unknown>;
  quality: object;
  anonymity: object;
  anonymityOk: boolean;
  version?: string;
}

async function insertBuild(
  db: Database,
  actor: AdminActor,
  spec: DatasetSpec,
  req: BuildRequest,
  now: Date,
  p: InsertPayload,
): Promise<BuildOutcome> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('di_build'), hashtext(${spec.key}))`,
    );
    const prefix = `${spec.specVersion}+${compact(req.periodStart)}_${compact(req.periodEnd)}.b`;
    const count = await tx.execute(sql`
      SELECT count(*) AS n FROM di_dataset_build
       WHERE dataset_key = ${spec.key} AND version LIKE ${`${prefix}%`}`);
    const version = `${prefix}${num((count.rows[0] as Record<string, unknown> | undefined)?.n) + 1}`;
    if (p.version !== undefined && p.version !== version) {
      // Eşzamanlı üretim sürüm numarasını kaydırdı: kalite raporundaki sürümü düzelt.
      (p.quality as { version?: string }).version = version;
    }
    const [row] = await tx
      .insert(diDatasetBuild)
      .values({
        datasetKey: spec.key,
        version,
        specVersion: spec.specVersion,
        generatorVersion: GENERATOR_VERSION,
        periodStart: req.periodStart,
        periodEnd: req.periodEnd,
        status: p.status,
        statusReason: p.statusReason,
        rowCount: p.rows.length,
        rows: p.rows,
        contentSha256: p.sha,
        sourceMaxEventAt: p.maxEventAt,
        lineage: p.lineage,
        qualityReport: p.quality as Record<string, unknown>,
        anonymity: p.anonymity as Record<string, unknown>,
        anonymityOk: p.anonymityOk,
        createdBy: actor.userId,
        createdAt: now,
      })
      .returning({ id: diDatasetBuild.id });
    if (!row) throw new Error("di_dataset_build insert döndürmedi");
    await recordAdminEvent(tx, {
      actor,
      action: "data.build",
      targetType: "data_build",
      targetId: row.id,
      after: {
        dataset: spec.key,
        version,
        status: p.status,
        statusReason: p.statusReason,
        rowCount: p.rows.length,
        anonymityOk: p.anonymityOk,
      },
    });
    return {
      id: row.id,
      version,
      status: p.status,
      statusReason: p.statusReason,
      rowCount: p.rows.length,
      anonymityOk: p.anonymityOk,
    };
  });
}
