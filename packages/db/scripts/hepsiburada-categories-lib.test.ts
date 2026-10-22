import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseHepsiburadaSitemap, renderSeedMigration } from "./hepsiburada-categories-lib.ts";
import { sha256Hex } from "./trendyol-categories-lib.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const xml = (...locs: string[]) =>
  `<?xml version="1.0"?><urlset>${locs.map((loc) => `<url><loc>${loc}</loc></url>`).join("")}</urlset>`;
const hb = (path: string) => `https://www.hepsiburada.com/${path}`;

test("slug ve kimlik ayrilir; hiyerarsi uretilmez; ayni slug yalniz gozlem olarak isaretlenir", () => {
  const { rows, stats } = parseHepsiburadaSitemap(
    xml(hb("dus-aksesuarlari-c-18021932"), hb("dus-aksesuarlari-c-13003275"), hb("klavyeler-c-1")),
  );
  assert.deepEqual(
    rows.map((row) => [row.id, row.slug, row.name]),
    [
      [18021932, "dus-aksesuarlari", "dus aksesuarlari"],
      [13003275, "dus-aksesuarlari", "dus aksesuarlari"],
      [1, "klavyeler", "klavyeler"],
    ],
  );
  assert.deepEqual(rows[0]?.sameSlugOtherIds, [13003275]);
  assert.equal(stats.slugsSharedByMultipleIds, 1);
  assert.equal("parentId" in (rows[0] ?? {}), false);
});

test("id=0 ve INT_MAX'a yakin kimlikler supheli; digerleri gecerli", () => {
  const { rows, stats } = parseHepsiburadaSitemap(
    xml(hb("hepsiburada-com-c-0"), hb("kitaplar-c-2147483645"), hb("kitaplik-c-123")),
  );
  assert.deepEqual(
    rows.map((row) => [row.id, row.quality, row.qualityReason]),
    [
      [0, "suspect", "id_zero_placeholder"],
      [2147483645, "suspect", "int_max_placeholder_id"],
      [123, "valid", null],
    ],
  );
  assert.deepEqual([stats.valid, stats.suspect], [1, 2]);
});

test("bozuk URL yalniz iki kimlik parcasi ayniysa kurtarilir; digerleri reddedilir", () => {
  const ok = parseHepsiburadaSitemap(
    xml(hb("https://www.hepsiburada.com/sauna-ekipmanlari-c-80857470-c-80857470")),
  );
  assert.equal(ok.rows[0]?.id, 80857470);
  assert.equal(ok.rows[0]?.urlAnomaly, "doubled_host_and_id_suffix");
  assert.throws(() => parseHepsiburadaSitemap(xml(hb("https://www.hepsiburada.com/x-c-1-c-2"))));
  assert.throws(() => parseHepsiburadaSitemap(xml(hb("kategori-yok"))));
  assert.throws(() => parseHepsiburadaSitemap(xml(hb("a-c-1"), hb("b-c-1"))));
  assert.throws(() => parseHepsiburadaSitemap("<html>engel</html>"));
});

test("tohum idempotent ve yalnizca ekleme; hiyerarsi bos; tirnak kacirilir", () => {
  const { rows, stats } = parseHepsiburadaSitemap(xml(hb("kadin-c-1"), hb("Icecekler-c-2")));
  const sql = renderSeedMigration("0099", "abc", stats, rows);
  assert.match(sql, /^-- kind: data/);
  assert.equal((sql.match(/ON CONFLICT/g) ?? []).length, 2);
  assert.doesNotMatch(sql, /\b(UPDATE|DELETE|DROP|TRUNCATE)\b/i);
  assert.doesNotMatch(sql, /\bINTO category\b/);
  assert.match(sql, /'unknown'/);
  assert.match(sql, /slug_case_anomaly/);
});

test("depodaki ham sitemap: 6.320 kayit, 27 supheli; Python arastirma ciktisi ve tohum uyumlu", () => {
  const dir = join(packageRoot, "../../docs/reference/hepsiburada");
  const bytes = readFileSync(join(dir, "categories.raw.xml"));
  const { rows, stats } = parseHepsiburadaSitemap(bytes.toString("utf8"));
  assert.equal(stats.total, 6320);
  assert.equal(stats.suspect, 27);
  assert.equal(stats.valid, 6293);
  assert.equal(new Set(rows.map((row) => row.id)).size, 6320);
  const parsed = JSON.parse(readFileSync(join(dir, "categories.parsed.json"), "utf8")) as {
    categories: { id: number; slug: string; placeholderId: boolean }[];
  };
  assert.deepEqual(
    parsed.categories.map((c) => [c.id, c.slug, c.placeholderId]),
    rows.map((row) => [row.id, row.slug, row.quality === "suspect"]),
  );
  assert.equal(
    readFileSync(
      join(packageRoot, "migrations", "0099_hepsiburada_category_reference_seed.sql"),
      "utf8",
    ),
    renderSeedMigration("0099", sha256Hex(bytes), stats, rows),
  );
});
