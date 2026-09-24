import { createDatabase } from "@arilla/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { search } from "../src/search/search.ts";
const db = createDatabase(process.env.DATABASE_URL as string);
const dialect = new PgDialect();
const orig = db.execute.bind(db);
(db as any).execute = async (q: any) => {
  const { sql: text, params } = dialect.sqlToQuery(q);
  const client = (db as any).$client;
  const r = await client.query(`EXPLAIN (ANALYZE, COSTS OFF) ${text}`, params);
  console.log(r.rows.map((x: any) => x["QUERY PLAN"]).filter((l: string) => /Semi|Hash Join|Nested|Bitmap|Scan on product|SubPlan|Aggregate|Execution|loops=[0-9]{3,}/.test(l)).slice(0, 25).join("\n"));
  return orig(q);
};
const base = { intent: "browse", anchor: null, filters: {}, style_tags: [], sort: "balanced", confidence: 1 } as const;
await search(db, { ...base, text: "yoga matı", unparsed: "yoga matı" } as never, { limit: 24 });
process.exit(0);
