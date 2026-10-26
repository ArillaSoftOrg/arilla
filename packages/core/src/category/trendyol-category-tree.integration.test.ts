/**
 * Trendyol kategori ağacının aktif ağaca entegrasyonu (karar 0153, migration 0102).
 * Gerçek Postgres: migration uygulanmış veritabanını doğrular (eşleme eksiksizliği, hiyerarşi,
 * mevcut 158 kategorinin korunması, tekrar çalıştırma, geri alma, ürün ilişkileri, arama
 * davranışı). Veritabanını kalıcı değiştirmez: geri alma ve yazma denemeleri işlem içinde
 * ROLLBACK edilir; fixture satırları temizlenir.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { foldedTextExpr, resolveSlotLookups } from "../search/text-match.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const read = (relative: string) => readFileSync(join(repoRoot, relative), "utf8");
const migrationSql = read("packages/db/migrations/0102_trendyol_category_tree.sql");
const rollbackSql = read("docs/reference/trendyol/category-tree-rollback.sql");
const baseline = read("docs/reference/categories/manicepte-baseline-158.tsv")
  .split("\n")
  .slice(1)
  .filter((line) => line.trim() !== "")
  .map((line) => {
    const [path, slug, name, discoverable] = line.split("\t");
    return {
      path: path ?? "",
      slug: slug ?? "",
      name: name ?? "",
      discoverable: discoverable === "1",
    };
  });

const suffix = Date.now().toString(36);
/** Migration gövdesi: `DO $$ ... $$;` bloğu (başlıktaki yorumlar atılır). */
const migrationBody = migrationSql.slice(migrationSql.indexOf("DO $$"));

async function counts(client: import("pg").Client) {
  const res = await client.query<{ categories: string; maps: string }>(
    `SELECT (SELECT count(*) FROM category) AS categories,
            (SELECT count(*) FROM external_category_map WHERE source = 'trendyol') AS maps`,
  );
  return { categories: Number(res.rows[0]?.categories), maps: Number(res.rows[0]?.maps) };
}

describe("Trendyol kategori ağacı entegrasyonu (migration 0102) - gerçek Postgres", () => {
  const db: Database = getTestDb();
  const productSlugs: string[] = [];

  afterAll(async () => {
    if (productSlugs.length === 0) return;
    await withOwnerClient((client) =>
      client.query("DELETE FROM product WHERE slug = ANY($1::text[])", [productSlugs]),
    );
  });

  it("3.867 Trendyol kategorisinin tamamı eşlenmiş ya da oluşturulmuş (eksik, fazla ve çift yok)", async () => {
    const rows = await withOwnerClient((client) =>
      client.query<{
        ext: string;
        mapped: string;
        unmapped: string;
        created: string;
        exact: string;
      }>(
        `SELECT (SELECT count(*) FROM external_category WHERE source = 'trendyol') AS ext,
                (SELECT count(*) FROM external_category_map WHERE source = 'trendyol') AS mapped,
                (SELECT count(*) FROM external_category_usage
                  WHERE source = 'trendyol' AND usage = 'unmapped') AS unmapped,
                (SELECT count(*) FROM external_category_map
                  WHERE source = 'trendyol' AND note = 'created') AS created,
                (SELECT count(*) FROM external_category_map
                  WHERE source = 'trendyol' AND note = 'exact_name') AS exact`,
      ),
    );
    expect(rows.rows[0]).toEqual({
      ext: "3867",
      mapped: "3867",
      unmapped: "0",
      created: "3862",
      exact: "5",
    });
  });

  it("hiyerarşi korunur: ebeveyn, derinlik, ad ve görünürlük Trendyol ile tutarlı", async () => {
    const bad = await withOwnerClient(async (client) => {
      const parentMismatch = await client.query(
        `SELECT count(*) AS n FROM external_category ec
           JOIN external_category_map m ON m.source = ec.source AND m.external_id = ec.external_id
           JOIN category c ON c.id = m.category_id
           LEFT JOIN external_category_map pm
             ON pm.source = ec.source AND pm.external_id = ec.parent_external_id
          WHERE ec.source = 'trendyol' AND m.note = 'created'
            AND c.parent_id IS DISTINCT FROM pm.category_id`,
      );
      const depthMismatch = await client.query(
        `SELECT count(*) AS n FROM external_category ec
           JOIN external_category_map m ON m.source = ec.source AND m.external_id = ec.external_id
           JOIN category c ON c.id = m.category_id
          WHERE ec.source = 'trendyol'
            AND array_length(string_to_array(c.path, '/'), 1) <> ec.depth`,
      );
      const nameMismatch = await client.query(
        `SELECT count(*) AS n FROM external_category ec
           JOIN external_category_map m ON m.source = ec.source AND m.external_id = ec.external_id
           JOIN category c ON c.id = m.category_id
          WHERE ec.source = 'trendyol' AND m.note = 'created' AND c.name <> ec.name`,
      );
      const visible = await client.query(
        `SELECT count(*) AS n FROM external_category_map m JOIN category c ON c.id = m.category_id
          WHERE m.source = 'trendyol' AND m.note = 'created' AND c.is_discoverable`,
      );
      return [parentMismatch, depthMismatch, nameMismatch, visible].map((r) => Number(r.rows[0].n));
    });
    expect(bad).toEqual([0, 0, 0, 0]);
  });

  it("ağaç boyutu: ana kategoriler, azami derinlik, yol/slug benzersizliği", async () => {
    const stats = await withOwnerClient(async (client) => {
      const res = await client.query<{
        total: string;
        roots: string;
        max_depth: string;
        dup_paths: string;
        orphan: string;
      }>(
        `SELECT count(*) AS total,
                count(*) FILTER (WHERE parent_id IS NULL) AS roots,
                max(array_length(string_to_array(path, '/'), 1)) AS max_depth,
                (SELECT count(*) FROM (SELECT path FROM category GROUP BY path HAVING count(*) > 1) d) AS dup_paths,
                count(*) FILTER (WHERE parent_id IS NOT NULL
                                   AND NOT EXISTS (SELECT 1 FROM category p WHERE p.id = category.parent_id)) AS orphan
           FROM category`,
      );
      return res.rows[0];
    });
    // Üretim: 158 + 3.862 = 4.020 kategori, 23 ana kategori. Tohumlu test DB'si birkaç satır fazla.
    expect(Number(stats?.total)).toBeGreaterThanOrEqual(4020);
    expect(Number(stats?.roots)).toBeGreaterThanOrEqual(23);
    expect(Number(stats?.max_depth)).toBe(6);
    expect(Number(stats?.dup_paths)).toBe(0);
    expect(Number(stats?.orphan)).toBe(0);
  });

  it("mevcut 158 kategori birebir korunur (slug, yol, ad, ebeveyn yolu, keşfet bayrağı)", async () => {
    const res = await withOwnerClient((client) =>
      client.query<{ n: string }>(
        `SELECT count(*) AS n
           FROM unnest($1::text[], $2::text[], $3::text[], $4::boolean[]) AS t(path, slug, name, disc)
           JOIN category c ON c.path = t.path AND c.slug = t.slug AND c.name = t.name
                          AND c.is_discoverable = t.disc
           LEFT JOIN category p ON p.id = c.parent_id
          WHERE coalesce(p.path, '') = coalesce(nullif(regexp_replace(t.path, '/?[^/]+$', ''), ''), '')`,
        [
          baseline.map((b) => b.path),
          baseline.map((b) => b.slug),
          baseline.map((b) => b.name),
          baseline.map((b) => b.discoverable),
        ],
      ),
    );
    expect(baseline).toHaveLength(158);
    expect(Number(res.rows[0]?.n)).toBe(158);
  });

  it("tekrar çalıştırma: hiçbir satır eklenmez, hiçbir şey değişmez (idempotent)", async () => {
    const result = await withOwnerClient(async (client) => {
      const notices: string[] = [];
      client.on("notice", (n) => notices.push(n.message ?? ""));
      const before = await counts(client);
      const ids = await client.query<{ h: string }>(
        "SELECT md5(string_agg(id || ':' || slug || ':' || path || ':' || name, ',' ORDER BY id)) AS h FROM category",
      );
      await client.query("BEGIN");
      try {
        await client.query(migrationBody);
        const during = await counts(client);
        const after = await client.query<{ h: string }>(
          "SELECT md5(string_agg(id || ':' || slug || ':' || path || ':' || name, ',' ORDER BY id)) AS h FROM category",
        );
        return { before, during, same: ids.rows[0]?.h === after.rows[0]?.h, notices };
      } finally {
        await client.query("ROLLBACK");
      }
    });
    expect(result.during).toEqual(result.before);
    expect(result.same).toBe(true);
    expect(result.notices.join("\n")).toMatch(
      /0 eslesti, 0 olusturuldu, 3867 zaten islenmisti, 0 UYDURULMADAN atlandi/,
    );
  });

  it("mevcut ürünlerin kategori ilişkileri tekrar çalıştırmada değişmez", async () => {
    const slug = `t0153-${suffix}`;
    productSlugs.push(slug);
    const { categoryId, after } = await withOwnerClient(async (client) => {
      const cat = await client.query<{ id: string }>(
        "SELECT id FROM category WHERE path = 'elektronik/telefon' LIMIT 1",
      );
      const categoryId = Number(cat.rows[0]?.id);
      await client.query("INSERT INTO product (slug, title, category_id) VALUES ($1, 'Test', $2)", [
        slug,
        categoryId,
      ]);
      await client.query("BEGIN");
      try {
        await client.query(migrationBody);
        const row = await client.query<{ category_id: string }>(
          "SELECT category_id FROM product WHERE slug = $1",
          [slug],
        );
        return { categoryId, after: Number(row.rows[0]?.category_id) };
      } finally {
        await client.query("ROLLBACK");
      }
    });
    expect(after).toBe(categoryId);
  });

  it("geri alma betiği yalnız oluşturulanları siler, mevcutlara dokunmaz; işlem sonunda ROLLBACK ile her şey yerinde", async () => {
    const result = await withOwnerClient(async (client) => {
      const before = await counts(client);
      await client.query("SET statement_timeout = '30s'");
      await client.query("BEGIN");
      try {
        // Dosyadaki BEGIN/COMMIT atılır: işlem testin kontrolündedir ve ROLLBACK ile biter.
        const body = rollbackSql.replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, "");
        await client.query(body);
        const during = await counts(client);
        const baselineLeft = await client.query<{ n: string }>(
          "SELECT count(*) AS n FROM category WHERE path = ANY($1::text[])",
          [baseline.map((b) => b.path)],
        );
        return { before, during, baselineLeft: Number(baselineLeft.rows[0]?.n) };
      } finally {
        await client.query("ROLLBACK");
      }
    });
    expect(result.during.maps).toBe(0);
    expect(result.before.categories - result.during.categories).toBe(3862);
    expect(result.baselineLeft).toBe(158);
    const restored = await withOwnerClient((client) => counts(client));
    expect(restored).toEqual(result.before);
  });

  it("geri alma, oluşturulan bir kategoriye ürün bağlıysa HATA verir ve hiçbir şey silmez", async () => {
    const slug = `t0153g-${suffix}`;
    productSlugs.push(slug);
    const outcome = await withOwnerClient(async (client) => {
      const created = await client.query<{ id: string }>(
        `SELECT c.id FROM category c JOIN external_category_map m ON m.category_id = c.id
          WHERE m.source = 'trendyol' AND m.note = 'created' AND c.path = 'giyim/ic-giyim' LIMIT 1`,
      );
      const categoryId = Number(created.rows[0]?.id);
      await client.query("INSERT INTO product (slug, title, category_id) VALUES ($1, 'Test', $2)", [
        slug,
        categoryId,
      ]);
      const before = await counts(client);
      let failed = false;
      await client.query("BEGIN");
      try {
        const body = rollbackSql.replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, "");
        await client.query(body);
      } catch {
        failed = true;
      } finally {
        await client.query("ROLLBACK");
      }
      return { failed, before, after: await counts(client) };
    });
    expect(outcome.failed).toBe(true);
    expect(outcome.after).toEqual(outcome.before);
  });

  it("arama: kök kategori adı eşleşmesi eski sorguyla AYNI kimlikleri verir (yeniden yazım davranışı korur)", async () => {
    const slots = [
      ["giyim"],
      ["elektronik"],
      ["bebek"],
      ["kitap"],
      ["spor"],
      ["supermarket"],
      ["mobilya"],
    ];
    const lookups = await resolveSlotLookups(db, slots);
    for (const [index, slot] of slots.entries()) {
      // Eski formülasyon: her kategori için kökü yolun ilk bölümünden bulunur.
      const legacy = await db.execute<{ id: string }>(sql`
        SELECT DISTINCT cc.id::text AS id FROM category cc
          JOIN category cr ON cr.path = split_part(cc.path, '/', 1)
          JOIN unnest(${sql.param([1])}::int[], ${sql.param(slot)}::text[]) AS h(i, t)
            ON h.t <<% ${foldedTextExpr(sql`cr.name`)}`);
      expect(
        [...(lookups[index]?.categoryIds ?? [])].map(String).sort(),
        `slot ${slot.join(" ")}`,
      ).toEqual(legacy.rows.map((r) => r.id).sort());
    }
    // Yeni (boş) ana kategoriler ürün kümesini değiştirmez: ürünü olan kategori yalnız eskilerdir.
    const withProducts = await withOwnerClient((client) =>
      client.query<{ n: string }>(
        `SELECT count(*) AS n FROM product p JOIN external_category_map m
             ON m.category_id = p.category_id AND m.note = 'created'
          WHERE m.source = 'trendyol' AND p.slug NOT LIKE 't0153%'`,
      ),
    );
    expect(Number(withProducts.rows[0]?.n)).toBe(0);
  });
});
