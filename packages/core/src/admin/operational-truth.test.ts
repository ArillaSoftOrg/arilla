/** Karar 0051: yönetim ekranının dürüst ölçütleri — saf kurallar. */
import { describe, expect, it } from "vitest";
import { addCost, costState, emptyCostSummary } from "./cost-truth.ts";
import { writesRolledBack } from "./ingest-runs.ts";
import {
  classifyMerchantAttention,
  type MerchantAttentionInput,
  STALE_FEED_AFTER_MS,
  STUCK_RUN_AFTER_MS,
} from "./merchant-attention.ts";
import { evaluatePipeline, type PipelineRawEvidence } from "./pipeline-evidence.ts";

const NOW = new Date("2026-10-03T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const HOUR = 60 * 60 * 1000;

describe("costState", () => {
  it("fiyatlanmamış çağrı yoksa toplam gerçektir (0 dahil)", () => {
    expect(costState({ costMicros: 0, unpricedCalls: 0 })).toBe("priced");
    expect(costState({ costMicros: 1500, unpricedCalls: 0 })).toBe("priced");
  });

  it("oran tanımsızken 0 maliyet 'hesaplanmadı' olur, asla 0 TL değil", () => {
    expect(costState({ costMicros: 0, unpricedCalls: 12 })).toBe("unpriced");
  });

  it("bir kısmı fiyatlanmamışsa toplam alt sınırdır", () => {
    expect(costState({ costMicros: 900, unpricedCalls: 3 })).toBe("partial");
  });

  it("addCost tüm alanları toplar", () => {
    const sum = addCost(
      addCost(emptyCostSummary(), {
        costMicros: 1,
        calls: 2,
        cacheHits: 1,
        units: 10,
        unpricedCalls: 1,
      }),
      { costMicros: 4, calls: 3, cacheHits: 0, units: 5, unpricedCalls: 2 },
    );
    expect(sum).toEqual({ costMicros: 5, calls: 5, cacheHits: 1, units: 15, unpricedCalls: 3 });
  });
});

describe("writesRolledBack", () => {
  it("yalnızca başarısız koşunun yazımları geri alınmıştır", () => {
    expect(writesRolledBack("failed")).toBe(true);
    for (const status of ["success", "partial", "running"] as const) {
      expect(writesRolledBack(status)).toBe(false);
    }
  });
});

function merchantInput(overrides: Partial<MerchantAttentionInput> = {}): MerchantAttentionInput {
  return {
    sourceType: "xml_feed",
    currencyVerified: false,
    refreshMinutes: 60,
    lastRun: { status: "success", startedAt: ago(HOUR) },
    lastGoodAt: ago(HOUR),
    ...overrides,
  };
}

describe("classifyMerchantAttention", () => {
  it("taze, başarılı mağaza dikkat gerektirmez", () => {
    expect(classifyMerchantAttention(merchantInput(), NOW)).toEqual([]);
  });

  it("kısmi koşu tek başına dikkat durumu değildir (veri yazılmış)", () => {
    expect(
      classifyMerchantAttention(
        merchantInput({ lastRun: { status: "partial", startedAt: ago(HOUR) } }),
        NOW,
      ),
    ).toEqual([]);
  });

  it("son koşu başarısız → failed", () => {
    const states = classifyMerchantAttention(
      merchantInput({ lastRun: { status: "failed", startedAt: ago(HOUR) } }),
      NOW,
    );
    expect(states).toContain("failed");
  });

  it("2 saatten uzun running → stuck; kısa running değil", () => {
    expect(
      classifyMerchantAttention(
        merchantInput({ lastRun: { status: "running", startedAt: ago(STUCK_RUN_AFTER_MS + 1) } }),
        NOW,
      ),
    ).toContain("stuck");
    expect(
      classifyMerchantAttention(
        merchantInput({ lastRun: { status: "running", startedAt: ago(HOUR) } }),
        NOW,
      ),
    ).not.toContain("stuck");
  });

  it("hiç koşusu yok → never_ran (stale değil)", () => {
    expect(
      classifyMerchantAttention(merchantInput({ lastRun: null, lastGoodAt: null }), NOW),
    ).toEqual(["never_ran"]);
  });

  it("24 saatten eski yenileme → stale; mağazanın kendi aralığı daha uzunsa o", () => {
    expect(
      classifyMerchantAttention(
        merchantInput({ lastGoodAt: ago(STALE_FEED_AFTER_MS + HOUR) }),
        NOW,
      ),
    ).toEqual(["stale"]);
    expect(
      classifyMerchantAttention(
        merchantInput({ refreshMinutes: 48 * 60, lastGoodAt: ago(30 * HOUR) }),
        NOW,
      ),
    ).toEqual([]);
  });

  it("Shopify para birimi doğrulanmadıysa currency_unverified; diğer kaynaklarda değil", () => {
    expect(
      classifyMerchantAttention(
        merchantInput({ sourceType: "shopify", currencyVerified: false }),
        NOW,
      ),
    ).toContain("currency_unverified");
    expect(
      classifyMerchantAttention(
        merchantInput({ sourceType: "shopify", currencyVerified: true }),
        NOW,
      ),
    ).toEqual([]);
    expect(classifyMerchantAttention(merchantInput({ currencyVerified: false }), NOW)).toEqual([]);
  });
});

function raw(overrides: Partial<PipelineRawEvidence> = {}): PipelineRawEvidence {
  return {
    collect: { lastStartedAt: ago(HOUR), lastGoodAt: ago(HOUR), stuckRuns: 0 },
    resolve: { lastAt: ago(HOUR / 2) },
    prices: { lastAt: ago(HOUR / 4) },
    enrich: { lastAt: ago(HOUR / 2) },
    edges: { lastAt: ago(HOUR / 4) },
    link: { lastFinishedAt: ago(HOUR), stuckProcessing: 0, oldestQueuedAt: null },
    ...overrides,
  };
}

const stateOf = (views: ReturnType<typeof evaluatePipeline>, stage: string) =>
  views.find((view) => view.stage === stage);

describe("evaluatePipeline", () => {
  it("sıralı ve taze boru hattı: tümü güncel", () => {
    expect(evaluatePipeline(raw(), NOW).map((view) => view.state)).toEqual([
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
    ]);
  });

  it("toplama eşleştirmeden yeniyse eşleştirme 'geride olabilir'", () => {
    const views = evaluatePipeline(
      raw({ collect: { lastStartedAt: ago(1000), lastGoodAt: ago(1000), stuckRuns: 0 } }),
      NOW,
    );
    expect(stateOf(views, "resolve")?.state).toBe("behind");
    expect(stateOf(views, "enrich")?.state).toBe("behind");
  });

  it("takılı koşu ve 24 saatlik feed boşluğu toplama aşamasını uyarıya çeker", () => {
    const views = evaluatePipeline(
      raw({
        collect: {
          lastStartedAt: ago(HOUR),
          lastGoodAt: ago(STALE_FEED_AFTER_MS + HOUR),
          stuckRuns: 1,
        },
      }),
      NOW,
    );
    expect(stateOf(views, "collect")).toMatchObject({
      state: "warning",
      reasons: ["stuck_runs", "stale_feed"],
    });
  });

  it("takılı ya da uzun bekleyen link isteği uyarıdır", () => {
    const views = evaluatePipeline(
      raw({ link: { lastFinishedAt: ago(HOUR), stuckProcessing: 2, oldestQueuedAt: ago(HOUR) } }),
      NOW,
    );
    expect(stateOf(views, "link")).toMatchObject({
      state: "warning",
      reasons: ["link_stuck", "link_queue_old"],
    });
  });

  it("kanıt yoksa 'none', okunamadıysa 'unknown' (sessizce güncel sayılmaz)", () => {
    const views = evaluatePipeline(raw({ edges: { lastAt: null }, enrich: null }), NOW);
    expect(stateOf(views, "edges")?.state).toBe("none");
    expect(stateOf(views, "enrich")?.state).toBe("unknown");
  });
});
