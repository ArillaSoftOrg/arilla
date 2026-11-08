/** Karar 0055: işletim bulgularının önem kuralları (saf). */
import { describe, expect, it } from "vitest";
import { runOutcome } from "./job-outcome.ts";
import type { JobLastRun, JobRunRow, JobRunSummary } from "./job-runs.ts";
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

type RunInput = Partial<Omit<JobRunRow, "outcome">>;

function job(name: string, lastRun: RunInput | null, extra: Partial<JobLastRun> = {}): JobLastRun {
  const run = lastRun
    ? {
        id: Math.floor(Math.random() * 1e9),
        job: name,
        trigger: "cron" as const,
        status: "success" as const,
        startedAt: ago(HOUR),
        finishedAt: ago(HOUR - 1000),
        durationMs: 1000,
        detail: {},
        errorSummary: null,
        ...lastRun,
      }
    : null;
  const lastGoodAt = extra.lastGoodAt === undefined ? ago(HOUR) : extra.lastGoodAt;
  return {
    job: name,
    // Sonuç gerçek okuyucudaki gibi status + detail'den türetilir.
    lastRun: run ? { ...run, outcome: runOutcome(run.status, run.detail) } : null,
    lastGoodAt,
    lastRanAt: lastGoodAt,
    lastAttemptAt: null,
    lastProducedAt: null,
    producedAt: {},
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

  it("VPS zamanlayıcılı Python işi: gecikme uyarısı systemd'yi, cron işi cron konteynerini gösterir", () => {
    const summary: JobRunSummary = {
      jobs: [
        job("resolve", { startedAt: ago(31 * HOUR) }),
        job("similarity_edges", { startedAt: ago(20 * HOUR) }),
        job("price_verify", { startedAt: ago(4 * HOUR) }),
        job("fx_rates", null),
        job("discovery_slots", { startedAt: ago(31 * HOUR) }),
      ],
      stuck: [],
    };
    const out = jobRunFindings(ok(summary), NOW);
    expect(severities(out)).toEqual({
      "jobs.resolve.overdue": "warning",
      "jobs.price_verify.overdue": "warning",
      "jobs.discovery_slots.overdue": "warning",
      "jobs.no_record": "info",
    });
    const action = (key: string) => out.find((f) => f.key === key)?.action ?? "";
    expect(action("jobs.resolve.overdue")).toContain("batch-timers");
    expect(action("jobs.discovery_slots.overdue")).toContain("cron");
    expect(action("jobs.discovery_slots.overdue")).not.toContain("batch-timers");
    expect(out.find((f) => f.key === "jobs.no_record")?.evidence).toContain("Döviz kuru");
  });

  it("günlük fiyat tazeleme: 36 saatten eskiyse gecikmiş; yönlendirme batch-timers'a değil feeds-timers'a (karar 0145)", () => {
    const late = jobRunFindings(
      ok({ jobs: [job("feed_daily", { startedAt: ago(37 * HOUR) })], stuck: [] }),
      NOW,
    );
    expect(severities(late)).toEqual({ "jobs.feed_daily.overdue": "warning" });
    const action = late.find((f) => f.key === "jobs.feed_daily.overdue")?.action ?? "";
    expect(action).toContain("feeds-timers");
    expect(action).not.toContain("batch-timers install");
    // Günde iki tetikten biri kaçsa (en çok ~12 saat) uyarı yok.
    const fine = jobRunFindings(
      ok({ jobs: [job("feed_daily", { startedAt: ago(14 * HOUR) })], stuck: [] }),
      NOW,
    );
    expect(severities(fine)).toEqual({ jobs: "healthy" });
  });

  it("okunamazsa bilinmiyor", () => {
    expect(jobRunFindings(fail, NOW)[0]?.severity).toBe("unknown");
  });

  it("skipped_locked gecikmeyi sıfırlamaz: son koşu yeni ama atlandı, son gerçek deneme 31 saat önce", () => {
    const skipped = { outcome: "skipped_locked", reason: "lock_busy" };
    const late = jobRunFindings(
      ok({
        jobs: [
          job(
            "resolve",
            { status: "partial", startedAt: ago(HOUR), detail: skipped },
            { lastAttemptAt: ago(31 * HOUR), lastGoodAt: ago(31 * HOUR) },
          ),
        ],
        stuck: [],
      }),
      NOW,
    );
    const overdue = late.find((f) => f.key === "jobs.resolve.overdue");
    expect(overdue?.severity).toBe("warning");
    expect(overdue?.evidence).toContain("kilit");
    expect(overdue?.evidenceAt).toEqual(ago(31 * HOUR));
    // Eski biçim (outcome yok) ve gerçek deneme yeni: gecikme yok (legacy davranışı korunur).
    const fine = jobRunFindings(
      ok({ jobs: [job("resolve", { startedAt: ago(HOUR) })], stuck: [] }),
      NOW,
    );
    expect(severities(fine)).toEqual({ jobs: "healthy" });
  });

  it("bozuk sonuçlu koşu aşama dışı işte başarısızlık gibi uyarı verir", () => {
    const out = jobRunFindings(
      ok({
        jobs: [job("cleanup_auth", { status: "success", detail: { outcome: "bogus" } })],
        stuck: [],
      }),
      NOW,
    );
    expect(severities(out)).toEqual({ "jobs.cleanup_auth.failed": "warning" });
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
});

describe("boru hattı: iş sonucu (karar 0174)", () => {
  const stage = (views: ReturnType<typeof evaluatePipeline>, name: string) =>
    views.find((v) => v.stage === name);

  it("blocked_upstream: kenar aşaması güncel görünmez; tazelik ve son çıktı eski kalır", () => {
    // Vektör (enrich) 30 dk önce, kenar işi 15 dk önce koştu ama embedding yoktu.
    const runs = stageRunEvidence([
      job(
        "similarity_edges",
        {
          status: "partial",
          startedAt: ago(HOUR / 4),
          detail: { outcome: "blocked_upstream", reason: "no_embeddings", visual_edges: 0 },
        },
        // Son geçerli tamamlanma ve son çıktı 2 gün önce.
        { lastGoodAt: ago(48 * HOUR), producedAt: { edges: ago(48 * HOUR) } },
      ),
    ]);
    const views = evaluatePipeline(raw({ runs }), NOW);
    const edges = stage(views, "edges");
    expect(edges).toMatchObject({
      state: "warning",
      reasons: ["job_blocked_upstream"],
      lastOutcome: "blocked_upstream",
      lastAt: ago(48 * HOUR),
      lastProducedAt: ago(48 * HOUR),
    });
    const found = pipelineFindings(edges ? [edges] : [], NOW)[0];
    expect(found?.severity).toBe("warning");
    expect(found?.meaning).toContain("önceki aşamanın çıktısı eksik");
  });

  it("birleşik similarity blocked_upstream: fiyat aşaması bayat sayılmaz, kenar aşaması uyarı", () => {
    const runs = stageRunEvidence([
      job(
        "similarity",
        {
          status: "partial",
          startedAt: ago(HOUR / 4),
          finishedAt: ago(HOUR / 5),
          detail: { outcome: "blocked_upstream", price_products: 12 },
        },
        {
          lastGoodAt: null,
          lastRanAt: ago(HOUR / 5),
          producedAt: { edges: null, prices: ago(HOUR / 5) },
        },
      ),
    ]);
    // Eşleştirme 2 saat önce; fiyat aşaması onun ardından koştu.
    const views = evaluatePipeline(raw({ runs }), NOW);
    expect(stage(views, "prices")).toMatchObject({
      state: "ok",
      source: "job_run",
      lastAt: ago(HOUR / 5),
      lastOutcome: "completed",
      lastProducedAt: ago(HOUR / 5),
    });
    expect(stage(views, "edges")).toMatchObject({
      state: "warning",
      reasons: ["job_blocked_upstream"],
      // Geçerli kenar koşusu yok: veri zamanına düşer.
      source: "data",
      lastProducedAt: null,
    });
  });

  it("skipped_locked: son geçerli tamamlanma korunur, bulgu bilgi düzeyi", () => {
    const runs = stageRunEvidence([
      job(
        "resolve",
        {
          status: "partial",
          startedAt: ago(HOUR / 10),
          detail: { outcome: "skipped_locked", reason: "lock_busy" },
        },
        { lastGoodAt: ago(HOUR / 3) },
      ),
    ]);
    const resolve = stage(evaluatePipeline(raw({ runs }), NOW), "resolve");
    expect(resolve).toMatchObject({
      state: "ok",
      lastAt: ago(HOUR / 3),
      lastOutcome: "skipped_locked",
    });
    const found = pipelineFindings(resolve ? [resolve] : [], NOW)[0];
    expect(found).toMatchObject({ severity: "info", title: "Eşleştirme: son koşu atlandı" });
  });

  it("skipped_locked tazelik sayılmaz: tek geçerli koşu toplamadan eskiyse aşama geride", () => {
    const runs = stageRunEvidence([
      job(
        "resolve",
        { status: "partial", startedAt: ago(HOUR / 10), detail: { outcome: "skipped_locked" } },
        { lastGoodAt: ago(3 * HOUR) },
      ),
    ]);
    expect(stage(evaluatePipeline(raw({ runs }), NOW), "resolve")?.state).toBe("behind");
  });

  it("no_input: aşama güncel, çıktı üretimi sayılmaz, bulgu bilgi verir", () => {
    const runs = stageRunEvidence([
      job(
        "resolve",
        {
          status: "success",
          startedAt: ago(HOUR / 4),
          detail: { outcome: "no_input", reason: "no_eligible_offers", considered: 0 },
        },
        { lastGoodAt: ago(HOUR / 5), producedAt: { resolve: ago(72 * HOUR) } },
      ),
    ]);
    const resolve = stage(evaluatePipeline(raw({ runs }), NOW), "resolve");
    expect(resolve).toMatchObject({
      state: "ok",
      lastOutcome: "no_input",
      lastProducedAt: ago(72 * HOUR),
    });
    const found = pipelineFindings(resolve ? [resolve] : [], NOW)[0];
    expect(found?.severity).toBe("healthy");
    expect(found?.meaning).toContain("uygun girdi bulunamadı");
  });

  it("bozuk sonuç başarısızlık gibi uyarıdır", () => {
    const runs = stageRunEvidence([
      job("resolve", { status: "success", detail: { outcome: 42 } }, { lastGoodAt: ago(HOUR) }),
    ]);
    expect(stage(evaluatePipeline(raw({ runs }), NOW), "resolve")).toMatchObject({
      state: "warning",
      reasons: ["job_invalid_outcome"],
      lastOutcome: "invalid",
    });
  });

  it("eski biçim (outcome yok) ve zenginleştirme: davranış değişmez, çıktı kanıtı yok", () => {
    const runs = stageRunEvidence([
      job("enrich", { status: "success" }, { lastGoodAt: ago(HOUR / 10) }),
    ]);
    const enrich = stage(evaluatePipeline(raw({ runs }), NOW), "enrich");
    expect(enrich).toMatchObject({
      state: "ok",
      source: "job_run",
      lastOutcome: "legacy",
      lastProducedAt: null,
    });
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
