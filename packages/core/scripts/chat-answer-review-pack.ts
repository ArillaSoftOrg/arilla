/**
 * Faz 7 pilotu insan denetim paketi (karar 0203/0211). Ağ ve model YOK; yalnız dosya okur/yazar.
 *
 * Paket üret:
 *   pnpm --filter @arilla/core eval:chat-answer-review --audit <audit.json> --out <klasör>
 *     -> review-pack.md (ürün gerçekleri + cevap + otomatik sonuçlar) ve review-sheet.csv
 *        (BOŞ karar sütunları: human_verdict, human_notes).
 *
 * Doldurulmuş tabloyu denetim dosyasına işle (bilinmeyen vaka ya da geçersiz karar varsa HİÇBİR ŞEY yazılmaz):
 *   pnpm --filter @arilla/core eval:chat-answer-review --apply <review-sheet.csv> --audit <audit.json>
 *   pnpm --filter @arilla/core eval:chat-answer --summarize <audit.json>
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AuditFile,
  applyReviewCsv,
  buildReviewItems,
  renderReviewCsv,
  renderReviewMarkdown,
} from "../src/eval/chat-answer-review-pack.ts";

function flag(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

const auditPath = flag("--audit");
if (!auditPath) {
  console.error("--audit <audit.json> gerekli");
  process.exit(2);
}
const audit = JSON.parse(readFileSync(auditPath, "utf8")) as AuditFile;

const applyPath = flag("--apply");
if (applyPath) {
  const report = applyReviewCsv(audit, readFileSync(applyPath, "utf8"));
  if (report.errors.length > 0) {
    console.error(`HATA (${report.errors.length}); hiçbir şey yazılmadı:`);
    for (const error of report.errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  writeFileSync(auditPath, `${JSON.stringify(audit, null, 2)}\n`);
  console.log(`işlendi: ${report.applied} karar, ${report.blank} satır boş (denetlenmedi)`);
} else {
  const out = flag("--out");
  if (!out) {
    console.error("--out <klasör> gerekli");
    process.exit(2);
  }
  const items = buildReviewItems(audit);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "review-pack.md"), renderReviewMarkdown(items, audit.meta));
  writeFileSync(join(out, "review-sheet.csv"), renderReviewCsv(items));
  console.log(`paket yazıldı: ${items.length} kabul edilmiş cevap -> ${out}`);
}
