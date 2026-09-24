import { createDatabase } from "@arilla/db";
import { sql } from "drizzle-orm";
import { resolveQuery } from "../src/search/query-resolution.ts";
import { search } from "../src/search/search.ts";
const db = createDatabase(process.env.DATABASE_URL as string);
for (const q of ["koltuk", "kanepe", "minder", "berjer", "puf", "sehpa", "tişört", "halı", "termos", "klavye"]) {
  const { parsed } = await resolveQuery(db, q);
  const r = await search(db, parsed, { limit: 24 });
  const ids = r.items.map((i) => i.productId);
  if (ids.length === 0) { console.log(q, "0"); continue; }
  const rows = await db.execute<{ img: string; src: string }>(sql`
    SELECT p.primary_image_url img, (SELECT m.slug || ':' || (o.attributes_raw->>'id') FROM offer o JOIN merchant m ON m.id=o.merchant_id WHERE o.product_id=p.id LIMIT 1) src
      FROM product p WHERE p.id = ANY(${sql.param(ids)}::bigint[])`);
  const imgs = new Set(rows.rows.map((x) => x.img)); const srcs = new Set(rows.rows.map((x) => x.src));
  console.log(q.padEnd(8), "sonuc", ids.length, "farkli gorsel", imgs.size, "farkli kaynak urun", srcs.size);
}
process.exit(0);
