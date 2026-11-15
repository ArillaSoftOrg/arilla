/**
 * Faz 7 pilotu: İNSAN denetim paketi (karar 0203/0211). Saf fonksiyonlar: dosya, ağ, model yok.
 *
 * Paket yalnız kabul edilmiş (doğrulayıcıdan geçmiş) cevapları; dayandıkları ürün gerçekleri,
 * otomatik sonuçlar ve BOŞ insan karar alanlarıyla birlikte sunar. Hiçbir karar üretilmez:
 * `human_verdict` her zaman boş başlar; otomatik/AI sonuçlar ayrı sütunlardadır ve insan onayı değildir.
 */
import { type ResultFact, validateAnswer } from "../chat/answer.ts";
import { REVIEW_VERDICTS, type ReviewVerdict } from "./chat-answer-pilot.ts";
import { factsForCase, PILOT_CASES, type PilotCase } from "./chat-answer-pilot-cases.ts";

interface AuditRecord {
  id: string;
  caseId?: string;
  type: string;
  category: string;
  expect: string;
  query: string;
  question: string;
  action: string | null;
  validated: boolean | null;
  shownText: string | null;
  paragraphs: { text: string; evidence: { item: string; field: string; quote: string }[] }[];
  rawParagraphs?: {
    text: string;
    evidence: { item: string; field: string; quote: string }[];
    problem: string | null;
  }[];
  autoFlags: string[];
  review: { verdict: ReviewVerdict | null; notes: string };
}

export interface AuditFile {
  meta: Record<string, unknown>;
  records: AuditRecord[];
  [key: string]: unknown;
}

export interface ReviewItem {
  n: number;
  id: string;
  type: string;
  category: string;
  expect: string;
  query: string;
  question: string;
  /** Cevabın dayandığı ürün gerçekleri (modele giden `result_facts`). */
  facts: ResultFact[];
  shownText: string;
  paragraphs: AuditRecord["paragraphs"];
  /** Modelin yazıp doğrulayıcının attığı paragraflar (nedeniyle): denetçi için bağlam. */
  discardedParagraphs: { text: string; problem: string }[];
  mustNotClaim: string[];
  forbiddenPatterns: string[];
  /** OTOMATİK sonuçlar; insan onayı DEĞİLDİR. */
  auto: {
    runTimeFlags: string[];
    currentValidator: "valid" | "rejected";
    currentValidatorReasons: string[];
  };
  /** İnsan karar alanları: HER ZAMAN boş başlar. */
  human: { verdict: null; notes: string };
}

const caseById = new Map<string, PilotCase>(PILOT_CASES.map((c) => [c.id, c]));

/** Kabul edilmiş cevaplar için denetim kalemleri (sıra: kayıt sırası). */
export function buildReviewItems(audit: AuditFile): ReviewItem[] {
  const items: ReviewItem[] = [];
  for (const record of audit.records) {
    if (record.action !== "answer" || record.validated !== true) continue;
    const testCase = caseById.get(record.caseId ?? record.id);
    if (!testCase) throw new Error(`audit record ${record.id}: unknown case`);
    const facts = factsForCase(testCase);
    const raw = {
      paragraphs: (record.rawParagraphs ?? []).map((p) => ({ text: p.text, evidence: p.evidence })),
    };
    const verdict = validateAnswer(raw, facts, { question: record.question });
    items.push({
      n: items.length + 1,
      id: record.id,
      type: record.type,
      category: record.category,
      expect: record.expect,
      query: record.query,
      question: record.question,
      facts,
      shownText: record.shownText ?? "",
      paragraphs: record.paragraphs,
      discardedParagraphs: (record.rawParagraphs ?? [])
        .filter((p) => p.problem !== null)
        .map((p) => ({ text: p.text, problem: p.problem as string })),
      mustNotClaim: testCase.mustNotClaim,
      forbiddenPatterns: testCase.forbiddenPatterns,
      auto: {
        runTimeFlags: record.autoFlags,
        currentValidator: verdict.answer ? "valid" : "rejected",
        currentValidatorReasons: verdict.rejected,
      },
      human: { verdict: null, notes: "" },
    });
  }
  return items;
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const cell = (text: string | number | null) => oneLine(String(text ?? "-")).replace(/\|/g, "\\|");

export function renderReviewMarkdown(
  items: readonly ReviewItem[],
  meta: { runId?: unknown; model?: unknown },
): string {
  const lines: string[] = [];
  lines.push("# Faz 7 insan denetim paketi");
  lines.push("");
  lines.push(
    `Koşu: \`${String(meta.runId ?? "?")}\` · model: \`${String(meta.model ?? "?")}\` · kabul edilmiş cevap: **${items.length}**`,
  );
  lines.push("");
  lines.push(
    '> **Bu dosyada hiçbir insan kararı yoktur.** "Otomatik" bölümleri doğrulayıcı ve bayrak sonuçlarıdır; insan onayı DEĞİLDİR. Karar alanları boştur ve yalnız denetçi tarafından doldurulur.',
  );
  lines.push("");
  lines.push("## Nasıl denetlenir");
  lines.push("");
  lines.push(
    "1. Her cevap için yalnız **ürün gerçekleri** tablosuna bakın: cevaptaki her olgu bu tabloda yazan başlık, marka, mağaza, TL fiyat, teklif sayısından çıkmalı.",
  );
  lines.push(
    "2. Karar (`review-sheet.csv` içindeki `human_verdict`): `correct` (yalnız verilen veriden doğru ve soruyla ilgili), `unevidenced_claim` (tabloda olmayan nitelik, amaç, üstünlük ya da özellik), `wrong` (tabloyla çelişen olgu), `off_intent` (sorulan şeye cevap değil).",
  );
  lines.push(
    "3. Kritik = `unevidenced_claim` + `wrong`. Hedef: ≥100 denetlenen cevapta 0 kritik. Notları `human_notes` alanına yazın.",
  );
  lines.push(
    "4. Doldurduktan sonra: `pnpm --filter @arilla/core eval:chat-answer-review --apply review-sheet.csv --audit audit.json` ve ardından `eval:chat-answer --summarize audit.json`.",
  );
  lines.push("");
  for (const item of items) {
    lines.push(`## ${item.n}. ${item.id} · ${item.type} · beklenti: ${item.expect}`);
    lines.push("");
    lines.push(`- Önceki arama: ${cell(item.query)}`);
    lines.push(`- Kullanıcı sorusu: ${cell(item.question)}`);
    lines.push("");
    lines.push("| # | Başlık | Marka | Mağaza | Fiyat (TL) | Teklif |");
    lines.push("|---|---|---|---|---|---|");
    for (const fact of item.facts) {
      lines.push(
        `| ${fact.id} | ${cell(fact.title)} | ${cell(fact.brand)} | ${cell(fact.store)} | ${cell(fact.price_try)} | ${cell(fact.offer_count)} |`,
      );
    }
    lines.push("");
    lines.push("**Gösterilen cevap:**");
    lines.push("");
    for (const paragraph of item.shownText.split(/\n+/)) lines.push(`> ${paragraph}`);
    lines.push("");
    if (item.paragraphs.length > 0) {
      lines.push("Delil alıntıları:");
      for (const [i, paragraph] of item.paragraphs.entries()) {
        const quotes = paragraph.evidence
          .map((e) => `${e.item}.${e.field}=“${cell(e.quote)}”`)
          .join("; ");
        lines.push(`- P${i + 1}: ${quotes || "-"}`);
      }
      lines.push("");
    }
    if (item.mustNotClaim.length > 0) {
      lines.push(`GÖRÜLMEMESİ gereken iddialar: ${item.mustNotClaim.map(cell).join(" · ")}`);
      lines.push("");
    }
    if (item.discardedParagraphs.length > 0) {
      lines.push(
        `Doğrulayıcının attığı paragraflar (kullanıcıya gitmedi): ${item.discardedParagraphs.map((d) => `[${d.problem}] ${cell(d.text)}`).join(" || ")}`,
      );
      lines.push("");
    }
    lines.push(
      `Otomatik (insan onayı DEĞİL): koşu bayrakları ${item.auto.runTimeFlags.length ? item.auto.runTimeFlags.map((f) => `\`${f}\``).join(", ") : "yok"} · güncel doğrulayıcı: **${item.auto.currentValidator}**${item.auto.currentValidatorReasons.length ? ` (${item.auto.currentValidatorReasons.join(", ")})` : ""}`,
    );
    lines.push("");
    lines.push(
      "İnsan kararı: [ ] correct  [ ] unevidenced_claim  [ ] wrong  [ ] off_intent  · not: ",
    );
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// CSV (elektronik tablo)
// ---------------------------------------------------------------------------

const CSV_COLUMNS = [
  "n",
  "case_id",
  "type",
  "expect",
  "question",
  "shown_text",
  "auto_run_flags",
  "auto_current_validator",
  "human_verdict",
  "human_notes",
] as const;

function csvField(value: string | number): string {
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Excel'in UTF-8'i tanıması için BOM'lu; `human_verdict` ve `human_notes` BOŞ. */
export function renderReviewCsv(items: readonly ReviewItem[]): string {
  const rows = [CSV_COLUMNS.join(",")];
  for (const item of items) {
    rows.push(
      [
        item.n,
        item.id,
        item.type,
        item.expect,
        oneLine(item.question),
        oneLine(item.shownText),
        item.auto.runTimeFlags.join(" "),
        item.auto.currentValidator,
        "",
        "",
      ]
        .map(csvField)
        .join(","),
    );
  }
  return `﻿${rows.join("\r\n")}\r\n`;
}

/** RFC 4180 ayrıştırıcı (tırnaklı alan, çift tırnak kaçışı, alan içi satır sonu). */
export function parseCsv(text: string): string[][] {
  const input = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cellValue) => cellValue !== ""));
}

export interface ApplyReport {
  applied: number;
  /** Boş bırakılan (henüz denetlenmemiş) satırlar. */
  blank: number;
  errors: string[];
}

/**
 * Doldurulmuş CSV'deki kararları `audit` kayıtlarına yazar. Yalnız `REVIEW_VERDICTS` içindeki değerler
 * kabul edilir; bilinmeyen vaka ya da geçersiz karar HATA olarak raporlanır ve o satır UYGULANMAZ.
 * Boş karar boş kalır (karar uydurulmaz).
 */
export function applyReviewCsv(audit: AuditFile, csv: string): ApplyReport {
  const rows = parseCsv(csv);
  const header = rows[0] ?? [];
  const idCol = header.indexOf("case_id");
  const verdictCol = header.indexOf("human_verdict");
  const notesCol = header.indexOf("human_notes");
  const report: ApplyReport = { applied: 0, blank: 0, errors: [] };
  if (idCol < 0 || verdictCol < 0) {
    report.errors.push("CSV başlığında case_id ve human_verdict sütunları gerekli");
    return report;
  }
  const byId = new Map(audit.records.map((r) => [r.id, r]));
  for (const row of rows.slice(1)) {
    const id = (row[idCol] ?? "").trim();
    const verdict = (row[verdictCol] ?? "").trim();
    const record = byId.get(id);
    if (!record) {
      report.errors.push(`bilinmeyen vaka: ${id}`);
      continue;
    }
    if (verdict === "") {
      report.blank++;
      continue;
    }
    if (!(REVIEW_VERDICTS as readonly string[]).includes(verdict)) {
      report.errors.push(`${id}: geçersiz karar "${verdict}"`);
      continue;
    }
    record.review = {
      verdict: verdict as ReviewVerdict,
      notes: notesCol >= 0 ? (row[notesCol] ?? "").trim() : "",
    };
    report.applied++;
  }
  return report;
}
