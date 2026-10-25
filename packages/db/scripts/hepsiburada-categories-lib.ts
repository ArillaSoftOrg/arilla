/**
 * Hepsiburada kategori sitemap'ini (karar 0144) ayristirir ve tohum migration'ini uretir.
 * Saf fonksiyonlar: agdan okumaz, veritabanina yazmaz.
 *
 * Sitemap URL'si yalnizca `<slug>-c-<id>` tasir: ad slug'dan turetilir (Turkce karakter geri
 * getirilmez), HIYERARSI YOKTUR ve uretilmez. Supheli kimlikler (`0`, INT_MAX'a yakin yer
 * tutucular) ayri isaretlenir ve eslestirmeye/siniflandirmaya girmez.
 */
export const SOURCE = "hepsiburada_sitemap";
export const SOURCE_KIND = "sitemap";

/** INT_MAX'in hemen alti: 2147483634..2147483646 yer tutucu / eski ust baslik kimlikleri. */
export const SENTINEL_FROM = 2_147_000_000;

const URL_RE = /^https:\/\/www\.hepsiburada\.com\/([A-Za-z0-9-]+)-c-(\d+)$/;
const DOUBLED_RE =
  /^https:\/\/www\.hepsiburada\.com\/https:\/\/www\.hepsiburada\.com\/([A-Za-z0-9-]+)-c-(\d+)-c-(\d+)$/;

export type Quality = "valid" | "suspect";

export interface HepsiburadaRow {
  id: number;
  slug: string;
  url: string;
  /** Slug'dan turetilmis; `name_basis = 'slug'`. */
  name: string;
  quality: Quality;
  qualityReason: string | null;
  urlAnomaly: string | null;
  slugCaseAnomaly: boolean;
  /** Ayni slug'i tasiyan diger kimlikler (dogrulanmis iliski DEGIL; yalnizca gozlem). */
  sameSlugOtherIds: number[];
}

export interface HepsiburadaStats {
  total: number;
  valid: number;
  suspect: number;
  duplicateIds: number;
  malformedUrls: number;
  slugCaseAnomalies: number;
  slugsSharedByMultipleIds: number;
}

export function parseHepsiburadaSitemap(xml: string): {
  rows: HepsiburadaRow[];
  stats: HepsiburadaStats;
} {
  const text = xml.replace(/^﻿/, "");
  const urlCount = (text.match(/<url>/g) ?? []).length;
  const locs = [...text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => (m[1] ?? "").trim());
  if (urlCount === 0 || urlCount !== locs.length) {
    throw new Error(`sitemap bozuk: ${urlCount} <url>, ${locs.length} <loc>`);
  }
  const rows: HepsiburadaRow[] = [];
  const seen = new Set<number>();
  for (const url of locs) {
    let slug: string;
    let id: number;
    let urlAnomaly: string | null = null;
    const plain = URL_RE.exec(url);
    if (plain) {
      slug = plain[1] as string;
      id = Number(plain[2]);
    } else {
      const doubled = DOUBLED_RE.exec(url);
      // Yalniz iki -c-<id> parcasi AYNI ise kurtarilir (URL'de acik; tahmin degil).
      if (!doubled || doubled[2] !== doubled[3]) throw new Error(`ayristirilamayan URL: ${url}`);
      slug = doubled[1] as string;
      id = Number(doubled[2]);
      urlAnomaly = "doubled_host_and_id_suffix";
    }
    if (!Number.isSafeInteger(id) || id < 0) throw new Error(`gecersiz kimlik: ${url}`);
    if (seen.has(id)) throw new Error(`yinelenen kimlik: ${id}`);
    seen.add(id);
    let quality: Quality = "valid";
    let qualityReason: string | null = null;
    if (id === 0) {
      quality = "suspect";
      qualityReason = "id_zero_placeholder";
    } else if (id >= SENTINEL_FROM) {
      quality = "suspect";
      qualityReason = "int_max_placeholder_id";
    }
    rows.push({
      id,
      slug,
      url,
      name: slug.replaceAll("-", " "),
      quality,
      qualityReason,
      urlAnomaly,
      slugCaseAnomaly: slug !== slug.toLowerCase(),
      sameSlugOtherIds: [],
    });
  }
  const bySlug = new Map<string, number[]>();
  for (const row of rows) bySlug.set(row.slug, [...(bySlug.get(row.slug) ?? []), row.id]);
  for (const row of rows) {
    const ids = bySlug.get(row.slug) ?? [];
    row.sameSlugOtherIds =
      ids.length > 1 ? ids.filter((id) => id !== row.id).sort((a, b) => a - b) : [];
  }
  return {
    rows,
    stats: {
      total: rows.length,
      valid: rows.filter((row) => row.quality === "valid").length,
      suspect: rows.filter((row) => row.quality === "suspect").length,
      duplicateIds: 0,
      malformedUrls: rows.filter((row) => row.urlAnomaly !== null).length,
      slugCaseAnomalies: rows.filter((row) => row.slugCaseAnomaly).length,
      slugsSharedByMultipleIds: [...bySlug.values()].filter((ids) => ids.length > 1).length,
    },
  };
}

const sqlText = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const CHUNK = 400;

/** `source_attrs`: yalnizca bos olmayan gozlemler; ebeveyn/dal bilgisi YOKTUR. */
function attrs(row: HepsiburadaRow): string {
  const out: Record<string, unknown> = {};
  if (row.urlAnomaly) out.url_anomaly = row.urlAnomaly;
  if (row.slugCaseAnomaly) out.slug_case_anomaly = true;
  if (row.sameSlugOtherIds.length > 0) out.same_slug_other_ids = row.sameSlugOtherIds;
  return JSON.stringify(out);
}

/**
 * Tohum migration'i: yalnizca EKLEME, idempotent (`ON CONFLICT DO NOTHING`). Hicbir satirin
 * ebeveyni, derinligi, yolu ya da yaprak bilgisi yoktur (`hierarchy_status = 'unknown'`);
 * `category`, `product` ve siniflandiriciya dokunmaz, esleme yazmaz.
 */
export function renderSeedMigration(
  number: string,
  sha: string,
  stats: HepsiburadaStats,
  rows: readonly HepsiburadaRow[],
): string {
  const out: string[] = [
    "-- kind: data",
    `-- ${number} — Hepsiburada (sitemap) kategori referansi tohumu (karar 0144)`,
    "--",
    "-- URETILMISTIR: packages/db/scripts/hepsiburada-categories.ts --generate (elle duzenleme;",
    "-- `--check` depodaki ham sitemap ile ayni olup olmadigini dogrular).",
    `-- Kaynak: docs/reference/hepsiburada/categories.raw.xml  sha256=${sha}`,
    `-- ${stats.total} kayit: ${stats.valid} gecerli, ${stats.suspect} supheli (id=0 ve INT_MAX'a yakin yer tutucular).`,
    "--",
    "-- Sitemap URL'sinde YALNIZCA slug ve kimlik var: ebeveyn, derinlik, yol, yaprak bilgisi",
    "-- URETILMEZ (hierarchy_status = 'unknown'); ad slug'dan turetilir (name_basis = 'slug').",
    "-- Supheli kayitlar quality = 'suspect' ile saklanir, esleme ve siniflandirmada kullanilmaz.",
    "-- YALNIZCA EKLEME ve IDEMPOTENT: (source, external_id) zaten varsa satir atlanir.",
    "",
    "INSERT INTO external_category_import",
    "  (source, source_sha256, source_kind, category_count, suspect_count, root_count, max_depth)",
    `VALUES (${sqlText(SOURCE)}, ${sqlText(sha)}, ${sqlText(SOURCE_KIND)}, ${stats.total}, ${stats.suspect}, NULL, NULL)`,
    "ON CONFLICT (source, source_sha256) DO NOTHING;",
    "",
  ];
  for (let start = 0; start < rows.length; start += CHUNK) {
    const values = rows
      .slice(start, start + CHUNK)
      .map(
        (row) =>
          `  (${row.id}, ${sqlText(row.name)}, ${sqlText(row.slug)}, ${sqlText(row.url)}, '${row.quality}', ${row.qualityReason ? sqlText(row.qualityReason) : "NULL"}, ${sqlText(attrs(row))})`,
      )
      .join(",\n");
    out.push(
      "INSERT INTO external_category",
      "  (source, external_id, parent_external_id, name, depth, is_leaf, path_ids, path_text,",
      "   hierarchy_status, slug, source_url, name_basis, quality, quality_reason, source_attrs, import_id)",
      `SELECT ${sqlText(SOURCE)}, v.external_id, NULL, v.name, NULL, NULL, NULL, NULL,`,
      "       'unknown', v.slug, v.source_url, 'slug', v.quality, v.quality_reason, v.source_attrs::JSONB,",
      `       (SELECT id FROM external_category_import WHERE source = ${sqlText(SOURCE)} AND source_sha256 = ${sqlText(sha)})`,
      "  FROM (VALUES",
      values,
      ") AS v(external_id, name, slug, source_url, quality, quality_reason, source_attrs)",
      "ON CONFLICT (source, external_id) DO NOTHING;",
      "",
    );
  }
  return out.join("\n");
}
