/**
 * Anlamsal arama cevrimdisi degerlendirme puani (karar 0178, "on" karari icin insan etiketi).
 * Saf: etiketli liste -> yontem basina nDCG@k, P@k, ilgisiz@k. Veritabani/model yok.
 *
 * Etiket: 2 = tam aranan urun, 1 = ilgili (yakin tur/aksesuar istenmisse aksesuar), 0 = ilgisiz.
 * Bos etiket degerlendirmeye girmez (o sorgu-urun cifti etiketlenmemis sayilir).
 */

export const EVAL_METHODS = ["text", "semantic", "hybrid"] as const;
export type EvalMethod = (typeof EVAL_METHODS)[number];

export interface EvalRow {
  query: string;
  productId: number;
  /** Yontem basina 1 tabanli sira; listede yoksa null. */
  ranks: Record<EvalMethod, number | null>;
  label: 0 | 1 | 2 | null;
}

export interface MethodScore {
  method: EvalMethod;
  queries: number;
  ndcg: number;
  precision: number;
  irrelevant: number;
  /** Ortalama donen sonuc (k ile sinirli). */
  returned: number;
}

function dcg(gains: readonly number[]): number {
  return gains.reduce((sum, gain, index) => sum + (2 ** gain - 1) / Math.log2(index + 2), 0);
}

/** Etiketlenmis sorgular uzerinden yontem basina ortalama. Ideal sira tum etiketli havuzdan. */
export function scoreEval(rows: readonly EvalRow[], k = 10): MethodScore[] {
  const byQuery = new Map<string, EvalRow[]>();
  for (const row of rows) {
    if (row.label === null) continue;
    const list = byQuery.get(row.query) ?? [];
    list.push(row);
    byQuery.set(row.query, list);
  }
  return EVAL_METHODS.map((method) => {
    let ndcgSum = 0;
    let precisionSum = 0;
    let irrelevantSum = 0;
    let returnedSum = 0;
    let counted = 0;
    for (const list of byQuery.values()) {
      const ideal = dcg(
        list
          .map((row) => row.label as number)
          .sort((a, b) => b - a)
          .slice(0, k),
      );
      if (ideal === 0) continue; // ilgili urunu olmayan sorgu ortalamaya girmez ("havuzda yok")
      const ranked = list
        .filter((row) => row.ranks[method] !== null && (row.ranks[method] as number) <= k)
        .sort((a, b) => (a.ranks[method] as number) - (b.ranks[method] as number));
      const gains = new Array<number>(k).fill(0);
      for (const row of ranked) gains[(row.ranks[method] as number) - 1] = row.label as number;
      ndcgSum += dcg(gains) / ideal;
      precisionSum += ranked.filter((row) => (row.label as number) >= 1).length / k;
      irrelevantSum +=
        ranked.length === 0 ? 0 : ranked.filter((row) => row.label === 0).length / ranked.length;
      returnedSum += ranked.length;
      counted += 1;
    }
    const avg = (value: number) =>
      counted === 0 ? 0 : Math.round((value / counted) * 1000) / 1000;
    return {
      method,
      queries: counted,
      ndcg: avg(ndcgSum),
      precision: avg(precisionSum),
      irrelevant: avg(irrelevantSum),
      returned: avg(returnedSum),
    };
  });
}

const HEADER = [
  "query",
  "product_id",
  "title",
  "text_rank",
  "semantic_rank",
  "hybrid_rank",
  "similarity",
  "label",
];

function csvCell(value: string | number | null): string {
  if (value === null) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export interface EvalCsvRow extends Omit<EvalRow, "label"> {
  title: string;
  similarity: number | null;
}

export function toEvalCsv(rows: readonly EvalCsvRow[]): string {
  const lines = [HEADER.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.query,
        row.productId,
        row.title,
        row.ranks.text,
        row.ranks.semantic,
        row.ranks.hybrid,
        row.similarity === null ? null : Math.round(row.similarity * 1000) / 1000,
        null,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

/** RFC 4180 benzeri satir ayristirici (tirnakli alan, ic tirnak ""). */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

export function parseEvalCsv(text: string): EvalRow[] {
  const lines = text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");
  const header = parseCsvLine(lines[0] ?? "");
  const at = (name: string) => {
    const index = header.indexOf(name);
    if (index < 0) throw new Error(`CSV basliginda '${name}' yok`);
    return index;
  };
  const cols = {
    query: at("query"),
    id: at("product_id"),
    text: at("text_rank"),
    semantic: at("semantic_rank"),
    hybrid: at("hybrid_rank"),
    label: at("label"),
  };
  const rank = (value: string | undefined) =>
    value === undefined || value.trim() === "" ? null : Number(value);
  return lines.slice(1).map((line, index) => {
    const cells = parseCsvLine(line);
    const raw = (cells[cols.label] ?? "").trim();
    if (raw !== "" && !["0", "1", "2"].includes(raw)) {
      throw new Error(`satir ${index + 2}: etiket 0, 1, 2 ya da bos olmali`);
    }
    return {
      query: cells[cols.query] ?? "",
      productId: Number(cells[cols.id]),
      ranks: {
        text: rank(cells[cols.text]),
        semantic: rank(cells[cols.semantic]),
        hybrid: rank(cells[cols.hybrid]),
      },
      label: raw === "" ? null : (Number(raw) as 0 | 1 | 2),
    };
  });
}
