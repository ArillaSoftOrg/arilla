/**
 * Karar 0203 pilot olcum seti: saf kisimlar (maliyet, tavan, toplu olcum, denetim ozeti), veri
 * seti degismezleri ve kuru kosu uctan uca duman testi. Ag/anahtar/DB yok.
 */
import { describe, expect, it } from "vitest";
import { looksLikeResultQuestion, RESULT_FACT_LIMIT } from "../chat/answer.ts";
import { GeminiChatInterpreter, isBlockedFromModel } from "../chat/interpreter.ts";
import { findLlmPriceRule } from "../llm/pricing.ts";
import {
  aggregate,
  CALLS_CEILING,
  CapTracker,
  type CaseRecord,
  costUsdMicros,
  estimateRunCost,
  forbiddenHits,
  parseArgs,
  percentile,
  priceRule,
  renderJson,
  renderMarkdown,
  runPilot,
  summarizeReviews,
  USD_CEILING,
  WORST_CASE_OUTPUT_TOKENS,
} from "./chat-answer-pilot.ts";
import {
  factsForCase,
  PILOT_CASES,
  PILOT_FACT_SETS,
  type PilotCase,
} from "./chat-answer-pilot-cases.ts";
import { DeterministicStubClient } from "./chat-answer-pilot-stub.ts";

const AT = new Date("2026-11-15T00:00:00Z");
const rule = () => {
  const found = findLlmPriceRule("gemini-3.1-flash-lite", AT);
  if (!found) throw new Error("rule");
  return found;
};

describe("maliyet", () => {
  it("1M girdi = 0,25 USD; cikti ve dusunme 1,50 USD/1M", () => {
    expect(
      costUsdMicros({ inputTokens: 1_000_000, outputTokens: 0, thoughtTokens: 0 }, rule()),
    ).toBe(250_000);
    expect(
      costUsdMicros({ inputTokens: 0, outputTokens: 400_000, thoughtTokens: 600_000 }, rule()),
    ).toBe(1_500_000);
  });

  it("yukari yuvarlar: kullanimli cagri asla 0 gorunmez", () => {
    expect(costUsdMicros({ inputTokens: 1, outputTokens: 0, thoughtTokens: 0 }, rule())).toBe(1);
  });

  it("priceRule bilinmeyen modelde hata verir (0 maliyet uydurulmaz)", () => {
    expect(() => priceRule("bilinmeyen-model", AT)).toThrow();
    expect(priceRule("gemini-3.1-flash-lite", AT).inputUsdMicrosPerMTok).toBe(250_000);
  });

  it("tam kosu tahmini: cagri basina girdi + varsayilan cikti/dusunme", () => {
    const estimate = estimateRunCost(
      [1000, 3000],
      { outputTokens: 500, thoughtTokens: 100 },
      rule(),
    );
    // (4000*0,25 + 2*600*1,5) / 1000 = 1,0 + 1,8 = 2,8 mikro-USD*1000 => $0,0028
    expect(estimate.calls).toBe(2);
    expect(estimate.inputTokens).toBe(4000);
    expect(estimate.costUsd).toBeCloseTo(0.0028, 6);
  });
});

describe("parseArgs: tavan zorunlulugu", () => {
  it("kuru kosu varsayilandir ve tavansiz calisir", () => {
    const parsed = parseArgs([]);
    expect(parsed.ok && parsed.options.mode).toBe("dry");
  });

  it("gercek kosu iki tavan olmadan REDDEDILIR", () => {
    expect(parseArgs(["--real"]).ok).toBe(false);
    expect(parseArgs(["--real", "--max-calls", "10"]).ok).toBe(false);
    expect(parseArgs(["--real", "--max-usd", "0.05"]).ok).toBe(false);
    const ok = parseArgs(["--real", "--max-calls", "10", "--max-usd", "0.05"]);
    expect(ok.ok && ok.options.mode).toBe("real");
  });

  it("sert ust sinirlari ve bozuk degerleri reddeder", () => {
    expect(
      parseArgs(["--real", "--max-calls", String(CALLS_CEILING + 1), "--max-usd", "1"]).ok,
    ).toBe(false);
    expect(parseArgs(["--real", "--max-calls", "5", "--max-usd", String(USD_CEILING + 1)]).ok).toBe(
      false,
    );
    expect(parseArgs(["--max-calls", "0"]).ok).toBe(false);
    expect(parseArgs(["--max-usd", "-1"]).ok).toBe(false);
    expect(parseArgs(["--max-usd", "abc"]).ok).toBe(false);
    expect(parseArgs(["--real", "--dry-run", "--max-calls", "1", "--max-usd", "1"]).ok).toBe(false);
    expect(parseArgs(["--bilinmeyen"]).ok).toBe(false);
    expect(parseArgs(["--max-calls"]).ok).toBe(false);
    expect(parseArgs(["--repeat", "9"]).ok).toBe(false);
  });
});

describe("CapTracker", () => {
  it("cagri tavaninda durur ve kalici olarak reddeder", () => {
    const tracker = new CapTracker(2, null, rule());
    expect(tracker.allow(1000)).toBe(true);
    tracker.record(1, 10);
    expect(tracker.allow(1000)).toBe(true);
    tracker.record(1, 10);
    expect(tracker.allow(1000)).toBe(false);
    expect(tracker.stoppedBy).toBe("calls_cap");
    expect(tracker.allow(1)).toBe(false);
  });

  it("USD tavani: harcanan + en kotu durum tavani asacaksa cagri baslamaz", () => {
    const worst = costUsdMicros(
      { inputTokens: 3000, outputTokens: WORST_CASE_OUTPUT_TOKENS, thoughtTokens: 0 },
      rule(),
    );
    const tracker = new CapTracker(null, (worst * 2.5) / 1_000_000, rule());
    expect(tracker.allow(3000)).toBe(true);
    tracker.record(1, worst); // gercek maliyet en kotu duruma esit varsayilsin
    expect(tracker.allow(3000)).toBe(true);
    tracker.record(1, worst);
    expect(tracker.allow(3000)).toBe(false);
    expect(tracker.stoppedBy).toBe("usd_cap");
  });
});

describe("yuzdelik ve toplu olcum", () => {
  it("nearest-rank yuzdelik", () => {
    expect(percentile([], 95)).toBeNull();
    expect(percentile([5], 95)).toBe(5);
    const xs = Array.from({ length: 20 }, (_, i) => (i + 1) * 10);
    expect(percentile(xs, 50)).toBe(100);
    expect(percentile(xs, 95)).toBe(190);
  });

  const record = (over: Partial<CaseRecord>): CaseRecord => ({
    runId: "r",
    id: "x-01",
    caseId: "x-01",
    repeatIndex: 0,
    setId: "x",
    category: "c",
    type: "which_better",
    expect: "should_answer",
    query: "q",
    question: "s",
    routed: true,
    status: "ran",
    providerCode: null,
    action: "answer",
    source: "model",
    fallbackReason: null,
    validated: true,
    rejected: [],
    fallbackUsed: false,
    shownText: "t",
    paragraphs: [],
    rawParagraphs: [],
    latencyMs: 1000,
    attempts: 1,
    inputTokens: 4000,
    outputTokens: 500,
    thoughtTokens: 100,
    costUsdMicros: 2000,
    autoFlags: [],
    review: { verdict: null, notes: "" },
    ...over,
  });

  it("gecerli/yedek orani, gecikme farki ve maliyet projeksiyonu", () => {
    const records = [
      ...Array.from({ length: 19 }, (_, i) => record({ id: `a${i}`, latencyMs: 1000 + i })),
      record({
        id: "bad",
        validated: false,
        fallbackUsed: true,
        rejected: ["forbidden_claim"],
        latencyMs: 2500,
      }),
      record({
        id: "skip",
        status: "skipped_not_routed",
        action: null,
        validated: null,
        attempts: 0,
        latencyMs: null,
        inputTokens: 0,
        outputTokens: 0,
        thoughtTokens: 0,
        costUsdMicros: 0,
      }),
    ];
    const baselines = [
      {
        caseId: "a0",
        latencyMs: 900,
        inputTokens: 3000,
        outputTokens: 100,
        thoughtTokens: 0,
        costUsdMicros: 1000,
        action: "search",
      },
      {
        caseId: "a1",
        latencyMs: 1200,
        inputTokens: 3000,
        outputTokens: 100,
        thoughtTokens: 0,
        costUsdMicros: 1000,
        action: "search",
      },
    ];
    const a = aggregate(records, baselines, null);
    expect(a.answerActions).toBe(20);
    expect(a.validated).toBe(19);
    expect(a.validRate).toBeCloseTo(0.95, 10);
    expect(a.fallbackRate).toBeCloseTo(0.05, 10);
    expect(a.rejectionReasons).toEqual({ forbidden_claim: 1 });
    expect(a.skippedNotRouted).toBe(1);
    expect(a.latencyP95Ms).toBe(1018); // 19. sira
    expect(a.baselineLatencyP95Ms).toBe(1200);
    expect(a.latencyDeltaP95Ms).toBe(1018 - 1200);
    // 20 cagri * 2000 mikro + 2 taban * 1000 mikro = $0,042
    expect(a.totalCostUsd).toBeCloseTo(0.042, 6);
    expect(a.costPerTurnUsd).toBeCloseTo(0.002, 6);
    expect(a.incrementalCostPerTurnUsd).toBeCloseTo(0.001, 6);
    expect(a.projections.map((p) => p.answersPerDay)).toEqual([1000, 10000]);
    expect(a.projections[0]?.dailyUsd).toBeCloseTo(2, 6);
    expect(a.projections[1]?.monthlyUsd).toBeCloseTo(600, 6);
  });

  it("denetim ozeti: kritik = delilsiz + yanlis; olcut >=100 denetim ve 0 kritik", () => {
    const answers = Array.from({ length: 100 }, (_, i) =>
      record({ id: `c${i}`, review: { verdict: "correct", notes: "" } }),
    );
    expect(summarizeReviews(answers)).toMatchObject({
      reviewedAnswers: 100,
      critical: 0,
      pending: 0,
      meetsAuditBar: true,
    });
    const withBad = [...answers, record({ id: "bad", review: { verdict: "wrong", notes: "" } })];
    expect(summarizeReviews(withBad)).toMatchObject({ critical: 1, meetsAuditBar: false });
    const pending = [record({ id: "p" }), record({ id: "q", validated: false })];
    expect(summarizeReviews(pending)).toMatchObject({ reviewedAnswers: 0, pending: 1 });
    expect(summarizeReviews(answers.slice(0, 99)).meetsAuditBar).toBe(false);
  });

  it("forbiddenHits: yalniz gerceklerde BULUNMAYAN iddia bayraklanir", () => {
    const facts = [
      {
        id: "p1",
        title: "Powerbank 5000 mAh uyumlu",
        brand: null,
        store: "X",
        price_try: 100,
        offer_count: 1,
      },
    ];
    expect(forbiddenHits("Gerçek kapasite 4000", facts, ["gerçek kapasite"])).toEqual([
      "gerçek kapasite",
    ]);
    // Baslikta zaten "uyumlu" var: bayrak yok.
    expect(forbiddenHits("Başlıkta uyumlu yazıyor", facts, ["uyumlu"])).toEqual([]);
  });
});

describe("veri seti degismezleri", () => {
  it("en az 120 vaka, benzersiz kimlik, bilinen kume", () => {
    expect(PILOT_CASES.length).toBeGreaterThanOrEqual(120);
    expect(new Set(PILOT_CASES.map((c) => c.id)).size).toBe(PILOT_CASES.length);
    const sets = new Set(PILOT_FACT_SETS.map((s) => s.id));
    for (const c of PILOT_CASES) expect(sets.has(c.setId)).toBe(true);
  });

  it("yonlendirme: not_routed disindaki her vaka tetigi gecer, not_routed gecmez", () => {
    for (const c of PILOT_CASES) {
      expect(looksLikeResultQuestion(c.question), `${c.id}: ${c.question}`).toBe(
        c.expect !== "not_routed",
      );
    }
    const routed = PILOT_CASES.filter((c) => c.expect !== "not_routed").length;
    expect(routed).toBeGreaterThanOrEqual(120);
  });

  it("gerceklerin bicimi uretimle ayni: <=8, p1.. kimlikleri, baslik <=160, sizinti yok", () => {
    for (const set of PILOT_FACT_SETS) {
      expect(set.facts.length).toBeGreaterThanOrEqual(5);
      expect(set.facts.length).toBeLessThanOrEqual(RESULT_FACT_LIMIT);
      set.facts.forEach((fact, index) => {
        expect(fact.id).toBe(`p${index + 1}`);
        expect(fact.title.length).toBeLessThanOrEqual(160);
        expect(fact.price_try === null || Number.isInteger(fact.price_try)).toBe(true);
        // Model onu suzgeci gercegi dusurur (`interpretTurn` sessizce eler). Tek BILINCLI istisna:
        // uretimden alinan, uzun sayi dizili baslik (`id_like`); kume kuculur, kimlik kalir.
        const blocked = isBlockedFromModel(
          [fact.title, fact.brand, fact.store].filter(Boolean).join(" "),
        );
        expect(blocked, `${set.id}/${fact.id}`).toBe(`${set.id}/${fact.id}` === "powerbank/p1");
      });
    }
  });

  it("katalog gercegini yansitir: cogu urunde TL fiyati yok ve marka yok", () => {
    const facts = PILOT_FACT_SETS.flatMap((s) => s.facts);
    const aliexpress = facts.filter((f) => f.store === "AliExpress");
    expect(aliexpress.length / facts.length).toBeGreaterThan(0.4);
    expect(aliexpress.every((f) => f.price_try === null && f.brand === null)).toBe(true);
  });

  it("tur ve beklenti dagilimi: tuzaklar, konu disi, enjeksiyon, eksik veri var", () => {
    const count = (pred: (c: PilotCase) => boolean) => PILOT_CASES.filter(pred).length;
    expect(count((c) => c.expect === "should_answer")).toBeGreaterThanOrEqual(60);
    expect(count((c) => c.expect === "should_decline_or_fallback")).toBeGreaterThanOrEqual(40);
    for (const type of ["trap_spec", "trap_performance", "trap_compat", "trap_quality"] as const) {
      expect(
        count((c) => c.type === type),
        type,
      ).toBeGreaterThanOrEqual(5);
    }
    expect(count((c) => c.type === "off_topic")).toBeGreaterThanOrEqual(3);
    expect(count((c) => c.type === "injection")).toBeGreaterThanOrEqual(5);
    expect(count((c) => c.type === "missing_data")).toBeGreaterThanOrEqual(3);
    // Reddedilmesi gereken her vakanin iddia etiketi vardir.
    for (const c of PILOT_CASES.filter((x) => x.expect === "should_decline_or_fallback")) {
      expect(c.mustNotClaim.length, c.id).toBeGreaterThan(0);
    }
    // Desenler gecerli regex.
    for (const c of PILOT_CASES)
      for (const p of c.forbiddenPatterns) expect(() => new RegExp(p, "iu")).not.toThrow();
  });

  it("factsForCase her cagrida bagimsiz kopya verir", () => {
    const c = PILOT_CASES[0] as PilotCase;
    const a = factsForCase(c);
    (a[0] as { title: string }).title = "degisti";
    expect(factsForCase(c)[0]?.title).not.toBe("degisti");
  });
});

describe("kuru kosu (sahte model) uctan uca", () => {
  const deps = (
    over: {
      maxCalls?: number | null;
      maxUsd?: number | null;
      baseline?: number;
      repeat?: number;
      ignoreTrigger?: boolean;
    } = {},
  ) => {
    let tick = 0;
    const tracker = new CapTracker(over.maxCalls ?? null, over.maxUsd ?? null, rule());
    return {
      tracker,
      deps: {
        interpreter: new GeminiChatInterpreter(new DeterministicStubClient()),
        options: {
          ignoreTrigger: over.ignoreTrigger ?? false,
          baseline: over.baseline ?? 0,
          repeat: over.repeat ?? 1,
        },
        tracker,
        rule: rule(),
        now: () => (tick += 7),
        runId: "test",
      },
    };
  };

  it("tum seti kosar; kayitlar ve olcumler tutarli, red yollari tetiklenir", async () => {
    const { deps: d, tracker } = deps({ baseline: 5 });
    const result = await runPilot(PILOT_CASES, d);
    expect(result.records).toHaveLength(PILOT_CASES.length);
    expect(result.baselines).toHaveLength(5);
    expect(result.stoppedBy).toBeNull();
    const a = aggregate(result.records, result.baselines, result.stoppedBy);
    expect(a.providerErrors).toBe(0);
    expect(a.skippedNotRouted).toBe(PILOT_CASES.filter((c) => c.expect === "not_routed").length);
    expect(a.ran + a.skippedNotRouted).toBe(PILOT_CASES.length);
    expect(a.answerActions).toBeGreaterThan(80);
    expect(a.validated).toBeGreaterThan(0);
    // Dogrulayicinin her red yolu en az bir kez calisir.
    for (const reason of ["forbidden_claim", "unevidenced_number", "quote_mismatch", "schema"]) {
      expect(a.rejectionReasons[reason], reason).toBeGreaterThan(0);
    }
    expect(a.flagCounts.trigger_mismatch).toBeUndefined();
    // Her kullanilan cagri tavan izleyiciye yansir; maliyet kayit toplamina esit.
    // (Modele gitmeyen "filtered" turlar, ornegin URL iceren soru, cagri harcamaz.)
    const attempts = result.records.reduce((s, r) => s + r.attempts, 0);
    expect(tracker.calls).toBe(attempts + result.baselines.length);
    expect(a.ran - result.records.filter((r) => r.attempts > 0).length).toBeLessThanOrEqual(2);
    expect(a.totalCostUsd).toBeGreaterThan(0);
    // Yedek kullanilan cevaplarda gosterilen metin modelsiz ozettir, bos degil.
    for (const r of result.records.filter((x) => x.action === "answer" && !x.validated)) {
      expect(r.fallbackUsed).toBe(true);
      expect(r.shownText?.length ?? 0).toBeGreaterThan(10);
      expect(r.paragraphs).toHaveLength(0);
    }
    // Ciktilar uretilir: JSON gidis-donus + her vaka Markdown'da.
    const report = {
      meta: {
        runId: "test",
        mode: "dry" as const,
        model: "m",
        startedAt: "t",
        caps: { maxCalls: null, maxUsd: null },
        priceRuleId: rule().id,
        note: "",
      },
      aggregates: a,
      records: result.records,
      baselines: result.baselines,
    };
    expect(JSON.parse(renderJson(report)).records).toHaveLength(PILOT_CASES.length);
    const md = renderMarkdown(report);
    for (const c of PILOT_CASES) expect(md).toContain(`### ${c.id} `);
    expect(md).toContain("KURU KOŞU");
    // Dogrulanmis cevaplar denetim icin bekler (karar bos).
    expect(summarizeReviews(result.records).pending).toBe(a.validated);
  });

  it("deterministiktir: ayni giris, ayni cikis", async () => {
    const first = await runPilot(PILOT_CASES.slice(0, 40), deps().deps);
    const second = await runPilot(PILOT_CASES.slice(0, 40), deps().deps);
    expect(second.records).toEqual(first.records);
  });

  it("--max-calls tavaninda durur; kalanlar skipped_cap", async () => {
    const { deps: d, tracker } = deps({ maxCalls: 7 });
    const result = await runPilot(PILOT_CASES, d);
    expect(tracker.calls).toBe(7);
    expect(result.stoppedBy).toBe("calls_cap");
    const a = aggregate(result.records, result.baselines, result.stoppedBy);
    expect(a.ran).toBe(7);
    expect(a.skippedCap).toBeGreaterThan(100);
  });

  it("--max-usd tavanini asmaz (harcama <= tavan)", async () => {
    const { deps: d, tracker } = deps({ maxUsd: 0.01 });
    const result = await runPilot(PILOT_CASES, d);
    expect(tracker.spentMicros).toBeLessThanOrEqual(10_000);
    expect(result.stoppedBy).toBe("usd_cap");
    expect(tracker.calls).toBeGreaterThan(0);
    expect(tracker.calls).toBeLessThan(10);
  });

  it("--repeat vakalari tekrarlar (kimlik #2); taban yalniz ilk turda", async () => {
    const subset = PILOT_CASES.filter((c) => c.expect !== "not_routed").slice(0, 6);
    const result = await runPilot(subset, deps({ repeat: 2, baseline: 3 }).deps);
    expect(result.records).toHaveLength(12);
    expect(
      result.records.filter((r) => r.repeatIndex === 1).every((r) => r.id.endsWith("#2")),
    ).toBe(true);
    expect(result.baselines).toHaveLength(3);
  });

  it("--ignore-trigger yonlendirilmeyen vakalari da modele gonderir", async () => {
    const subset = PILOT_CASES.filter((c) => c.expect === "not_routed");
    const result = await runPilot(subset, deps({ ignoreTrigger: true }).deps);
    expect(result.records.every((r) => r.status === "ran")).toBe(true);
  });
});

describe("raw paragraph capture (rejected paragraphs stay auditable)", () => {
  it("inspectAnswer reports the reason and the unevidenced numbers without changing the verdict", async () => {
    const { inspectAnswer, validateAnswer } = await import("../chat/answer.ts");
    const facts = [
      {
        id: "p1",
        title: "Power Bank 10000mAh 22.5W",
        brand: null,
        store: null,
        price_try: null,
        offer_count: 2,
      },
    ];
    const raw = {
      paragraphs: [
        {
          text: "Bu ürün 10000mAh kapasiteli ve 22.5W çıkış veriyor, ayrıca 3 teklif var.",
          evidence: [{ item: "p1", field: "title", quote: "10000mAh" }],
        },
      ],
    };
    const inspected = inspectAnswer(raw, facts);
    expect(inspected?.[0]?.problem).toBe("unevidenced_number");
    expect(inspected?.[0]?.unevidencedNumbers).toEqual(["3"]);
    expect(validateAnswer(raw, facts).answer).toBeNull();
    expect(inspectAnswer("x", facts)).toBeNull();
  });
});
