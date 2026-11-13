/**
 * `/ara` ve `/sohbet`in ORTAK arama alani (karar 0190). Iki yuzey de ayni adimlari ayni sirayla
 * kullanir; metin aramasi (`searchWithFallback`) ve IntentV2 degismez.
 *
 * 1. `prepareSearchFilters`: metin kaynakli kesin kategori katalogda dogrulanir; yoksa yumusak
 *    ipucuna duser (`verifyTextCategory`). Kategori agaci okunamazsa bugunku davranis.
 * 2. Metin aramasi (cagiranda).
 * 3. `serveSemantic`: `SEMANTIC_SEARCH_MODE=on` degilse hicbir I/O yapmaz ve sonucu aynen doner;
 *    aciksa `applySemanticServing` (her hata -> metin sonucu aynen).
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { verifyTextCategory } from "./category-source.ts";
import type { FallbackSearchOutcome } from "./fallback/types.ts";
import {
  applySemanticServing,
  type ServingDeps,
  type ServingTelemetry,
} from "./semantic/serving.ts";
import { isSafeCategoryLiteral } from "./semantic/strategy.ts";
import type { QueryObject, SortMode } from "./types.ts";

export const CATEGORY_PATH_TTL_MS = 10 * 60_000;
const PATH_CACHE_LIMIT = 5_000;
const pathCache = new Map<string, { at: number; exists: boolean }>();

export function resetCategoryPathCache(): void {
  pathCache.clear();
}

/**
 * Yol kategori agacinda var mi (tam yol; `category_path_idx`)? Guvensiz bicim `false`.
 * Okunamazsa `null` (cagiran bugunku davranisi korur). 10 dk surec ici onbellek.
 */
export async function categoryPathExists(
  db: Database,
  path: string,
  now: () => number = Date.now,
): Promise<boolean | null> {
  if (!isSafeCategoryLiteral(path)) return false;
  const hit = pathCache.get(path);
  if (hit && now() - hit.at < CATEGORY_PATH_TTL_MS) return hit.exists;
  try {
    const rows = await db.execute<{ ok: boolean }>(
      sql`SELECT EXISTS (SELECT 1 FROM category WHERE path = ${path}) AS ok`,
    );
    const exists = rows.rows[0]?.ok === true;
    if (pathCache.size >= PATH_CACHE_LIMIT) {
      const oldest = pathCache.keys().next().value;
      if (oldest !== undefined) pathCache.delete(oldest);
    }
    pathCache.set(path, { at: now(), exists });
    return exists;
  } catch {
    return null;
  }
}

/** Metin kaynakli kesin kategoriyi dogrular (1. adim). Hicbir zaman firlatmaz. */
export async function prepareSearchFilters(
  db: Database,
  parsed: QueryObject,
  deps: { exists?: (db: Database, path: string) => Promise<boolean | null> } = {},
): Promise<QueryObject> {
  const path = parsed.filters.category_path;
  if (parsed.filters.category_source !== "explicit_text_verified" || !path) return parsed;
  const exists = await (deps.exists ?? categoryPathExists)(db, path);
  const known = exists === null ? null : new Set(exists ? [path] : []);
  const filters = verifyTextCategory(parsed.filters, known);
  return filters === parsed.filters ? parsed : { ...parsed, filters };
}

export interface SemanticServeContext {
  /** Embed edilecek metin; bossa `parsed.unparsed`, o da bossa `parsed.text`. */
  semanticText?: string;
  page: number;
  sort: SortMode;
}

/** 3. adim: anlamsal sunum. Kapaliyken I/O yok, sonuc aynen doner. */
export async function serveSemantic(
  db: Database,
  parsed: QueryObject,
  outcome: FallbackSearchOutcome,
  context: SemanticServeContext,
  deps: ServingDeps = {},
): Promise<{ outcome: FallbackSearchOutcome; telemetry: ServingTelemetry }> {
  const remainder = parsed.unparsed.trim();
  const semanticText = context.semanticText ?? (remainder === "" ? parsed.text : remainder);
  const served = await applySemanticServing(
    db,
    {
      semanticText,
      queryText: parsed.text,
      filters: parsed.filters,
      items: outcome.items,
      mode: outcome.mode,
      page: context.page,
      sort: context.sort,
    },
    deps,
  );
  if (served.items === outcome.items) return { outcome, telemetry: served.telemetry };
  return { outcome: { ...outcome, items: [...served.items] }, telemetry: served.telemetry };
}
