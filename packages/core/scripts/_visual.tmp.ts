import { createDatabase } from "@arilla/db";
import { sql } from "drizzle-orm";
import { embedUploadedImage } from "../src/embedding/embed-uploaded-image.ts";
import { searchByImageVector } from "../src/search/visual-search.ts";
const db = createDatabase(process.env.DATABASE_URL as string);
const picks = await db.execute<{ slug: string; product_id: string; image_url: string; title: string }>(sql`
  SELECT DISTINCT ON (m.slug) m.slug, o.product_id::text, o.image_url, o.title_raw AS title
    FROM embedding e JOIN offer o ON o.id = e.target_id JOIN merchant m ON m.id = o.merchant_id
   WHERE e.model_version = 'jina-clip-v2' AND e.kind = 'image' AND e.target_type = 'offer'
     AND m.slug IN ('derimod','manu-atelier-tr','halicizade-hali-kilim','wraith-esports')
   ORDER BY m.slug, o.id`);
for (const pick of picks.rows) {
  const url = pick.image_url + (pick.image_url.includes("?") ? "&" : "?") + "width=1024";
  const res = await fetch(url);
  const bytes = Buffer.from(await res.arrayBuffer());
  const t0 = performance.now();
  const emb = await embedUploadedImage(db, { bytes, mimeType: res.headers.get("content-type") ?? "image/jpeg", sessionId: "qa-sprint-0029", userId: null });
  const t1 = performance.now();
  const hits = await searchByImageVector(db, emb.vector, "jina-clip-v2", { limit: 5 });
  const t2 = performance.now();
  const rank = hits.findIndex((h) => String(h.productId) === pick.product_id) + 1;
  console.log(`${pick.slug.padEnd(22)} kendi urunu sira=${rank || "-"} embed=${(t1 - t0).toFixed(0)}ms ann=${(t2 - t1).toFixed(0)}ms | ${hits.map((h) => `${h.title.slice(0, 28)} (${h.similarityScore.toFixed(2)})`).join(" ; ")}`);
}
const usage = await db.execute(sql`SELECT count(*)::int n, sum(units)::int tokens FROM api_usage WHERE session_id = 'qa-sprint-0029'`);
console.log("api_usage", usage.rows[0]);
process.exit(0);
