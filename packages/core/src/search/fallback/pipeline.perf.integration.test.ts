/** `SEARCH_PERF=1`: tum fallback pipeline'inin buyuk katalogda DB sorgu sayisi ve gecikmesi. */
import { describe, it } from "vitest";
import { getTestDb } from "../../test-db.ts";
import { loadLexicon } from "../lexicon-repository.ts";
import { parseQueryText } from "../parse-query.ts";
import { createSeedAliasSource } from "./aliases.ts";
import { searchWithFallback } from "./pipeline.ts";
import { createPostgresSearchProvider } from "./postgres-provider.ts";

describe.skipIf(process.env.SEARCH_PERF !== "1")("pipeline latency (buyuk katalog)", () => {
  it("olcum", { timeout: 300_000 }, async () => {
    const db = getTestDb();
    const lexicon = await loadLexicon(db);
    const rows: string[] = [];
    for (const text of [
      "zorbalux phone 17 pro",
      "zorbalux phone 17 pro max",
      "zorbalux phone 18",
      "zorbalux fone 17 pro",
      "yoga matı",
    ]) {
      const started = performance.now();
      const outcome = await searchWithFallback(
        createPostgresSearchProvider(db),
        { parsed: parseQueryText(text, lexicon), sort: "balanced", page: 1, pageSize: 24 },
        { aliases: createSeedAliasSource() },
      );
      rows.push(
        `${text.padEnd(28)} mode=${outcome.mode.padEnd(8)} stages=${outcome.trace.stagesTried.join(">")} items=${outcome.items.length} ms=${Math.round(performance.now() - started)}`,
      );
    }
    console.info(`\n${rows.join("\n")}`);
  });
});
