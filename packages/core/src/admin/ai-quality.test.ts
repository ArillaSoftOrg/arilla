/**
 * AI kalite paneli (karar 0097) - veritabani gerektirmeyen kurallar: yetki
 * veriden once, bos durumda sifir uydurulmaz, regresyon yonu ve veri seti
 * degisikligi.
 */
import type { Database } from "@arilla/db";
import { describe, expect, it } from "vitest";
import {
  COMPONENT_METRICS,
  intentStoredMetrics,
  searchStoredMetrics,
} from "../eval/metric-keys.ts";
import { buildComponentQuality, getAiQualityOverview, type QualityRun } from "./ai-quality.ts";
import { type AdminActor, AdminForbiddenError } from "./capabilities.ts";

const untouchable = new Proxy({} as Database, {
  get() {
    throw new Error("veritabanına erişildi");
  },
});

function run(over: Partial<QualityRun> & { metrics: Record<string, number> }): QualityRun {
  return {
    id: 1,
    component: "search",
    createdAt: new Date("2026-10-10T10:00:00Z"),
    algorithmVersion: "v1",
    modelVersion: null,
    live: false,
    trigger: "manual",
    snapshotId: 1,
    datasetVersion: "d1",
    verifiedCount: 38,
    regressedFlag: null,
    apiCalls: 0,
    costMicros: 0,
    latencyP50Ms: null,
    latencyP95Ms: null,
    ...over,
  };
}

describe("yetki", () => {
  it.each([["moderator" as const], ["user" as const]])(
    "%s paneli göremez ve veritabanına dokunulmaz",
    async (role) => {
      const actor: AdminActor = { userId: 1, role };
      await expect(getAiQualityOverview(untouchable, actor)).rejects.toBeInstanceOf(
        AdminForbiddenError,
      );
    },
  );
});

describe("boş veri", () => {
  it("koşu yoksa hiçbir metrik değer taşımaz (0 değil null)", () => {
    const q = buildComponentQuality("matching", null, null);
    expect(q.latest).toBeNull();
    expect(q.regressed).toBe(false);
    expect(q.metrics.every((m) => m.value === null && m.status === "no_data")).toBe(true);
  });

  it("koşuda olmayan metrik 0 sayılmaz", () => {
    const q = buildComponentQuality("search", run({ metrics: { precision_at_5: 0.8 } }), null);
    const byKey = Object.fromEntries(q.metrics.map((m) => [m.key, m]));
    expect(byKey.precision_at_5?.value).toBe(0.8);
    expect(byKey.zero_result_rate?.value).toBeNull();
    expect(byKey.zero_result_rate?.status).toBe("no_data");
  });

  it("gerçek 0 değeri korunur (sıfır sonuç oranı 0 ölçüldüyse)", () => {
    const q = buildComponentQuality("search", run({ metrics: { zero_result_rate: 0 } }), null);
    expect(q.metrics.find((m) => m.key === "zero_result_rate")?.value).toBe(0);
  });

  it("NaN ve sayı olmayan değerler gösterilmez", () => {
    const q = buildComponentQuality(
      "search",
      run({ metrics: { precision_at_5: Number.NaN, ndcg_at_10: "x" as unknown as number } }),
      null,
    );
    expect(q.metrics.find((m) => m.key === "precision_at_5")?.value).toBeNull();
    expect(q.metrics.find((m) => m.key === "ndcg_at_10")?.value).toBeNull();
  });
});

describe("regresyon", () => {
  const prev = run({ id: 1, metrics: { precision_at_5: 0.8, zero_result_rate: 0.1 } });

  it("yüksek-iyi metrik düşünce, düşük-iyi metrik artınca geriler", () => {
    const worse = run({ id: 2, metrics: { precision_at_5: 0.7, zero_result_rate: 0.2 } });
    const q = buildComponentQuality("search", worse, prev);
    expect(q.comparability).toBe("comparable");
    expect(q.regressed).toBe(true);
    const status = Object.fromEntries(q.metrics.map((m) => [m.key, m.status]));
    expect(status.precision_at_5).toBe("regressed");
    expect(status.zero_result_rate).toBe("regressed");
  });

  it("iyileşme regresyon değildir", () => {
    const better = run({ id: 2, metrics: { precision_at_5: 0.9, zero_result_rate: 0.05 } });
    const q = buildComponentQuality("search", better, prev);
    expect(q.regressed).toBe(false);
    expect(q.metrics.find((m) => m.key === "precision_at_5")?.status).toBe("improved");
  });

  it("tolerans içindeki oynama 'değişmedi'", () => {
    const same = run({ id: 2, metrics: { precision_at_5: 0.798, zero_result_rate: 0.1 } });
    const q = buildComponentQuality("search", same, prev);
    expect(q.regressed).toBe(false);
    expect(q.metrics.find((m) => m.key === "precision_at_5")?.status).toBe("same");
  });

  it("farklı veri setinde regresyon HESAPLANMAZ", () => {
    const other = run({ id: 2, snapshotId: 2, metrics: { precision_at_5: 0.1 } });
    const q = buildComponentQuality("search", other, prev);
    expect(q.comparability).toBe("dataset_changed");
    expect(q.regressed).toBe(false);
    expect(q.metrics.find((m) => m.key === "precision_at_5")?.status).toBe("no_baseline");
  });

  it("önceki koşu yoksa karşılaştırma yok", () => {
    const q = buildComponentQuality("search", prev, null);
    expect(q.comparability).toBe("no_previous");
    expect(q.regressed).toBe(false);
  });
});

describe("metrik anahtar sözleşmesi", () => {
  it("yazıcı anahtarları panelin okuduğu anahtarlarla örtüşür", () => {
    const intent = Object.keys(
      intentStoredMetrics({ exactPassRate: 1, action: { accuracy: 1, macroF1: 1 } }),
    );
    expect(intent.sort()).toEqual(COMPONENT_METRICS.gemini_intent.map((m) => m.key).sort());
    const search = Object.keys(
      searchStoredMetrics({
        precisionAt5: 1,
        ndcgAt10: 1,
        zeroResultRate: 0,
        missRate: 0,
        absentCorrectRate: 1,
      }),
    );
    expect(search.sort()).toEqual(COMPONENT_METRICS.search.map((m) => m.key).sort());
  });

  it("eşleştirme anahtarları resolve.eval_offline çıktısıyla uyumlu", () => {
    const keys = COMPONENT_METRICS.matching.map((m) => m.key);
    for (const key of ["queue_precision", "queue_recall", "queue_f1", "auto_false_match_rate"]) {
      expect(keys).toContain(key);
    }
  });
});
