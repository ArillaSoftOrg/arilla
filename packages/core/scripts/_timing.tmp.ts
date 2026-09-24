import { createDatabase } from "@arilla/db";
import { search } from "../src/search/search.ts";
const db = createDatabase(process.env.DATABASE_URL as string);
const base = { intent: "browse", anchor: null, filters: {}, style_tags: [], sort: "balanced", confidence: 1 } as const;
for (const q of ["halı", "siyah spor ayakkabı", "yoga matı", "termos", ""]) {
  const times: number[] = [];
  let n = 0;
  for (let i = 0; i < 6; i++) {
    const t = performance.now();
    const r = await search(db, { ...base, text: q, unparsed: q } as never, { limit: 24 });
    times.push(performance.now() - t); n = r.items.length;
  }
  times.sort((a, b) => a - b);
  console.log(JSON.stringify(q), "n=", n, "p50~", times[3]?.toFixed(0), "ms min", times[0]?.toFixed(0));
}
process.exit(0);
