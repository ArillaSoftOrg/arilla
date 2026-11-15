/**
 * Etiket CSV'si: ayristirma ve insan etiketlerini aday kayitlarina isleme.
 * Dosya UTF-8 BOM'lu ve Excel uyumludur; kor: hangi sistemin getirdigi sutunlarda yoktur.
 */
import { type CandidateItem, isLabel, type Label } from "./schema.ts";

export const LABEL_CSV_HEADER = [
  "item_id",
  "query_id",
  "query_lang",
  "query_text",
  "doc_title",
  "doc_lang_guess",
  "label",
  "annotator",
  "notes",
] as const;

/** RFC 4180 benzeri; tirnak icinde satir sonu ve "" desteklenir. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export interface LabelCsvRow {
  item_id: string;
  query_id: string;
  label: string;
  annotator: string;
  notes: string;
}

export function parseLabelCsv(text: string): LabelCsvRow[] {
  const rows = parseCsv(text);
  const header = rows[0] ?? [];
  for (const name of LABEL_CSV_HEADER) {
    if (!header.includes(name)) throw new Error(`CSV basliginda '${name}' yok`);
  }
  const at = (name: string) => header.indexOf(name);
  return rows.slice(1).map((cells) => ({
    item_id: (cells[at("item_id")] ?? "").trim(),
    query_id: (cells[at("query_id")] ?? "").trim(),
    label: (cells[at("label")] ?? "").trim(),
    annotator: (cells[at("annotator")] ?? "").trim(),
    notes: cells[at("notes")] ?? "",
  }));
}

export interface MergeResult {
  items: CandidateItem[];
  applied: number;
  errors: string[];
}

/**
 * Dolu `label` + dolu `annotator` => label_source "human". Bos etiketli satir kaydi degistirmez.
 * Gecersiz etiket, eksik annotator ya da bilinmeyen item hata verir (kayit islenmez).
 */
export function mergeHumanLabels(
  items: readonly CandidateItem[],
  rows: readonly LabelCsvRow[],
): MergeResult {
  const byId = new Map(items.map((item) => [item.item_id, item]));
  const out = new Map(items.map((item) => [item.item_id, { ...item }]));
  const errors: string[] = [];
  let applied = 0;
  for (const row of rows) {
    const item = byId.get(row.item_id);
    if (!item) {
      errors.push(`bilinmeyen item_id ${row.item_id}`);
      continue;
    }
    if (row.query_id !== item.query_id) {
      errors.push(`${row.item_id}: query_id degistirilmis`);
      continue;
    }
    if (row.label === "") continue;
    const value = Number(row.label);
    if (!/^[0-3]$/.test(row.label) || !isLabel(value)) {
      errors.push(`${row.item_id}: etiket 0-3 olmali (${row.label})`);
      continue;
    }
    if (row.annotator === "") {
      errors.push(`${row.item_id}: annotator bos`);
      continue;
    }
    const target = out.get(row.item_id) as CandidateItem;
    target.label_source = "human";
    target.label = value as Label;
    target.annotator = row.annotator;
    applied += 1;
  }
  return { items: [...out.values()], applied, errors };
}
