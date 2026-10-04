/** Karar 0055: işletim bulgularının önem kuralları (saf). */
import { describe, expect, it } from "vitest";
import type { JobLastRun, JobRunSummary } from "./job-runs.ts";
import type { MerchantAttentionItem } from "./merchant-attention.ts";
import type { CostWindow, PartitionHealth } from "./operations.ts";
import {
  complianceFindings,
  costFindings,
  dashboardAttention,
  jobRunFindings,
  linkQueueFinding,
  matchingBacklogFinding,
  merchantFindings,
  needsAttention,
  partitionFindings,
  pipelineFindings,
} from "./ops-findings.ts";
import {
  evaluatePipeline,
  type PipelineRawEvidence,
  stageRunEvidence,
} from "./pipeline-evidence.ts";

const NOW = new Date("2026-10-03T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const ok = <T>(value: T) => ({ ok: true as const, value });
const fail = { ok: false as const, error: "Zaman aşımı" };

const severities = (list: { key: string; severity: string }[]) =>
  Object.fromEntries(list.map((f) => [f.key, f.severity]));

function partitions(overrides: Partial<PartitionHealth> = {}): PartitionHealth {
  return { ranges: [], hasDefault: true, monthsAhead: 4, gaps: [], uncoveredRows: 0, ...overrides };
}

describe("partitionFindings", () => {
  it("sağlıklı / kapsanmayan satır kritik / az ileri ay uyarı / bu ay yok kritik / hata bilinmiyor", () => {
    expect(partitionFindings(ok(partitions()), NOW).map((f) => f.severity)).toEqual(["healthy"]);
    expect(severities(partitionFindings(ok(partitions({ uncoveredRows: 3 })), NOW))).toEqual({
      "ops.partitions.default": "critical",
    });
    expect(severities(partitionFindings(ok(partitions({ monthsAhead: 1 })), NOW))).toEqual({
      "ops.partitions.ahead": "warning",
    });
    expect(severities(partitionFindings(ok(partitions({ monthsAhead: -1 })), NOW))).toEqual({
      "ops.partitions.ahead": "critical",
    });
    expect(partitionFindings(fail, NOW)[0]?.severity).toBe("unknown");
  });
});

function merchant(overrides: Partial<MerchantAttentionItem>): MerchantAttentionItem {
  return {
    merchantId: 1,
    merchantName: "Mağaza",
    merchantSlug: "magaza",
    states: [],
    lastRun: { status: "failed", startedAt: ago(HOUR) },
    lastGoodAt: null,
    failuresSinceSuccess: 1,
    ...overrides,
  };
}

describe("merchantFindings", () => {
  it("tek başarısızlık bilgi, üst üste başarısızlık uyarı (ops.md eşiği 2)", () => {
    const out = severities(
      merchantFindings(
        [
          merchant({ merchantId: 1, states: ["failed"], failuresSinceSuccess: 1 }),
          merchant({ merchantId: 2, states: ["failed"], failuresSinceSuccess: 3 }),
        ],
        NOW,
      ),
    );
    expect(out).toEqual({
      "merchants.failed_once": "info",
      "merchants.failed_repeatedly": "warning",
    });
  });

  it("takılı, para birimi, hiç toplanmamış ve bayat uyarıdır; tek mağaza kendi sayfasına bağlanır", () => {
    const out = merchantFindings(
      [merchant({ states: ["stuck", "currency_unverified", "never_ran", "stale"] })],
      NOW,
    );
    expect(out.every((f) => f.severity === "warning")).toBe(true);
    expect(out.find((f) => f.key === "merchants.never_ran")?.href).toBe(
      "/yonetim/magazalar/magaza",
    );
  });

  it("sorun yoksa tek sağlıklı bulgu", () => {
    expect(merchantFindings([], NOW).map((f) => f.severity)).toEqual(["healthy"]);
  });
});

function job(name: string, lastRun: Partial<JobLastRun["lastRun"]> | null, extra = {}): JobLastRun {
  return {
    job: name,
    lastRun: lastRun
      ? {
          id: Math.floor(Math.random() * 1e9),
          job: name,
          trigger: "cron",
          status: "success",
          startedAt: ago(HOUR),
          finishedAt: ago(HOUR - 1000),
          durationMs: 1000,
          detail: {},
          errorSummary: null,
          ...lastRun,
        }
      : null,
    lastGoodAt: ago(HOUR),
    failuresSinceGood: 0,
    ...extra,
  };
}

describe("jobRunFindings", () => {
  it("gecikmiş cron uyarı; hiç kaydı olmayan cron bilgi; aşama işinin başarısızlığı tekrar edilmez", () => {
    const summary: JobRunSummary = {
      jobs: [
        job("cleanup_auth", { startedAt: ago(40 * HOUR) }),
        job("trigger_alerts", null),
        job("resolve", { status: "failed" }),
        job("marketing_campaigns", { status: "failed", errorSummary: "Error: smtp" }),
      ],
      stuck: [],
    };
    expect(severities(jobRunFindings(ok(summary), NOW))).toEqual({
      "jobs.cleanup_auth.overdue": "warning",
      "jobs.marketing_campaigns.failed": "warning",
      "jobs.no_record": "info",
    });
  });

  it("son koşusu takılı iş uyarı; sonradan yeniden çalışmış işin eski açık koşusu bilgi", () => {
    const latest = job("trigger_alerts", { id: 7, status: "running", startedAt: ago(3 * HOUR) });
    const summary: JobRunSummary = {
      jobs: [latest, job("discovery_slots", { id: 8 })],
      stuck: [
        { id: 7, job: "trigger_alerts", startedAt: ago(3 * HOUR) },
        { id: 3, job: "discovery_slots", startedAt: ago(30 * HOUR) },
      ],
    };
    const out = severities(jobRunFindings(ok(summary), NOW));
    expect(out["jobs.stuck"]).toBe("warning");
    expect(out["jobs.stuck_old"]).toBe("info");
  });

  it("okunamazsa bilinmiyor", () => {
    expect(jobRunFindings(fail, NOW)[0]?.severity).toBe("unknown");
  });
});

function raw(overrides: Partial<PipelineRawEvidence> = {}): PipelineRawEvidence {
  return {
    collect: { lastStartedAt: ago(HOUR), lastGoodAt: ago(HOUR), stuckRuns: 0 },
    resolve: { lastAt: ago(2 * HOUR) },
    prices: { lastAt: ago(HOUR / 4) },
    enrich: { lastAt: ago(HOUR / 2) },
    edges: { lastAt: ago(HOUR / 4) },
    link: { lastFinishedAt: null, stuckProcessing: 0, oldestQueuedAt: null },
    ...overrides,
  };
}

describe("boru hattı: job_run önceliği", () => {
  it("iş koşusu varsa zaman oradan okunur; yoksa veri zamanına düşülür", () => {
    // Veri eşleştirmeyi geride gösteriyor; ama eşleştirme işi toplamadan sonra çalıştı.
    const runs = stageRunEvidence([
      job(
        "resolve",
        { status: "success", startedAt: ago(HOUR / 2) },
        { lastGoodAt: ago(HOUR / 3) },
      ),
    ]);
    const views = evaluatePipeline(raw({ runs }), NOW);
    const resolve = views.find((v) => v.stage === "resolve");
    expect(resolve).toMatchObject({ state: "ok", source: "job_run" });
    expect(views.find((v) => v.stage === "enrich")?.source).toBe("data");
    // Kayıt yokken aynı veri "geride olabilir" (bilgi) olur — abartılmaz.
    const fallback = evaluatePipeline(raw(), NOW).find((v) => v.stage === "resolve");
    expect(fallback?.state).toBe("behind");
    expect(pipelineFindings(fallback ? [fallback] : [], NOW)[0]?.severity).toBe("info");
  });

  it("aşamanın son koşusu başarısız ya da takılıysa uyarı", () => {
    const failed = evaluatePipeline(
      raw({ runs: stageRunEvidence([job("enrich", { status: "failed" })]) }),
      NOW,
    ).find((v) => v.stage === "enrich");
    expect(failed).toMatchObject({ state: "warning", reasons: ["job_failed"] });
    const stuck = evaluatePipeline(
      raw({
        runs: stageRunEvidence([
          job("similarity", { status: "running", startedAt: ago(3 * HOUR) }),
        ]),
      }),
      NOW,
    );
    expect(stuck.find((v) => v.stage === "edges")?.reasons).toEqual(["job_stuck"]);
    expect(stuck.find((v) => v.stage === "prices")?.reasons).toEqual(["job_stuck"]);
  });

  it("okunamayan aşama bilinmiyor; hiç isteği olmayan link işçisi sağlıklı", () => {
    const views = evaluatePipeline(raw({ edges: null }), NOW);
    const out = severities(pipelineFindings(views, NOW));
    expect(out["pipeline.edges"]).toBe("unknown");
    expect(out["pipeline.link"]).toBe("healthy");
  });
});

describe("tekil denetimler", () => {
  it("ham görsel kritik, temizlik birikimi uyarı", () => {
    expect(
      severities(
        complianceFindings(
          ok({ imagePurgeOverdue: 1, expiredLoginTokens: 2, expiredPhoneCodes: 0 }),
          NOW,
        ),
      ),
    ).toEqual({
      "ops.compliance.raw_images": "critical",
      "ops.compliance.cleanup_backlog": "warning",
    });
  });

  it("maliyet: 24 saat haftalık ortalamanın 3 katını aşarsa uyarı; fiyatlanmamış çağrı bilgi", () => {
    const window = (calls24: number, prev: number, unpriced = 0): CostWindow => ({
      last24h: { calls: calls24, costMicros: 0, unpricedCalls: unpriced },
      previous7d: { calls: prev, costMicros: 0, unpricedCalls: 0 },
    });
    expect(costFindings(ok(window(400, 7 * 100)), NOW).map((f) => f.key)).toEqual([
      "ops.cost.spike",
    ]);
    expect(costFindings(ok(window(250, 7 * 100)), NOW).map((f) => f.severity)).toEqual(["healthy"]);
    // Küçük sayılarda gürültü: 40 çağrı, önceki hafta 0 → sapma değil.
    expect(costFindings(ok(window(40, 0)), NOW).map((f) => f.severity)).toEqual(["healthy"]);
    expect(severities(costFindings(ok(window(10, 70, 10)), NOW))).toEqual({
      "ops.cost.unpriced": "info",
    });
    expect(costFindings(fail, NOW)[0]?.severity).toBe("unknown");
  });

  it("eşleştirme kuyruğu 500 eşiği; link kuyruğu okunamazsa bilinmiyor", () => {
    expect(matchingBacklogFinding(501, NOW).severity).toBe("warning");
    expect(matchingBacklogFinding(500, NOW).severity).toBe("healthy");
    expect(linkQueueFinding(fail, NOW).severity).toBe("unknown");
    expect(linkQueueFinding(ok(101), NOW).severity).toBe("warning");
  });
});

describe("dashboardAttention", () => {
  it("moderatör listesi yalnızca mağaza, boru hattı ve kuyruk; sağlıklı ve bilgi dahil değil", () => {
    const list = dashboardAttention({
      now: NOW,
      merchants: [merchant({ states: ["stale"] })],
      pipeline: evaluatePipeline(raw(), NOW),
      pendingMatches: 600,
      ops: null,
    });
    expect(list.map((f) => f.key).sort()).toEqual(["matching.backlog", "merchants.stale"]);
    expect(needsAttention(list)).toEqual(list);
  });
});
