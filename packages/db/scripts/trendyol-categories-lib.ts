/**
 * Trendyol urun kategori agacini (karar 0143) ayristirir, butunlugunu dogrular ve tohum
 * migration'ini uretir. Saf fonksiyonlar: agdan okumaz, veritabanina yazmaz.
 *
 * Trendyol kimlikleri `external_category` icindedir ve ManiCepte `category.id` ile KARISMAZ.
 */
import { createHash } from "node:crypto";

export const SOURCE = "trendyol";

export interface TrendyolNode {
  /** Trendyol kategori kimligi (dahili `category.id` DEGIL). */
  id: number;
  name: string;
  parentId: number | null;
  /** Kok = 1. */
  depth: number;
  isLeaf: boolean;
  /** Kokten bu dugume Trendyol kimlikleri (dugumun kendisi dahil). */
  pathIds: number[];
  /** "Giyim > Kadin > Elbise" */
  pathText: string;
}

export interface TrendyolStats {
  total: number;
  roots: number;
  leaves: number;
  maxDepth: number;
  perDepth: Record<string, number>;
  duplicateIds: number[];
}

export function sha256Hex(raw: Uint8Array | string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Ham JSON'u duz, kaynak sirasini koruyan (derinlik oncelikli) listeye cevirir.
 * Butunluk bozuksa HATA verir; eksik ya da uydurma kategori uretmez.
 */
export function parseTrendyolTree(raw: string): { nodes: TrendyolNode[]; stats: TrendyolStats } {
  const doc: unknown = JSON.parse(raw);
  const roots = (doc as { categories?: unknown } | null)?.categories;
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new Error("categories dizisi yok ya da bos");
  }
  const nodes: TrendyolNode[] = [];
  const seen = new Set<number>();
  const duplicateIds: number[] = [];

  const walk = (
    value: unknown,
    parentId: number | null,
    parentPath: number[],
    parentText: string[],
  ): void => {
    const node = value as {
      id?: unknown;
      name?: unknown;
      parentId?: unknown;
      subCategories?: unknown;
    };
    if (typeof node.id !== "number" || !Number.isSafeInteger(node.id) || node.id <= 0) {
      throw new Error(`gecersiz kategori kimligi: ${JSON.stringify(node.id)}`);
    }
    if (typeof node.name !== "string" || node.name.trim() === "") {
      throw new Error(`kategori ${node.id}: ad bos`);
    }
    if ((node.parentId ?? null) !== parentId) {
      throw new Error(`kategori ${node.id}: parentId ${node.parentId} != ${parentId}`);
    }
    const subs = node.subCategories ?? [];
    if (!Array.isArray(subs)) throw new Error(`kategori ${node.id}: subCategories dizi degil`);
    if (seen.has(node.id)) {
      duplicateIds.push(node.id);
      throw new Error(`yinelenen kategori kimligi: ${node.id}`);
    }
    seen.add(node.id);
    const pathIds = [...parentPath, node.id];
    const pathNames = [...parentText, node.name.trim()];
    nodes.push({
      id: node.id,
      name: node.name.trim(),
      parentId,
      depth: pathIds.length,
      isLeaf: subs.length === 0,
      pathIds,
      pathText: pathNames.join(" > "),
    });
    for (const sub of subs) walk(sub, node.id, pathIds, pathNames);
  };
  for (const root of roots) walk(root, null, [], []);

  const perDepth: Record<string, number> = {};
  for (const node of nodes) perDepth[String(node.depth)] = (perDepth[String(node.depth)] ?? 0) + 1;
  return {
    nodes,
    stats: {
      total: nodes.length,
      roots: roots.length,
      leaves: nodes.filter((node) => node.isLeaf).length,
      maxDepth: Math.max(...nodes.map((node) => node.depth)),
      perDepth,
      duplicateIds,
    },
  };
}

/** Ayristirilmis agac dosyasi: dugum basina bir satir (diff ve inceleme icin). */
export function renderParsedJson(
  sha: string,
  stats: TrendyolStats,
  nodes: readonly TrendyolNode[],
): string {
  const head = JSON.stringify({ source: SOURCE, sourceSha256: sha, stats });
  const rows = nodes.map((node) => `    ${JSON.stringify(node)}`).join(",\n");
  return `${head.slice(0, -1)},"categories":[\n${rows}\n  ]}\n`;
}

const sqlText = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const CHUNK = 400;

/**
 * Tohum migration'i: yalnizca EKLEME, idempotent (`ON CONFLICT DO NOTHING`); var olan satirin
 * uzerine yazmaz. `category` tablosuna dokunmaz. Geri alma: karar 0143 §6.
 */
export function renderSeedMigration(
  number: string,
  sha: string,
  stats: TrendyolStats,
  nodes: readonly TrendyolNode[],
): string {
  const out: string[] = [
    "-- kind: data",
    `-- ${number} — Trendyol kategori referans agaci tohumu (karar 0143)`,
    "--",
    "-- URETILMISTIR: packages/db/scripts/trendyol-categories.ts --generate (elle duzenleme;",
    "-- `--check` depodaki ham JSON ile ayni olup olmadigini dogrular).",
    `-- Kaynak: docs/reference/trendyol/product-categories.raw.json  sha256=${sha}`,
    `-- ${stats.total} kategori, ${stats.roots} ana kategori, en fazla ${stats.maxDepth} seviye, ${stats.leaves} yaprak.`,
    "--",
    "-- YALNIZCA EKLEME ve IDEMPOTENT: (source, external_id) zaten varsa satir atlanir.",
    "-- `category` (ManiCepte agaci), urun ve siniflandirici DEGISMEZ; hicbir esleme yazilmaz.",
    "",
    "INSERT INTO external_category_import (source, source_sha256, category_count, root_count, max_depth)",
    `VALUES (${sqlText(SOURCE)}, ${sqlText(sha)}, ${stats.total}, ${stats.roots}, ${stats.maxDepth})`,
    "ON CONFLICT (source, source_sha256) DO NOTHING;",
    "",
  ];
  for (let start = 0; start < nodes.length; start += CHUNK) {
    const rows = nodes
      .slice(start, start + CHUNK)
      .map(
        (node) =>
          `  (${node.id}, ${node.parentId ?? "NULL"}, ${sqlText(node.name)}, ${node.depth}, ${node.isLeaf ? "TRUE" : "FALSE"}, '{${node.pathIds.join(",")}}', ${sqlText(node.pathText)})`,
      )
      .join(",\n");
    out.push(
      "INSERT INTO external_category",
      "  (source, external_id, parent_external_id, name, depth, is_leaf, path_ids, path_text, import_id)",
      `SELECT ${sqlText(SOURCE)}, v.external_id, v.parent_external_id, v.name, v.depth, v.is_leaf,`,
      "       v.path_ids::BIGINT[], v.path_text,",
      `       (SELECT id FROM external_category_import WHERE source = ${sqlText(SOURCE)} AND source_sha256 = ${sqlText(sha)})`,
      "  FROM (VALUES",
      rows,
      ") AS v(external_id, parent_external_id, name, depth, is_leaf, path_ids, path_text)",
      "ON CONFLICT (source, external_id) DO NOTHING;",
      "",
    );
  }
  return out.join("\n");
}
