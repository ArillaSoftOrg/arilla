/** Karar 0174 (PR1b): iş sonucunun Türkçe etiketleri ve satır içi gösterimi. */
import { type RunOutcome, runOutcome } from "@arilla/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OutcomeText } from "./admin-ui.tsx";
import {
  formatJobDetail,
  jobOutcomeLabel,
  jobOutcomeReasonLabel,
  LEGACY_OUTCOME_NOTE,
  pipelineOutcomeText,
  pipelineReasonText,
} from "./format.ts";

const html = (status: string, outcome: RunOutcome) =>
  renderToStaticMarkup(createElement(OutcomeText, { status, outcome }));

describe("jobOutcomeLabel", () => {
  it.each([
    ["completed", "success", "tamamlandı"],
    ["no_input", "success", "çalıştı — uygun girdi bulunamadı"],
    ["skipped_locked", "partial", "atlandı — başka koşu sürüyordu"],
    ["partial", "partial", "kısmi — öğe hataları var"],
    ["failed", "failed", "başarısız"],
    ["blocked_upstream", "partial", "engellendi — önceki aşamanın çıktısı eksik"],
  ])("%s → %s", (outcome, status, label) => {
    expect(jobOutcomeLabel(runOutcome(status, { outcome }), status)).toBe(label);
  });

  it("eski biçim status etiketini kullanır; bozuk sonuç açıkça geçersiz", () => {
    expect(jobOutcomeLabel(runOutcome("success", {}), "success")).toBe("başarılı");
    expect(jobOutcomeLabel(runOutcome("partial", {}), "partial")).toBe("kısmi");
    expect(jobOutcomeLabel(runOutcome("success", { outcome: "x" }), "success")).toBe(
      "geçersiz sonuç kaydı",
    );
  });

  it("gerekçe etiketleri; bilinmeyen kod olduğu gibi", () => {
    expect(jobOutcomeReasonLabel("lock_busy")).toBe("eşleştirme kilidi başka koşuda");
    expect(jobOutcomeReasonLabel("no_embeddings")).toBe("vektör (embedding) yok");
    expect(jobOutcomeReasonLabel("new_reason")).toBe("new_reason");
    expect(jobOutcomeReasonLabel(null)).toBeNull();
  });

  it("etiketlerde büyük harf dönüşümü yok", () => {
    for (const outcome of ["completed", "no_input", "skipped_locked", "blocked_upstream"]) {
      const label = jobOutcomeLabel(runOutcome("success", { outcome }), "success");
      expect(label).toBe(label.toLocaleLowerCase("tr-TR"));
    }
  });
});

describe("OutcomeText", () => {
  it("eski biçim: status etiketi + 'Sonuç kaydı yok' notu", () => {
    const out = html("success", runOutcome("success", { considered: 1 }));
    expect(out).toContain("başarılı");
    expect(out).toContain(LEGACY_OUTCOME_NOTE);
    expect(LEGACY_OUTCOME_NOTE).toBe("Sonuç kaydı yok");
  });

  it("sonuç + gerekçe; durum renkleri tona göre", () => {
    const blocked = html(
      "partial",
      runOutcome("partial", { outcome: "blocked_upstream", reason: "no_embeddings" }),
    );
    expect(blocked).toContain("engellendi — önceki aşamanın çıktısı eksik");
    expect(blocked).toContain("vektör (embedding) yok");
    expect(blocked).not.toContain(LEGACY_OUTCOME_NOTE);

    const cls = (s: string) => /class="([^"]*)"/.exec(s)?.[1] ?? "";
    const completed = cls(html("success", runOutcome("success", { outcome: "completed" })));
    const noInput = cls(html("success", runOutcome("success", { outcome: "no_input" })));
    const skipped = cls(html("partial", runOutcome("partial", { outcome: "skipped_locked" })));
    const failed = cls(html("failed", runOutcome("failed", { outcome: "failed" })));
    const invalid = cls(html("success", runOutcome("success", { outcome: "bogus" })));
    // Başarı ve bilgi aynı nötr ton; atlanan uyarı; başarısız ve bozuk aynı hata tonu.
    expect(noInput).toBe(completed);
    expect(skipped).not.toBe(completed);
    expect(failed).not.toBe(completed);
    expect(failed).not.toBe(skipped);
    expect(invalid).toBe(failed);
    // Eski biçimin rengi StatusText ile aynı kalır (başarısız = hata tonu).
    expect(cls(html("failed", runOutcome("failed", {})))).toBe(failed);
  });
});

describe("formatJobDetail", () => {
  it("geçerli sonuçta outcome/reason tekrar edilmez; sayaçlar kalır", () => {
    const detail = { outcome: "no_input", reason: "no_eligible_offers", considered: 0 };
    const text = formatJobDetail(detail, runOutcome("success", detail));
    expect(text).toBe("considered 0");
  });

  it("bozuk sonuçta ham değer teşhis için gösterilir; sonuç verilmezse eski davranış", () => {
    const detail = { outcome: "bogus", visual_edges: 1200 };
    expect(formatJobDetail(detail, runOutcome("success", detail))).toBe(
      "outcome bogus · visual_edges 1.200",
    );
    expect(formatJobDetail({ outcome: "completed", n: 1 })).toBe("outcome completed · n 1");
    expect(formatJobDetail({})).toBe("—");
  });
});

describe("boru hattı metinleri", () => {
  it("son koşu sonucu ve son çıktı; çıktı sayacı olmayan aşamada son çıktı yok", () => {
    expect(pipelineOutcomeText("edges", "blocked_upstream", null)).toBe(
      "son koşu: engellendi — önceki aşamanın çıktısı eksik · son çıktı: kanıt yok",
    );
    expect(pipelineOutcomeText("enrich", "legacy", null)).toBe("son koşu: Sonuç kaydı yok");
    expect(pipelineOutcomeText("resolve", "no_input", new Date("2026-11-08T02:31:00Z"))).toMatch(
      /^son koşu: çalıştı — uygun girdi bulunamadı · son çıktı: \S+ 05:31$/,
    );
  });

  it("yeni neden kodları Türkçe", () => {
    expect(pipelineReasonText("job_blocked_upstream")).toBe(
      "son koşu engellendi: önceki aşamanın çıktısı eksik",
    );
    expect(pipelineReasonText("job_invalid_outcome")).toBe("son koşu geçersiz sonuç kaydetti");
  });
});
