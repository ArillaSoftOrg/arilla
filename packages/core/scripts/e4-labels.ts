/** E4 etiket yardimcilari (AI on degerlendirme puanlari + kor anahtar). */
import { readFileSync } from "node:fs";

export function csvRows(path: string): Record<string, string>[] {
  const text = readFileSync(path, "utf8").replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) rows.push([...row, cell]);
  const [head = [], ...body] = rows.filter((r) => r.length > 1);
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

export function loadLabels(scoresPath: string, keyPath: string): Map<string, number> {
  const scores = new Map(csvRows(scoresPath).map((r) => [r.item_id, Number(r.oneri_puan_0_3)]));
  const out = new Map<string, number>();
  for (const k of csvRows(keyPath)) {
    const s = scores.get(k.item_id ?? "");
    if (s !== undefined) out.set(`${k.query_id}:${k.product_id}`, s);
  }
  return out;
}
