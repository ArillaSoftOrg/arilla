import { describe, expect, it, vi } from "vitest";
import { composeAliasSources, createLexiconAliasSource, createSeedAliasSource } from "./aliases.ts";
import { formatTraceForLog } from "./log.ts";
import { searchWithFallback } from "./pipeline.ts";
import { CATALOG, createFakeProvider, LEXICON, parsed } from "./test-catalog.ts";
import type { SearchTrace } from "./types.ts";

const aliases = createSeedAliasSource();

async function run(text: string, extra: { lexicon?: typeof LEXICON; page?: number } = {}) {
  const provider = createFakeProvider();
  const traces: SearchTrace[] = [];
  const outcome = await searchWithFallback(
    provider,
    {
      parsed: parsed(text, extra.lexicon ?? []),
      sort: "balanced",
      page: extra.page ?? 1,
      pageSize: 24,
    },
    { aliases, onTrace: (trace) => traces.push(trace) },
  );
  return { outcome, provider, trace: traces[0] };
}

const titles = (items: { title: string }[]) => items.map((item) => item.title);

describe("searchWithFallback", () => {
  it("1. exact product name -> normal results, top is that product", async () => {
    const { outcome } = await run("iphone 17 pro");
    expect(outcome.mode).toBe("results");
    expect(titles(outcome.items)[0]).toBe("Apple iPhone 17 Pro 256GB");
    // "iPhone 16 Pro Max" kapidan gecer ama model kodu celisir: gercek sonuc degil.
    expect(titles(outcome.items)).not.toContain("Apple iPhone 16 Pro Max 256GB");
  });

  it("2. case differences do not matter", async () => {
    const lower = await run("iphone 17 pro");
    const upper = await run("IPHONE 17 PRO");
    const mixed = await run("  iPhone   17 Pro ");
    expect(titles(upper.outcome.items)).toEqual(titles(lower.outcome.items));
    expect(titles(mixed.outcome.items)).toEqual(titles(lower.outcome.items));
  });

  it("3. small typo is tolerated and still a real match", async () => {
    const { outcome, trace } = await run("airpdos pro");
    expect(outcome.mode).toBe("results");
    expect(titles(outcome.items)).toEqual(["Apple AirPods Pro 2"]);
    expect(trace?.stage).toBe("fuzzy");
    // alias/prefix: "airpod pro"
    const prefix = await run("airpod pro");
    expect(titles(prefix.outcome.items)).toEqual(["Apple AirPods Pro 2"]);
  });

  it("4. model numbers are kept: 17 does not return 16", async () => {
    const { outcome } = await run("iphone 17");
    expect(outcome.mode).toBe("results");
    expect(titles(outcome.items)).toContain("Apple iPhone 17 128GB");
    expect(titles(outcome.items).join()).not.toMatch(/iPhone 16/);
    // Ek surum eki olan ("Pro") sorgudakiyle birebir olandan sonra gelir.
    expect(titles(outcome.items)[0]).toBe("Apple iPhone 17 128GB");
  });

  it("5. brand + product: the branded products lead", async () => {
    const { outcome } = await run("nike koşu ayakkabısı");
    expect(outcome.mode).toBe("results");
    expect(titles(outcome.items).slice(0, 2).sort()).toEqual([
      "Nike Pegasus Koşu Ayakkabısı",
      "Nike Revolution Koşu Ayakkabısı",
    ]);
  });

  it("6. no exact result -> labelled fallback with the nearest models first", async () => {
    const { outcome, trace } = await run("iphone 17 pro max");
    expect(outcome.mode).toBe("fallback");
    expect(trace?.fallbackReason).toBe("no_exact_match");
    expect(titles(outcome.items)[0]).toBe("Apple iPhone 17 Pro 256GB");
    expect(titles(outcome.items)[1]).toBe("Apple iPhone 17 128GB");
    // Ayni nesli once, farkli nesil sonra; hicbiri gercek eslesme gibi isaretlenmez.
    expect(outcome.items.every((item) => item.match.tier !== "exact")).toBe(true);
    expect(trace?.stagesTried[0]).toBe("exact");
  });

  it("8. unrelated products are never shown", async () => {
    for (const text of ["yoga matı", "samsung buzdolabı", "iphone 17 pro max kılıf"]) {
      const { outcome } = await run(text);
      const titlesShown = titles(outcome.items);
      expect(titlesShown, text).not.toContain("Nike Spor Çanta");
      if (text !== "iphone 17 pro max kılıf") {
        expect(outcome.mode, text).toBe("empty");
        expect(outcome.items, text).toEqual([]);
      }
    }
  });

  it("9. duplicate canonical products are collapsed", async () => {
    const { outcome } = await run("iphone 17 pro");
    expect(outcome.items.filter((item) => item.title === "Apple iPhone 17 Pro 256GB")).toHaveLength(
      1,
    );

    const fallback = await run("iphone 17 pro max");
    const keys = fallback.outcome.items.map((item) => `${item.brandName}|${item.title}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(fallback.outcome.items.map((item) => item.productId)).size).toBe(keys.length);
  });

  it("explicit constraints survive: price is never relaxed, color relaxes first", async () => {
    const provider = createFakeProvider();
    const request = parsed("mavi nike koşu ayakkabısı 5000 tl altı", LEXICON);
    expect(request.filters.color).toEqual(["blue"]);
    expect(request.filters.price_max).toBe(500_000);
    const outcome = await searchWithFallback(provider, {
      parsed: request,
      sort: "balanced",
      page: 1,
      pageSize: 24,
    });
    expect(outcome.mode).toBe("fallback");
    expect(titles(outcome.items).sort()).toEqual([
      "Nike Pegasus Koşu Ayakkabısı",
      "Nike Revolution Koşu Ayakkabısı",
    ]);
    expect(outcome.items.every((item) => item.match.relaxed.includes("color"))).toBe(true);
    expect(outcome.items.every((item) => item.match.tier !== "exact")).toBe(true);
    // Fiyat ve marka hicbir adimda dusmedi.
    for (const call of provider.calls) {
      expect(call.filters.price_max).toBe(500_000);
      expect(call.filters.brand_include).toEqual(["nike"]);
    }
    // Rengi tutan (renk gevsetilmeden) adim once denendi.
    expect(provider.calls[0]?.filters.color).toEqual(["blue"]);
  });

  it("10. no network / model call happens", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("network must not be used");
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      await run("iphone 17 pro max");
      await run("airpdos pro");
      await run("yoga matı");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("11. existing successful search is passed through untouched", async () => {
    const provider = createFakeProvider();
    const request = parsed("nike koşu ayakkabısı");
    const outcome = await searchWithFallback(provider, {
      parsed: request,
      sort: "best_deal",
      page: 1,
      pageSize: 24,
    });
    // Tek saglayici cagrisi, istenen sekme/sayfa aynen iletildi, sonuc sirasi korundu.
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toMatchObject({
      sort: "best_deal",
      limit: 24,
      offset: 0,
      fuzzy: false,
    });
    expect(outcome.mode).toBe("results");
    expect(outcome.total).toBe(outcome.items.length);
    expect(outcome.trace.stagesTried).toEqual(["exact"]);
  });

  it("past-the-end pages are empty, not a fallback", async () => {
    const { outcome, provider } = await run("nike koşu ayakkabısı", { page: 9 });
    expect(outcome.mode).toBe("empty");
    expect(provider.calls).toHaveLength(1);
  });

  it("stops at the first stage that yields real matches (no needless loosening)", async () => {
    const { provider } = await run("iphone 17 pro");
    expect(provider.calls).toHaveLength(1);
  });

  it("records a trace without the query text in the log line", async () => {
    const { outcome, trace } = await run("iphone 17 pro max");
    expect(trace).toBeDefined();
    expect(trace?.queryNorm).toBe("iphone 17 pro max");
    expect(trace?.provider).toBe("fake");
    expect(trace?.mode).toBe("fallback");
    expect(trace?.resultCount).toBe(outcome.items.length);
    expect(trace?.latencyMs).toBeGreaterThanOrEqual(0);
    const line = formatTraceForLog(trace as SearchTrace);
    expect(line).not.toMatch(/iphone/i);
    expect(line).toContain("mode=fallback");
  });

  it("a throwing trace hook does not break the search", async () => {
    const outcome = await searchWithFallback(
      createFakeProvider(),
      { parsed: parsed("iphone 17 pro"), sort: "balanced", page: 1, pageSize: 24 },
      {
        onTrace: () => {
          throw new Error("boom");
        },
      },
    );
    expect(outcome.mode).toBe("results");
  });

  it("alias sources are pluggable (lexicon synonyms)", async () => {
    const source = composeAliasSources(
      createLexiconAliasSource([
        { kind: "synonym", surface: "telefon", normalized: "tel", weight: 1 },
        { kind: "synonym", surface: "akilli telefon", normalized: "tel", weight: 1 },
      ]),
    );
    expect(source.expand("telefon")).toEqual(["akilli telefon"]);
    expect(CATALOG.length).toBeGreaterThan(0);
  });

  it("stops loosening when the time budget is spent and says so in the trace", async () => {
    const provider = createFakeProvider();
    let now = 0;
    const slow = {
      name: "slow",
      async search(query: Parameters<typeof provider.search>[0]) {
        now += 1_000; // her saglayici turu 1 sn
        return provider.search(query);
      },
    };
    const outcome = await searchWithFallback(
      slow,
      { parsed: parsed("iphone 17 pro max"), sort: "balanced", page: 1, pageSize: 24 },
      { clock: () => now, timeBudgetMs: 1500 },
    );
    // exact (1 sn) + bir adim (2 sn) -> butce dolu: daha fazla adim denenmez.
    expect(outcome.trace.truncated).toBe(true);
    expect(outcome.trace.stagesTried.length).toBeLessThan(5);
    expect(provider.calls.length).toBeLessThan(5);
  });
});
