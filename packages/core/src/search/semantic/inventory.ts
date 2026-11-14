/**
 * Anlamsal indeks ENVANTERI ve kategori istatistigi (karar 0190). Migration YOK: envanter
 * PostgreSQL katalogundan (`pg_index`) okunur, istatistik sinirli sayimla hesaplanir.
 *
 * Bir HNSW indeksi yalniz su kosullarin HEPSI tutarsa `ready` sayilir:
 * - erisim yontemi `hnsw`, tek kolon `embedding`, ifade yok, opclass `halfvec_cosine_ops`
 *   (sorgu `<=>` kullanir);
 * - kolon tipi aktif indeksin boyutunda (`halfvec(<dims>)`);
 * - kosul TAM OLARAK `model_version = '<model>'` (baska modelin vektoru karismaz);
 * - adi `_v<N>` ile biter (indeks surumu; beklenen surumle eslesmeli, secici denetler);
 * - `indisvalid && indisready && indislive` (CONCURRENTLY kurulumu bitmis).
 * Bunlardan biri tutmayan indeks envantere `building`/`invalid` olarak girer ya da hic girmez;
 * secici (karar 0189) hazir olmayan indeksi asla secmez.
 *
 * `btree_category`: `product(category_id)` uzerinde tek kolonlu, gecerli B-tree.
 *
 * Okunamayan envanter `null`dir: secici guvenli geri donuse (`legacy_postfilter`) gider ve sunum
 * (serving.ts) bu durumda anlamsal adayi HIC calistirmaz.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { SEMANTIC_TABLES, type SemanticIndex } from "./active-index.ts";
import { isValidModelVersion } from "./config.ts";
import {
  type CategoryStat,
  type IndexDescriptor,
  type IndexState,
  isSafeCategoryLiteral,
} from "./strategy.ts";

export type PgIndexRow = {
  name: string;
  table: string;
  am: string;
  predicate: string | null;
  opclass: string;
  column: string;
  column_type: string;
  valid: boolean;
  ready: boolean;
  live: boolean;
  natts: number;
  has_expressions: boolean;
};

const MODEL_PREDICATE = /^\(model_version = '([a-z0-9][a-z0-9._-]{0,63})'::text\)$/;
const VERSION_SUFFIX = /_v([0-9]{1,4})$/;

function stateOf(row: PgIndexRow): IndexState {
  if (!row.valid) return row.ready ? "invalid" : "building";
  if (!row.ready || !row.live) return "building";
  return "ready";
}

/** Saf: katalog satirlarindan secicinin envanteri. Taninmayan indeks atlanir (neden listesiyle). */
export function descriptorsFromRows(
  rows: readonly PgIndexRow[],
  index: SemanticIndex,
): { descriptors: IndexDescriptor[]; skipped: string[] } {
  const descriptors: IndexDescriptor[] = [];
  const skipped: string[] = [];
  for (const row of rows) {
    if (row.table === "product") {
      if (
        row.am === "btree" &&
        row.column === "category_id" &&
        row.natts === 1 &&
        !row.has_expressions &&
        row.predicate === null
      ) {
        descriptors.push({
          id: row.name,
          kind: "btree_category",
          modelVersion: null,
          indexVersion: null,
          scope: { type: "global" },
          state: stateOf(row),
        });
      }
      continue;
    }
    if (row.table !== index.table || row.am !== "hnsw") continue;
    if (row.column !== "embedding" || row.natts !== 1 || row.has_expressions) {
      skipped.push(`kolon:${row.name}`);
      continue;
    }
    if (row.opclass !== "halfvec_cosine_ops") {
      skipped.push(`opclass:${row.name}`);
      continue;
    }
    if (row.column_type !== `halfvec(${index.dimensions})`) {
      skipped.push(`boyut:${row.name}`);
      continue;
    }
    const model = row.predicate === null ? null : MODEL_PREDICATE.exec(row.predicate)?.[1];
    if (!model || !isValidModelVersion(model)) {
      // Kosulsuz (karisik modelli tablo) ya da baska kosullu indeks: model uzayi garanti degil.
      skipped.push(`kosul:${row.name}`);
      continue;
    }
    descriptors.push({
      id: row.name,
      kind: "global_hnsw",
      modelVersion: model,
      indexVersion: VERSION_SUFFIX.exec(row.name)?.[1] ?? null,
      scope: { type: "global" },
      state: stateOf(row),
    });
  }
  return { descriptors, skipped };
}

async function readPgIndexes(db: Database, table: string): Promise<PgIndexRow[]> {
  const rows = await db.execute<PgIndexRow>(sql`
    SELECT ic.relname AS name, tc.relname AS "table", am.amname AS am,
           pg_get_expr(i.indpred, i.indrelid) AS predicate,
           opc.opcname AS opclass, a.attname AS "column",
           format_type(a.atttypid, a.atttypmod) AS column_type,
           i.indisvalid AS valid, i.indisready AS ready, i.indislive AS live,
           i.indnatts::int AS natts, (i.indexprs IS NOT NULL) AS has_expressions
      FROM pg_index i
      JOIN pg_class ic ON ic.oid = i.indexrelid
      JOIN pg_class tc ON tc.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = tc.relnamespace AND n.nspname = 'public'
      JOIN pg_am am ON am.oid = ic.relam
      JOIN pg_opclass opc ON opc.oid = i.indclass[0]
      LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
     WHERE tc.relname IN (${table}, 'product')
  `);
  return rows.rows.map((row) => ({ ...row, natts: Number(row.natts) }));
}

export const INVENTORY_TTL_MS = 60_000;

let inventoryCache: { key: string; at: number; value: IndexDescriptor[] | null } | null = null;

export function resetInventoryCache(): void {
  inventoryCache = null;
  statCache.clear();
}

export interface InventoryDeps {
  now?: () => number;
  readIndexes?: (db: Database, table: string) => Promise<PgIndexRow[]>;
}

/** Envanter (60 sn onbellek). Okunamazsa `null`: secici guvenli geri donus yapar. */
export async function loadSemanticInventory(
  db: Database,
  index: SemanticIndex,
  deps: InventoryDeps = {},
): Promise<IndexDescriptor[] | null> {
  const now = deps.now ?? Date.now;
  const key = `${index.table}:${index.dimensions}`;
  if (
    inventoryCache &&
    inventoryCache.key === key &&
    now() - inventoryCache.at < INVENTORY_TTL_MS
  ) {
    return inventoryCache.value;
  }
  let value: IndexDescriptor[] | null;
  try {
    value = descriptorsFromRows(
      await (deps.readIndexes ?? readPgIndexes)(db, index.table),
      index,
    ).descriptors;
  } catch {
    value = null;
  }
  inventoryCache = { key, at: now(), value };
  return value;
}

export const CATEGORY_STAT_TTL_MS = 10 * 60_000;
const STAT_CACHE_LIMIT = 2_000;
const statCache = new Map<string, CategoryStat>();

export interface CategoryStatRequest {
  index: SemanticIndex;
  modelVersion: string;
  path: string;
  /** Sayim bu degerde kesilir (`cap + 1` = "buyuk"). */
  cap: number;
  timeoutMs: number;
}

/**
 * Kategoride (alt kategoriler dahil) vektoru olan yayindaki urun sayisi, `cap + 1`de kesilir:
 * tum kategori taranmaz. Zaman asiminda `null` (secici istatistiksiz guvenli yola gider).
 * Tablo adi yalniz beyaz listeden (`SemanticIndex.table`); yol ve model PARAMETRE.
 */
async function countCategory(db: Database, r: CategoryStatRequest): Promise<number> {
  if (!SEMANTIC_TABLES.includes(r.index.table)) {
    throw new Error("gecersiz embedding tablosu");
  }
  // `LIKE` joker tasimasin: yalniz guvenli yol bicimi (karar 0190).
  if (!isSafeCategoryLiteral(r.path)) throw new Error("gecersiz kategori yolu");
  const table = sql.raw(r.index.table);
  const rows = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('statement_timeout', ${String(r.timeoutMs)}, true)`);
    return tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM (
        SELECT 1
          FROM product p
          JOIN ${table} e ON e.product_id = p.id AND e.model_version = ${r.modelVersion}
         WHERE p.category_id IN (
                 SELECT id FROM category WHERE path = ${r.path} OR path LIKE ${r.path} || '/%')
           AND p.publication_state = 'published'
         LIMIT ${r.cap + 1}
      ) s
    `);
  });
  return Number(rows.rows[0]?.n ?? 0);
}

export interface CategoryStatDeps {
  now?: () => number;
  count?: (db: Database, request: CategoryStatRequest) => Promise<number>;
}

export async function loadCategoryStat(
  db: Database,
  request: CategoryStatRequest,
  deps: CategoryStatDeps = {},
): Promise<CategoryStat | null> {
  const now = deps.now ?? Date.now;
  const key = `${request.index.table}:${request.modelVersion}:${request.cap}:${request.path}`;
  const hit = statCache.get(key);
  if (hit && now() - hit.computedAt.getTime() < CATEGORY_STAT_TTL_MS) return hit;
  try {
    const rows = await (deps.count ?? countCategory)(db, request);
    const stat: CategoryStat = { path: request.path, rows, computedAt: new Date(now()) };
    if (statCache.size >= STAT_CACHE_LIMIT) {
      const oldest = statCache.keys().next().value;
      if (oldest !== undefined) statCache.delete(oldest);
    }
    statCache.set(key, stat);
    return stat;
  } catch {
    return null;
  }
}
