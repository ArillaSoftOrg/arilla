/**
 * `SEARCH_PERF=1`: milyonluk katalogda `/ara` hattinin (`searchWithFallback` +
 * PostgreSQL saglayicisi) gecikmesi. ONCEDEN doldurulmus yalitilmis bir
 * veritabani ister (karar 0129 "Olcum"); varsayilan entegrasyon kosusunda atlanir.
 *
 * Her sorgu bir kez isinma (`SEARCH_PERF_WARMUP=0` ile yok), sonra `SEARCH_PERF_RUNS`
 * (varsayilan 5) kez olculur; `SEARCH_PERF_QUERIES="a|b"` alt kume secer.
 * Cikti: sorgu basina p50/p95, toplam p50/p95, sonuc sayisi ve ilk 3 basligin
 * kimligi (dogruluk karsilastirmasi icin `SEARCH_PERF_OUT` dosyasina JSON).
 */
import { writeFileSync } from "node:fs";
import { describe, it } from "vitest";
import { emptyIntent } from "../chat/intent.ts";
import { searchByIntent } from "../chat/search-adapter.ts";
import { getTestDb } from "../test-db.ts";
import { createSeedAliasSource } from "./fallback/aliases.ts";
import { searchWithFallback } from "./fallback/pipeline.ts";
import { createPostgresSearchProvider } from "./fallback/postgres-provider.ts";
import { loadLexicon } from "./lexicon-repository.ts";
import { parseQueryText } from "./parse-query.ts";

export const PERF_QUERIES: readonly string[] = [
  // Turkce, yaygin bas isim
  "çanta",
  "omuz çantası",
  "kadın deri omuz çantası",
  "spor ayakkabı",
  "nike spor ayakkabı",
  "kablosuz kulaklık",
  "telefon kılıfı",
  "iphone 15 pro max kılıf",
  "koltuk takımı",
  "halı",
  "termos",
  "stanley termos",
  "yoga matı",
  "akıllı saat",
  "parfüm",
  "laptop",
  "galaxy s24 ultra",
  // Ingilizce (AliExpress basliklari)
  "phone case",
  "wireless earbuds",
  "bluetooth headphones",
  "smart watch",
  "led strip",
  "dress",
  "backpack women",
  "usb c cable 65w",
  "car phone holder magnetic",
  // Filtreli
  "siyah çanta",
  "500 tl altı kulaklık",
  "nike ayakkabı 2000 tl altı",
  // Seyrek / yazim hatasi / karsiligi yok
  "airpdos pro",
  "zorbalux",
  "kirmizi yoga mati",
  "xqzvbn",
];

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] as number;
}

describe.skipIf(process.env.SEARCH_PERF !== "1" || process.env.SEARCH_PERF_CHAT_ONLY === "1")(
  "arama olcegi (milyonluk katalog)",
  () => {
    it("p50/p95", { timeout: 3_600_000 }, async () => {
      const db = getTestDb();
      const lexicon = await loadLexicon(db);
      const runs = Number(process.env.SEARCH_PERF_RUNS ?? 5);
      const warmup = process.env.SEARCH_PERF_WARMUP !== "0";
      // Eski (sinirsiz) kodla karsilastirmada alt kume: "a|b|c".
      const only = process.env.SEARCH_PERF_QUERIES?.split("|");
      const all: number[] = [];
      const lines: string[] = [];
      const results: Record<string, { total: number; mode: string; ids: number[]; ms: number[] }> =
        {};
      for (const text of only ?? PERF_QUERIES) {
        const parsed = parseQueryText(text, lexicon);
        const once = () =>
          searchWithFallback(
            createPostgresSearchProvider(db),
            { parsed, sort: "balanced", page: 1, pageSize: 24 },
            { aliases: createSeedAliasSource() },
          );
        let outcome = warmup ? await once() : undefined;
        const times: number[] = [];
        for (let i = 0; i < runs; i += 1) {
          const started = performance.now();
          outcome = await once();
          times.push(performance.now() - started);
        }
        if (!outcome) continue;
        times.sort((a, b) => a - b);
        all.push(...times);
        results[text] = {
          total: outcome.total,
          mode: outcome.mode,
          ids: outcome.items.map((item) => item.productId),
          ms: times.map((t) => Math.round(t)),
        };
        lines.push(
          `${text.padEnd(30)} p50=${String(Math.round(percentile(times, 50))).padStart(6)} p95=${String(Math.round(percentile(times, 95))).padStart(6)} ms  ${outcome.mode.padEnd(8)} total=${outcome.total} stages=${outcome.trace.stagesTried.join(">")}`,
        );
      }
      all.sort((a, b) => a - b);
      lines.push(
        `TOPLAM ${all.length} olcum  p50=${Math.round(percentile(all, 50))} ms  p95=${Math.round(percentile(all, 95))} ms  max=${Math.round(all[all.length - 1] ?? 0)} ms`,
      );
      console.info(`\n${lines.join("\n")}`);
      if (process.env.SEARCH_PERF_OUT) {
        writeFileSync(process.env.SEARCH_PERF_OUT, JSON.stringify(results, null, 2));
      }
    });
  },
);

/** Sohbetin arama yolu (karar 0131): niyet -> `searchByIntent` (4 sn sinirli islem). */
export const CHAT_PERF_QUERIES: readonly string[] = [
  "kablosuz kulaklık",
  "oyuncu kulaklığı",
  "iphone 16 kılıfı",
  "iphone 16 pro 256 gb",
  "bluetooth hoparlör",
  "telefon kılıfı",
  "akıllı saat",
  "ev için kullanışlı ürünler",
  "wireless earbuds",
  "sırt çantası",
];

describe.skipIf(process.env.SEARCH_PERF !== "1")(
  "sohbet aramasi olcegi (milyonluk katalog)",
  () => {
    it("p50/p95", { timeout: 3_600_000 }, async () => {
      const db = getTestDb();
      const runs = Number(process.env.SEARCH_PERF_RUNS ?? 5);
      const all: number[] = [];
      const lines: string[] = [];
      for (const text of CHAT_PERF_QUERIES) {
        const once = () => searchByIntent(db, emptyIntent(text));
        let result: Awaited<ReturnType<typeof once>> | null = null;
        const times: number[] = [];
        for (let i = 0; i <= runs; i += 1) {
          const started = performance.now();
          try {
            result = await once();
          } catch (error) {
            // Sohbetin 4 sn siniri asildi: olcume sinir suresi yazilir, kosu devam eder.
            if ((error as Error).name !== "IntentSearchTimeoutError") throw error;
            result = null;
          }
          if (i > 0) times.push(performance.now() - started);
        }
        times.sort((a, b) => a - b);
        all.push(...times);
        const titles =
          result?.outcome.items.slice(0, 3).map((item) => item.title.slice(0, 40)) ?? [];
        lines.push(
          `${text.padEnd(28)} p50=${String(Math.round(percentile(times, 50))).padStart(5)} p95=${String(Math.round(percentile(times, 95))).padStart(5)} ms  ${(result?.outcome.mode ?? "TIMEOUT").padEnd(8)} n=${result?.outcome.items.length ?? 0} ${JSON.stringify(titles)}`,
        );
      }
      all.sort((a, b) => a - b);
      lines.push(
        `SOHBET ${all.length} olcum  p50=${Math.round(percentile(all, 50))} ms  p95=${Math.round(percentile(all, 95))} ms  max=${Math.round(all[all.length - 1] ?? 0)} ms`,
      );
      console.info(`\n${lines.join("\n")}`);
    });
  },
);
