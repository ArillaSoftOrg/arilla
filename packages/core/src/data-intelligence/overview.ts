/**
 * Yönetim paneli okumaları (Faz 1 canlı denetim, Faz 7). Yalnızca toplamlar:
 * kişi, oturum, sorgu metni dönmez. Her okuma salt okunur işlem + zaman aşımıdır.
 */
import { type Database, diDatasetBuild, diExport } from "@arilla/db";
import { desc, eq, sql } from "drizzle-orm";
import { readOnly } from "../admin/bounds.ts";
import { type AdminActor, assertCapability } from "../admin/capabilities.ts";
import { DATASET_KEYS, DATASET_SPECS } from "./datasets.ts";
import type { DataIntelligencePolicy } from "./policy.ts";
import { COLLECTION_AUDIT, type CollectionAuditSpec } from "./sources.ts";

export interface LiveMetric {
  label: string;
  value: number | null;
  /** `null` = ölçülemedi (tablo yok / zaman aşımı), 0 ile karıştırılmaz. */
  note?: string;
}

export interface CollectionAuditRow extends CollectionAuditSpec {
  live: LiveMetric[];
  firstAt: Date | null;
  lastAt: Date | null;
}

const num = (v: unknown): number => Number(v ?? 0);
const date = (v: unknown): Date | null => (v ? new Date(v as string | Date) : null);

export async function getCollectionAudit(
  db: Database,
  actor: AdminActor,
): Promise<CollectionAuditRow[]> {
  assertCapability(actor, "data.read");
  const live = await readOnly(db, 8_000, async (tx) => {
    const events = await tx.execute(sql`
      SELECT kind,
             count(*) FILTER (WHERE created_at >= now() - interval '30 days') AS d30,
             count(*) AS total,
             min(created_at) AS first_at, max(created_at) AS last_at,
             count(*) FILTER (WHERE schema_version = 2) AS v2
        FROM user_activity_event GROUP BY kind`);
    const click = await tx.execute(sql`
      SELECT count(*) FILTER (WHERE created_at >= now() - interval '30 days') AS d30,
             count(*) AS total, min(created_at) AS first_at, max(created_at) AS last_at,
             count(*) FILTER (WHERE source_similarity_kind IS NOT NULL) AS with_similarity,
             count(*) FILTER (WHERE result_position IS NOT NULL) AS with_position,
             count(*) FILTER (WHERE price_at_click IS NOT NULL) AS with_price
        FROM click`);
    const pv = await tx.execute(
      sql`SELECT count(*) AS total, max(viewed_at) AS last_at FROM product_view`,
    );
    const sq = await tx.execute(sql`
      SELECT coalesce(sum(searches) FILTER (WHERE day >= current_date - 30), 0) AS d30,
             coalesce(sum(searches), 0) AS total, min(day) AS first_day, max(day) AS last_day
        FROM search_query_day`);
    const charge = await tx.execute(sql`
      SELECT count(*) FILTER (WHERE created_at >= now() - interval '30 days') AS d30,
             count(*) AS total FROM ai_search_charge`);
    return {
      events: events.rows as Record<string, unknown>[],
      click: (click.rows[0] ?? {}) as Record<string, unknown>,
      pv: (pv.rows[0] ?? {}) as Record<string, unknown>,
      sq: (sq.rows[0] ?? {}) as Record<string, unknown>,
      charge: (charge.rows[0] ?? {}) as Record<string, unknown>,
    };
  });
  const ev = (kind: string) => live.events.find((r) => r.kind === kind);
  const evMetrics = (kind: string, label: string): LiveMetric[] => {
    const r = ev(kind);
    return [
      { label: `${label} (30 gün)`, value: r ? num(r.d30) : 0 },
      { label: `${label} (toplam)`, value: r ? num(r.total) : 0 },
      {
        label: `sürüm 2 (event_id'li) payı`,
        value: r && num(r.total) > 0 ? num(r.v2) / num(r.total) : null,
        note: r ? undefined : "olay yok",
      },
    ];
  };
  const evRange = (kind: string) => {
    const r = ev(kind);
    return { firstAt: date(r?.first_at), lastAt: date(r?.last_at) };
  };

  const rows: CollectionAuditRow[] = COLLECTION_AUDIT.map((spec) => {
    switch (spec.key) {
      case "product_search":
        return {
          ...spec,
          live: [
            ...evMetrics("search_submitted", "search_submitted"),
            { label: "search_query_day aramaları (30 gün)", value: num(live.sq.d30) },
          ],
          ...evRange("search_submitted"),
        };
      case "product_view":
        return {
          ...spec,
          live: [
            ...evMetrics("product_viewed", "product_viewed"),
            {
              label: "product_view (kullanıcının kendi geçmişi; analitik kaynağı değil)",
              value: num(live.pv.total),
            },
          ],
          ...evRange("product_viewed"),
        };
      case "merchant_click":
        return {
          ...spec,
          live: [
            ...evMetrics("merchant_exit", "merchant_exit (rızalı)"),
            { label: "click satırı (30 gün, attribution)", value: num(live.click.d30) },
            { label: "click: fiyatı olan", value: num(live.click.with_price) },
            { label: "click: result_position olan", value: num(live.click.with_position) },
            { label: "click: source_similarity_kind olan", value: num(live.click.with_similarity) },
          ],
          ...evRange("merchant_exit"),
        };
      case "image_search":
        return {
          ...spec,
          live: [
            { label: "ai_search_charge (30 gün; fotoğraf+link)", value: num(live.charge.d30) },
            { label: "ai_search_charge (toplam)", value: num(live.charge.total) },
          ],
          firstAt: null,
          lastAt: null,
        };
      case "product_category":
      case "brand_price":
        return {
          ...spec,
          live: [
            {
              label: "Türetilir; ayrı kayıt sayısı yok",
              value: null,
              note: "build zamanında ölçülür",
            },
          ],
          firstAt: null,
          lastAt: null,
        };
      default:
        return {
          ...spec,
          live: [{ label: "Kayıt", value: 0, note: "olay yazılmıyor" }],
          firstAt: null,
          lastAt: null,
        };
    }
  });
  return rows;
}

export interface DailyVolume {
  day: string;
  product_viewed: number;
  merchant_exit: number;
  search_submitted: number;
}

/** Son N gün olay hacmi (toplam sayı; kişi yok). */
export async function getEventVolumes(
  db: Database,
  actor: AdminActor,
  days = 14,
): Promise<DailyVolume[]> {
  assertCapability(actor, "data.read");
  const n = Math.min(Math.max(1, Math.trunc(days)), 90);
  const res = await readOnly(db, 8_000, (tx) =>
    tx.execute(sql`
      SELECT to_char((created_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day, kind, count(*) AS n
        FROM user_activity_event
       WHERE created_at >= (current_date - ${n}::int)
       GROUP BY 1, 2 ORDER BY 1`),
  );
  const byDay = new Map<string, DailyVolume>();
  for (const r of res.rows as { day: string; kind: string; n: unknown }[]) {
    const d = byDay.get(r.day) ?? {
      day: r.day,
      product_viewed: 0,
      merchant_exit: 0,
      search_submitted: 0,
    };
    if (
      r.kind === "product_viewed" ||
      r.kind === "merchant_exit" ||
      r.kind === "search_submitted"
    ) {
      d[r.kind] = num(r.n);
    }
    byDay.set(r.day, d);
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}

export interface BuildSummary {
  id: number;
  datasetKey: string;
  version: string;
  period: string;
  status: string;
  statusReason: string | null;
  rowCount: number;
  anonymityOk: boolean;
  createdAt: Date;
}

export interface DatasetCard {
  key: string;
  title: string;
  producible: boolean;
  notProducibleReason: string | null;
  latest: BuildSummary | null;
}

export interface ExportSummary {
  id: number;
  buildId: number;
  status: string;
  errorClass: string | null;
  createdAt: Date;
  files: number;
}

export interface DataIntelligenceOverview {
  generatedAt: Date;
  policy: { buildEnabled: boolean; exportEnabled: boolean; clearedSources: string[] };
  datasets: DatasetCard[];
  history: BuildSummary[];
  exports: ExportSummary[];
}

type BuildRowLite = Pick<
  typeof diDatasetBuild.$inferSelect,
  | "id"
  | "datasetKey"
  | "version"
  | "periodStart"
  | "periodEnd"
  | "status"
  | "statusReason"
  | "rowCount"
  | "anonymityOk"
  | "createdAt"
>;

function toSummary(r: BuildRowLite): BuildSummary {
  return {
    id: r.id,
    datasetKey: r.datasetKey,
    version: r.version,
    period: `${r.periodStart} → ${r.periodEnd}`,
    status: r.status,
    statusReason: r.statusReason,
    rowCount: r.rowCount,
    anonymityOk: r.anonymityOk,
    createdAt: r.createdAt,
  };
}

export async function getDataIntelligenceOverview(
  db: Database,
  actor: AdminActor,
  policy: DataIntelligencePolicy,
): Promise<DataIntelligenceOverview> {
  assertCapability(actor, "data.read");
  // `rows` büyük olabilir: liste için seçilmez.
  const builds = await db
    .select({
      id: diDatasetBuild.id,
      datasetKey: diDatasetBuild.datasetKey,
      version: diDatasetBuild.version,
      periodStart: diDatasetBuild.periodStart,
      periodEnd: diDatasetBuild.periodEnd,
      status: diDatasetBuild.status,
      statusReason: diDatasetBuild.statusReason,
      rowCount: diDatasetBuild.rowCount,
      anonymityOk: diDatasetBuild.anonymityOk,
      createdAt: diDatasetBuild.createdAt,
    })
    .from(diDatasetBuild)
    .orderBy(desc(diDatasetBuild.createdAt), desc(diDatasetBuild.id))
    .limit(50);
  const summaries: BuildSummary[] = builds.map(toSummary);
  const exports = await db
    .select({
      id: diExport.id,
      buildId: diExport.buildId,
      status: diExport.status,
      errorClass: diExport.errorClass,
      createdAt: diExport.createdAt,
      manifest: diExport.manifest,
    })
    .from(diExport)
    .orderBy(desc(diExport.createdAt), desc(diExport.id))
    .limit(20);
  return {
    generatedAt: new Date(),
    policy: {
      buildEnabled: policy.buildEnabled,
      exportEnabled: policy.exportEnabled,
      clearedSources: [...policy.clearedSources].sort(),
    },
    datasets: DATASET_KEYS.map((key) => ({
      key,
      title: DATASET_SPECS[key].title,
      producible: DATASET_SPECS[key].producible,
      notProducibleReason: DATASET_SPECS[key].notProducibleReason ?? null,
      latest: summaries.find((s) => s.datasetKey === key) ?? null,
    })),
    history: summaries.slice(0, 20),
    exports: exports.map((e) => ({
      id: e.id,
      buildId: e.buildId,
      status: e.status,
      errorClass: e.errorClass,
      createdAt: e.createdAt,
      files: e.manifest.length,
    })),
  };
}

export interface BuildDetail extends BuildSummary {
  contentSha256: string | null;
  qualityReport: Record<string, unknown>;
  anonymity: Record<string, unknown>;
  lineage: Record<string, unknown>;
  /** Önizleme: en çok 50 satır. */
  preview: Record<string, string | number>[];
  columns: string[];
  exportEligibleTechnically: boolean;
}

export async function getBuildDetail(
  db: Database,
  actor: AdminActor,
  buildId: number,
): Promise<BuildDetail | null> {
  assertCapability(actor, "data.read");
  if (!Number.isSafeInteger(buildId) || buildId < 1) return null;
  const [r] = await db.select().from(diDatasetBuild).where(eq(diDatasetBuild.id, buildId)).limit(1);
  if (!r) return null;
  return {
    ...toSummary(r),
    contentSha256: r.contentSha256,
    qualityReport: r.qualityReport,
    anonymity: r.anonymity,
    lineage: r.lineage,
    preview: r.rows.slice(0, 50),
    columns: DATASET_SPECS[r.datasetKey].columns.map((c) => c.name),
    exportEligibleTechnically: r.status === "ready" && r.anonymityOk,
  };
}
