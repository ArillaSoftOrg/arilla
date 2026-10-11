"use server";

import {
  AdminForbiddenError,
  buildDataset,
  cancelExport,
  DataIntelligenceInputError,
  drawAccuracySample,
  ExportRefusedError,
  isDatasetKey,
  policyFromEnv,
  recordAccuracyLabel,
  requestExport,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireFreshCapability } from "../../lib/dal.ts";

/**
 * `/yonetim/veri-zekasi` (karar 0102). İnce istemci: yetki, hukuki kapılar,
 * doğrulama ve denetim core'dadır. Sonuç adres satırındaki `mesaj` ile gösterilir.
 */
const PATH = "/yonetim/veri-zekasi";
const STALE = "stale";

function back(code: string, extra = ""): never {
  revalidatePath(PATH);
  redirect(`${PATH}?mesaj=${encodeURIComponent(code)}${extra}`);
}

function lastWeeks(weeks: number, now = new Date()): { start: string; end: string } {
  const day = now.getUTCDay();
  const monday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((day + 6) % 7)),
  );
  const start = new Date(monday.getTime() - weeks * 7 * 86_400_000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(monday) };
}

function toInt(value: FormDataEntryValue | null): number {
  return typeof value === "string" && /^\d{1,9}$/.test(value) ? Number(value) : Number.NaN;
}

function handle(error: unknown): never {
  if (error instanceof DataIntelligenceInputError) back(`girdi:${error.message}`);
  if (error instanceof ExportRefusedError) back(`red:${error.reason}`);
  if (error instanceof AdminForbiddenError) back("yetki");
  throw error;
}

export async function buildDatasetAction(formData: FormData): Promise<void> {
  const { actor, fresh } = await requireFreshCapability("data.build");
  if (!fresh) back(STALE);
  const key = formData.get("dataset");
  const weeks = toInt(formData.get("weeks"));
  if (!isDatasetKey(key) || !Number.isInteger(weeks) || weeks < 1 || weeks > 13) back("girdi");
  const { start, end } = lastWeeks(weeks);
  try {
    const r = await buildDataset(
      getDatabase(),
      actor,
      { datasetKey: key, periodStart: start, periodEnd: end },
      policyFromEnv(),
    );
    back(`uretim:${r.status}`, `&surum=${r.id}`);
  } catch (error) {
    handle(error);
  }
}

export async function requestExportAction(formData: FormData): Promise<void> {
  const { actor, fresh } = await requireFreshCapability("data.export");
  if (!fresh) back(STALE);
  const buildId = toInt(formData.get("buildId"));
  if (!Number.isSafeInteger(buildId)) back("girdi");
  try {
    const out = await requestExport(getDatabase(), actor, buildId, policyFromEnv());
    back(`export:${out.status}${out.errorClass ? `:${out.errorClass}` : ""}`, `&surum=${buildId}`);
  } catch (error) {
    handle(error);
  }
}

export async function cancelExportAction(formData: FormData): Promise<void> {
  const { actor, fresh } = await requireFreshCapability("data.export");
  if (!fresh) back(STALE);
  const id = toInt(formData.get("exportId"));
  if (!Number.isSafeInteger(id)) back("girdi");
  try {
    await cancelExport(getDatabase(), actor, id);
    back("export:cancelled");
  } catch (error) {
    handle(error);
  }
}

export async function drawSampleAction(formData: FormData): Promise<void> {
  const { actor, fresh } = await requireFreshCapability("data.build");
  if (!fresh) back(STALE);
  const buildId = toInt(formData.get("buildId"));
  const size = toInt(formData.get("size"));
  if (!Number.isSafeInteger(buildId)) back("girdi");
  try {
    await drawAccuracySample(getDatabase(), actor, buildId, { size });
    back("ornek:ok", `&surum=${buildId}`);
  } catch (error) {
    handle(error);
  }
}

export async function labelAction(formData: FormData): Promise<void> {
  const { actor, fresh } = await requireFreshCapability("data.build");
  if (!fresh) back(STALE);
  const id = toInt(formData.get("labelId"));
  const buildId = toInt(formData.get("buildId"));
  const verdict = formData.get("verdict");
  if (!Number.isSafeInteger(id) || typeof verdict !== "string") back("girdi");
  try {
    await recordAccuracyLabel(getDatabase(), actor, id, verdict);
    back("etiket:ok", Number.isSafeInteger(buildId) ? `&surum=${buildId}` : "");
  } catch (error) {
    handle(error);
  }
}
