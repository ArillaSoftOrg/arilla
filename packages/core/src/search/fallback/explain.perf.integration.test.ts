/**
 * EXPLAIN (ANALYZE, BUFFERS) tanisi: fallback adimlarinin urettigi SQL'in
 * buyuk katalogda indeks kullanip kullanmadigini gosterir. Yalnizca
 * `SEARCH_PERF=1` ile calisir ve ONCEDEN doldurulmus yalitilmis bir veritabani
 * ister (docs/decisions/0066, "Olcum"); varsayilan entegrasyon kosusunda atlanir.
 */
import { sql } from "drizzle-orm";
import { describe, it } from "vitest";
import { getTestDb } from "../../test-db.ts";
import { distinctImage, finalOrder, scoredCtes } from "../search-sql.ts";
import type { QueryObject } from "../types.ts";
import { FUZZY_TOKEN_THRESHOLD } from "./postgres-provider.ts";

function query(slots: string[][], filters: QueryObject["filters"] = {}): QueryObject {
  return {
    intent: "browse",
    anchor: null,
    text: slots.map((s) => s[0]).join(" "),
    filters,
    style_tags: [],
    sort: "balanced",
    unparsed: slots.map((s) => s[0]).join(" "),
    confidence: 1,
    text_slots: slots,
  };
}

const CASES: Record<string, { q: QueryObject; fuzzy?: boolean }> = {
  "exact: iphone 17 pro": { q: query([["iphone"], ["17"], ["pro"]]) },
  "exact selective: zorbalux phone 17 pro": {
    q: query([["zorbalux"], ["phone"], ["17"], ["pro"]]),
  },
  "exact selective head: zorbalux 128gb": { q: query([["zorbalux"], ["128gb"]]) },
  "exact: kulaklik (alias)": { q: query([["kulaklik", "headphone", "headset"]]) },
  "fuzzy: airpdos pro": { q: query([["airpdos"], ["pro"]]), fuzzy: true },
  "head_only: canta": { q: query([["canta"]]) },
  "constraint only: color+category+brand": {
    q: query([], { color: ["red"], category_path: "pmoda/ayakkabi", brand_include: ["nike2"] }),
  },
};

describe.skipIf(process.env.SEARCH_PERF !== "1")("EXPLAIN ANALYZE", () => {
  for (const [name, { q, fuzzy }] of Object.entries(CASES)) {
    it(name, async () => {
      const db = getTestDb();
      const body = sql`
        EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING ON)
        ${scoredCtes(q, "balanced", false, fuzzy ? FUZZY_TOKEN_THRESHOLD : undefined)}
        SELECT s.*, count(*) OVER()::text AS total_count
        FROM (${distinctImage(sql`scored`)}) s
        ORDER BY ${finalOrder("balanced")}
        LIMIT 48 OFFSET 0`;
      const plan = await db.transaction(async (tx) => {
        if (fuzzy) {
          await tx.execute(
            sql`SELECT set_config('pg_trgm.strict_word_similarity_threshold', ${String(FUZZY_TOKEN_THRESHOLD)}, true)`,
          );
        }
        return tx.execute(body);
      });
      console.info(`\n=== ${name} ===\n${plan.rows.map((r) => r["QUERY PLAN"]).join("\n")}`);
    });
  }
});
