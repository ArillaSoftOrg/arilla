/**
 * Dahili dışa aktarım (Faz 6). YALNIZCA yönetici (`data.export`); müşteriye açık
 * API ya da otomatik dış aktarım YOKTUR. Dosyalar saklanmaz: değişmez sürümden
 * belirleyici olarak yeniden üretilir ve manifest'teki SHA-256 ile doğrulanır.
 *
 * Çıktılar: data.csv, metadata.json, data_dictionary.json, quality_report.json,
 * SHA256SUMS. Parquet bu sürümde YOK (yeni bağımlılık eklenmedi; bkz. karar 0103).
 *
 * Kapılar (hepsi geçmeli; biri kapalıysa dosya üretilmez):
 *   politika açık → sürüm hazır → anonimlik teknik kontrolleri geçti → kaynaklar
 *   hukuken onaylı → saatlik hız sınırı → boyut sınırı → bütünlük.
 * Reddedilen her deneme de denetime yazılır.
 */
import { createHash } from "node:crypto";
import { type Database, type DiExportFile, diDatasetBuild, diExport } from "@arilla/db";
import { and, eq, sql } from "drizzle-orm";
import { recordAdminEvent } from "../admin/audit.ts";
import { type AdminActor, assertCapability } from "../admin/capabilities.ts";
import { readAccuracy } from "./accuracy.ts";
import { rowsSha256 } from "./builder.ts";
import { DATASET_SPECS, type DatasetSpec, dataDictionary } from "./datasets.ts";
import {
  type DataIntelligencePolicy,
  MAX_EXPORT_BYTES,
  MAX_EXPORTS_PER_HOUR,
  uncleared,
} from "./policy.ts";
import type { Row } from "./privacy.ts";
import { accuracyMetric } from "./quality.ts";

export const EXPORT_FILE_NAMES = [
  "data.csv",
  "metadata.json",
  "data_dictionary.json",
  "quality_report.json",
  "SHA256SUMS",
] as const;
export type ExportFileName = (typeof EXPORT_FILE_NAMES)[number];

const CONTENT_TYPES: Record<ExportFileName, string> = {
  "data.csv": "text/csv; charset=utf-8",
  "metadata.json": "application/json; charset=utf-8",
  "data_dictionary.json": "application/json; charset=utf-8",
  "quality_report.json": "application/json; charset=utf-8",
  SHA256SUMS: "text/plain; charset=utf-8",
};

/** Yol gezintisine karşı: yalnızca sabit ad listesi kabul edilir, dosya sistemi hiç kullanılmaz. */
export function parseExportFileName(value: unknown): ExportFileName | null {
  return typeof value === "string" && (EXPORT_FILE_NAMES as readonly string[]).includes(value)
    ? (value as ExportFileName)
    : null;
}

export type ExportRefusal =
  | "export_disabled"
  | "build_not_found"
  | "build_not_ready"
  | "anonymity_not_assured"
  | "legal_not_cleared"
  | "rate_limited"
  | "export_not_found"
  | "export_not_completed"
  | "invalid_file";

export class ExportRefusedError extends Error {
  readonly reason: ExportRefusal;
  readonly detail: string[];
  constructor(reason: ExportRefusal, detail: string[] = []) {
    super(`dışa aktarım reddedildi: ${reason}`);
    this.name = "ExportRefusedError";
    this.reason = reason;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// Biçimlendirme (saf)
// ---------------------------------------------------------------------------

/**
 * CSV hücresi. Formül enjeksiyonu: `= + - @ TAB CR` ile başlayan metin (baştaki
 * boşluklar atlanarak bakılır) başına `'` konur; sonra RFC 4180 tırnaklama.
 * Sayılar yalnızca negatif olmayan tamsayı olarak yazılır.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : "";
  }
  let text = value;
  const first = text.replace(/^[ ]+/, "").charAt(0);
  if (
    first === "=" ||
    first === "+" ||
    first === "-" ||
    first === "@" ||
    first === "\t" ||
    first === "\r"
  ) {
    text = `'${text}`;
  }
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

export function toCsv(spec: DatasetSpec, rows: readonly Row[]): string {
  const header = spec.columns.map((c) => csvCell(c.name)).join(",");
  const lines = rows.map((row) => spec.columns.map((c) => csvCell(row[c.name])).join(","));
  return `${[header, ...lines].join("\n")}\n`;
}

/** Anahtarları sıralı JSON: aynı girdi her zaman aynı bayt. */
export function stableStringify(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export interface BuildForExport {
  id: number;
  datasetKey: keyof typeof DATASET_SPECS;
  version: string;
  specVersion: string;
  generatorVersion: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  rowCount: number;
  rows: Row[];
  contentSha256: string | null;
  sourceMaxEventAt: Date | null;
  lineage: Record<string, unknown>;
  qualityReport: Record<string, unknown>;
  anonymity: Record<string, unknown>;
  anonymityOk: boolean;
  createdAt: Date;
}

export interface AccuracySnapshot {
  labeled: number;
  correct: number;
  incorrect: number;
  unsure: number;
}

/** Kalite raporundaki doğruluk metriğini dışa aktarım anındaki etiket özetiyle değiştirir. */
function qualityWithAccuracy(report: Record<string, unknown>, snap: AccuracySnapshot) {
  const metrics = Array.isArray(report.metrics) ? (report.metrics as { key: string }[]) : [];
  const fresh = accuracyMetric(snap);
  const replaced = metrics.some((m) => m.key === fresh.key)
    ? metrics.map((m) => (m.key === fresh.key ? fresh : m))
    : [...metrics, fresh];
  return { ...report, metrics: replaced };
}

/** Belirleyici dosya içerikleri: aynı sürüm + aynı doğruluk özeti = aynı baytlar. */
export function generateExportFiles(
  build: BuildForExport,
  snapshot: AccuracySnapshot,
): Record<ExportFileName, string> {
  const spec = DATASET_SPECS[build.datasetKey];
  const csv = toCsv(spec, build.rows);
  const dictionary = stableStringify(dataDictionary(spec));
  const quality = stableStringify(qualityWithAccuracy(build.qualityReport, snapshot));
  const metadata = stableStringify({
    dataset: spec.key,
    title: spec.title,
    version: build.version,
    specVersion: build.specVersion,
    generatorVersion: build.generatorVersion,
    period: { start: build.periodStart, endExclusive: build.periodEnd },
    rowCount: build.rowCount,
    contentSha256: build.contentSha256,
    sourceMaxEventAt: build.sourceMaxEventAt ? build.sourceMaxEventAt.toISOString() : null,
    builtAt: build.createdAt.toISOString(),
    lineage: build.lineage,
    anonymity: build.anonymity,
    usage: "DAHİLİ KULLANIM. Üçüncü taraflara verilmeden önce hukuki onay ve sözleşme gerekir.",
  });
  const sums = [
    `${sha256(csv)}  data.csv`,
    `${sha256(metadata)}  metadata.json`,
    `${sha256(dictionary)}  data_dictionary.json`,
    `${sha256(quality)}  quality_report.json`,
  ].join("\n");
  return {
    "data.csv": csv,
    "metadata.json": metadata,
    "data_dictionary.json": dictionary,
    "quality_report.json": quality,
    SHA256SUMS: `${sums}\n`,
  };
}

export function manifestOf(files: Record<ExportFileName, string>): DiExportFile[] {
  return EXPORT_FILE_NAMES.map((name) => ({
    name,
    bytes: Buffer.byteLength(files[name], "utf8"),
    sha256: sha256(files[name]),
  }));
}

// ---------------------------------------------------------------------------
// Kapılar ve akış
// ---------------------------------------------------------------------------

async function loadBuild(
  db: Pick<Database, "select">,
  buildId: number,
): Promise<BuildForExport | null> {
  const [row] = await db
    .select()
    .from(diDatasetBuild)
    .where(eq(diDatasetBuild.id, buildId))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    datasetKey: row.datasetKey,
    version: row.version,
    specVersion: row.specVersion,
    generatorVersion: row.generatorVersion,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    status: row.status,
    rowCount: row.rowCount,
    rows: row.rows,
    contentSha256: row.contentSha256,
    sourceMaxEventAt: row.sourceMaxEventAt,
    lineage: row.lineage,
    qualityReport: row.qualityReport,
    anonymity: row.anonymity,
    anonymityOk: row.anonymityOk,
    createdAt: row.createdAt,
  };
}

/** Kapı değerlendirmesi (saf). Reddedilirse neden döner. */
export function evaluateExportGate(
  build: BuildForExport | null,
  policy: DataIntelligencePolicy,
): { reason: ExportRefusal; detail: string[] } | null {
  if (!policy.exportEnabled) return { reason: "export_disabled", detail: [] };
  if (!build) return { reason: "build_not_found", detail: [] };
  if (build.status !== "ready") return { reason: "build_not_ready", detail: [build.status] };
  if (!build.anonymityOk) {
    const checks = (build.anonymity as { checks?: { id: string; passed: boolean }[] }).checks ?? [];
    return {
      reason: "anonymity_not_assured",
      detail: checks.filter((c) => !c.passed).map((c) => c.id),
    };
  }
  const spec = DATASET_SPECS[build.datasetKey];
  const missing = uncleared(policy, spec.sources);
  if (missing.length > 0) return { reason: "legal_not_cleared", detail: missing };
  return null;
}

async function refuse(
  db: Database,
  actor: AdminActor,
  buildId: number,
  refusal: { reason: ExportRefusal; detail: string[] },
): Promise<never> {
  await db.transaction(async (tx) => {
    await recordAdminEvent(tx, {
      actor,
      action: "data.export",
      targetType: "data_build",
      targetId: buildId,
      after: { outcome: "refused", reason: refusal.reason, detail: refusal.detail.slice(0, 5) },
    });
  });
  throw new ExportRefusedError(refusal.reason, refusal.detail);
}

export interface ExportOutcome {
  exportId: number;
  status: "completed" | "failed" | "cancelled";
  manifest: DiExportFile[];
  errorClass: string | null;
}

/** Aşama 1: kapıları geç, `requested` kaydı aç. Dosya üretmez. */
export async function startExport(
  db: Database,
  actor: AdminActor,
  buildId: number,
  policy: DataIntelligencePolicy,
  now: Date = new Date(),
): Promise<number> {
  assertCapability(actor, "data.export");
  const build = await loadBuild(db, buildId);
  const gate = evaluateExportGate(build, policy);
  if (gate) await refuse(db, actor, buildId, gate);

  return db
    .transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('di_export'), 1)`);
      const recent = await tx.execute(sql`
      SELECT count(*) AS n FROM di_export WHERE created_at >= ${new Date(now.getTime() - 3_600_000)}`);
      if (Number((recent.rows[0] as { n: unknown } | undefined)?.n ?? 0) >= MAX_EXPORTS_PER_HOUR) {
        await recordAdminEvent(tx, {
          actor,
          action: "data.export",
          targetType: "data_build",
          targetId: buildId,
          after: { outcome: "refused", reason: "rate_limited" },
        });
        // Reddi kalıcı kılmak için işlem başarıyla biter; hata dışarıda fırlatılır.
        return -1;
      }
      const [row] = await tx
        .insert(diExport)
        .values({ buildId, requestedBy: actor.userId, status: "requested", createdAt: now })
        .returning({ id: diExport.id });
      if (!row) throw new Error("di_export insert döndürmedi");
      await recordAdminEvent(tx, {
        actor,
        action: "data.export",
        targetType: "data_export",
        targetId: row.id,
        after: { outcome: "requested", buildId },
      });
      return row.id;
    })
    .then((id) => {
      if (id === -1) throw new ExportRefusedError("rate_limited");
      return id;
    });
}

async function finish(
  db: Database,
  exportId: number,
  patch: {
    status: "completed" | "failed" | "cancelled";
    manifest?: DiExportFile[];
    accuracy?: AccuracySnapshot;
    errorClass?: string;
  },
  now: Date,
): Promise<boolean> {
  const updated = await db
    .update(diExport)
    .set({
      status: patch.status,
      manifest: patch.manifest ?? [],
      accuracySnapshot: (patch.accuracy ?? {}) as Record<string, unknown>,
      errorClass: patch.errorClass ?? null,
      finishedAt: now,
    })
    .where(and(eq(diExport.id, exportId), eq(diExport.status, "requested")))
    .returning({ id: diExport.id });
  return updated.length > 0;
}

/**
 * Aşama 2: dosyaları üret, bütünlüğü ve boyutu doğrula, manifest'i yaz. Hata ya da
 * iptal (AbortSignal) durumunda kayıt `failed`/`cancelled` olur; kısmi çıktı yoktur.
 */
export async function runExport(
  db: Database,
  actor: AdminActor,
  exportId: number,
  policy: DataIntelligencePolicy,
  opts: { signal?: AbortSignal; now?: Date } = {},
): Promise<ExportOutcome> {
  assertCapability(actor, "data.export");
  const now = opts.now ?? new Date();
  const [record] = await db.select().from(diExport).where(eq(diExport.id, exportId)).limit(1);
  if (!record) throw new ExportRefusedError("export_not_found");
  if (record.status !== "requested") {
    return {
      exportId,
      status: record.status as "completed",
      manifest: record.manifest,
      errorClass: record.errorClass,
    };
  }
  const abort = async (): Promise<ExportOutcome> => {
    await finish(db, exportId, { status: "cancelled" }, now);
    await auditExport(db, actor, exportId, "cancelled");
    return { exportId, status: "cancelled", manifest: [], errorClass: null };
  };
  const fail = async (errorClass: string): Promise<ExportOutcome> => {
    await finish(db, exportId, { status: "failed", errorClass }, now);
    await auditExport(db, actor, exportId, "failed", { errorClass });
    return { exportId, status: "failed", manifest: [], errorClass };
  };

  if (opts.signal?.aborted) return abort();
  try {
    const build = await loadBuild(db, record.buildId);
    // Kapılar çalışma anında yeniden değerlendirilir (bayrak arada kapanmış olabilir).
    const gate = evaluateExportGate(build, policy);
    if (gate || !build) return fail(gate?.reason ?? "build_not_found");
    const spec = DATASET_SPECS[build.datasetKey];
    // Bütünlük: saklanan satırların özeti, üretimde yazılan özetle aynı olmalı.
    if (build.contentSha256 !== rowsSha256(spec, build.rows)) return fail("integrity_mismatch");
    const accuracy = await readAccuracy(db, build.datasetKey, build.periodStart, build.periodEnd);
    const files = generateExportFiles(build, accuracy);
    const manifest = manifestOf(files);
    if (manifest.reduce((sum, f) => sum + f.bytes, 0) > MAX_EXPORT_BYTES) return fail("too_large");
    if (opts.signal?.aborted) return abort();
    const ok = await finish(db, exportId, { status: "completed", manifest, accuracy }, now);
    if (!ok) return abort(); // arada iptal edilmiş
    await auditExport(db, actor, exportId, "completed", { files: manifest.length });
    return { exportId, status: "completed", manifest, errorClass: null };
  } catch {
    return fail("unexpected");
  }
}

async function auditExport(
  db: Database,
  actor: AdminActor,
  exportId: number,
  outcome: string,
  extra: Record<string, string | number> = {},
): Promise<void> {
  await db.transaction(async (tx) => {
    await recordAdminEvent(tx, {
      actor,
      action: outcome === "cancelled" ? "data.export_cancel" : "data.export",
      targetType: "data_export",
      targetId: exportId,
      after: { outcome, ...extra },
    });
  });
}

/** Tek çağrıda başlat + çalıştır. */
export async function requestExport(
  db: Database,
  actor: AdminActor,
  buildId: number,
  policy: DataIntelligencePolicy,
  opts: { signal?: AbortSignal; now?: Date } = {},
): Promise<ExportOutcome> {
  const exportId = await startExport(db, actor, buildId, policy, opts.now);
  return runExport(db, actor, exportId, policy, opts);
}

/** Yalnızca `requested` durumundaki kayıt iptal edilebilir. */
export async function cancelExport(
  db: Database,
  actor: AdminActor,
  exportId: number,
  now: Date = new Date(),
): Promise<boolean> {
  assertCapability(actor, "data.export");
  const ok = await finish(db, exportId, { status: "cancelled" }, now);
  if (ok) await auditExport(db, actor, exportId, "cancelled");
  return ok;
}

export interface ExportFileResult {
  name: ExportFileName;
  contentType: string;
  body: string;
  sha256: string;
}

/** Tamamlanmış dışa aktarımın tek dosyası; manifest'e karşı doğrulanır, indirme denetime yazılır. */
export async function getExportFile(
  db: Database,
  actor: AdminActor,
  exportId: number,
  fileName: unknown,
  policy: DataIntelligencePolicy,
): Promise<ExportFileResult> {
  assertCapability(actor, "data.export");
  const name = parseExportFileName(fileName);
  if (!name) throw new ExportRefusedError("invalid_file");
  if (!Number.isSafeInteger(exportId) || exportId < 1)
    throw new ExportRefusedError("export_not_found");
  const [record] = await db.select().from(diExport).where(eq(diExport.id, exportId)).limit(1);
  if (!record) throw new ExportRefusedError("export_not_found");
  if (record.status !== "completed") throw new ExportRefusedError("export_not_completed");
  const build = await loadBuild(db, record.buildId);
  const gate = evaluateExportGate(build, policy);
  if (gate || !build)
    await refuse(db, actor, record.buildId, gate ?? { reason: "build_not_found", detail: [] });
  const files = generateExportFiles(
    build as BuildForExport,
    record.accuracySnapshot as unknown as AccuracySnapshot,
  );
  const expected = record.manifest.find((f) => f.name === name);
  const body = files[name];
  const actual = sha256(body);
  if (!expected || expected.sha256 !== actual) {
    throw new ExportRefusedError("export_not_completed", ["integrity_mismatch"]);
  }
  await db.transaction(async (tx) => {
    await recordAdminEvent(tx, {
      actor,
      action: "data.export_download",
      targetType: "data_export",
      targetId: exportId,
      after: { file: name, sha256: actual },
    });
  });
  return { name, contentType: CONTENT_TYPES[name], body, sha256: actual };
}
