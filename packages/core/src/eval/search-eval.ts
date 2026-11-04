/**
 * Arama degerlendirme ozeti (Faz 1A). Saf: `run-eval.ts`'in urettigi satirlari
 * (kayitli JSON de olabilir) metriklere cevirir. Veritabani gerektirmez, bu
 * yuzden iki kosu CI'da ya da yerelde cevrimdisi karsilastirilabilir.
 */
import {
  compareRuns,
  type Direction,
  type MetricChange,
  mean,
  ndcgAtK,
  precisionAtK,
  zeroResultRate,
} from "./metrics.ts";

/** `EvalRow`'un ozetin ihtiyac duydugu kesiti (DB tiplerine bagimli degil). */
export interface SearchEvalRow {
  q: string;
  absent: boolean;
  returned: number;
  relevance: readonly number[];
  relevantInCatalog: number;
  zeroResultCorrect: boolean | null;
  usedFallback: boolean;
  /** Ilk 10 sonucun urun kimlikleri, sira korunur. v1 ciktilarinda yok. */
  topIds?: readonly number[];
  /** Sonucun geldigi arama asamasi. v1 ciktilarinda yok. */
  stage?: string;
}

export interface SearchSummary {
  queries: number;
  /** Katalogda karsiligi olan sorgular uzerinden. */
  scoredQueries: number;
  precisionAt5: number;
  ndcgAt10: number;
  /** Tum sorgularda bos donme orani (fallback oncesi degil, sonrasi). */
  zeroResultRate: number;
  /** Karsiligi olmayan ("absent") sorgularda dogru sekilde bos donme orani. */
  absentCorrectRate: number;
  /** Karsiligi olan sorgularda hic ilgili sonuc donmeyen sorgu orani. */
  missRate: number;
}

export function summarizeSearch(rows: readonly SearchEvalRow[]): SearchSummary {
  const scored = rows.filter((r) => r.zeroResultCorrect === null);
  const absent = rows.filter((r) => r.zeroResultCorrect !== null);
  return {
    queries: rows.length,
    scoredQueries: scored.length,
    precisionAt5: mean(scored.map((r) => precisionAtK(r.relevance, 5))),
    // Ideal sira katalogdaki ilgili urun sayisindan kurulur (en fazla 10).
    ndcgAt10: mean(
      scored.map((r) => ndcgAtK(r.relevance, 10, Array(Math.min(10, r.relevantInCatalog)).fill(1))),
    ),
    zeroResultRate: zeroResultRate(rows.map((r) => r.returned)),
    absentCorrectRate: mean(absent.map((r) => (r.zeroResultCorrect ? 1 : 0))),
    missRate: mean(scored.map((r) => (r.relevance.some((x) => x > 0) ? 0 : 1))),
  };
}

export const SEARCH_DIRECTIONS: Record<
  keyof Omit<SearchSummary, "queries" | "scoredQueries">,
  Direction
> = {
  precisionAt5: "higher",
  ndcgAt10: "higher",
  zeroResultRate: "lower",
  absentCorrectRate: "higher",
  missRate: "lower",
};

export function compareSearch(
  baseline: SearchSummary,
  current: SearchSummary,
  tolerance = 0.01,
): MetricChange[] {
  return compareRuns({ ...baseline }, { ...current }, SEARCH_DIRECTIONS, tolerance);
}

// ---- Kosu zarfi ve kimlik bazli karsilastirma (karar 0171 G6) ----------------

/** `--json` ciktisinin bicimi. v1: yalnizca satir dizisi (eski kosular). */
export const SEARCH_EVAL_FORMAT = "arilla.search-eval/v2";

/** Degerlendirmenin yuruttugu arama yolu. */
export type SearchEvalEngine =
  /** `resolveQuery` + `search()`, bos sonucta filtresiz 6'li yedek (0029; varsayilan). */
  | "legacy"
  /** `/ara`'nin kademeli yolu: `searchWithFallback` (0066). */
  | "fallback";

/** Magaza kapsami: bootstrap katalogu, tum aktif magazalar ya da acik liste. */
export type SearchEvalScope =
  | { kind: "bootstrap" }
  | { kind: "all_active" }
  | { kind: "merchants"; merchantIds: readonly number[] };

/** Iki kosunun karsilastirilabilir olup olmadigini belirleyen katalog ozeti. */
export interface SearchEvalCatalog {
  /** Kapsama giren magazalar, artan sirali. */
  merchantIds: readonly number[];
  /** Kapsamda aktif teklifi olan yayimlanmis urun sayisi. */
  products: number;
  /** Kapsamdaki aktif teklif sayisi. */
  activeOffers: number;
  maxProductId: number | null;
  maxOfferId: number | null;
  /** Yukaridaki alanlarin sha256 ozeti (ilk 16 hex). */
  fingerprint: string;
}

export interface SearchEvalMeta {
  format: typeof SEARCH_EVAL_FORMAT;
  createdAt: string;
  codeRef: string;
  engine: SearchEvalEngine;
  scope: SearchEvalScope;
  catalog: SearchEvalCatalog;
  dataset: { name: string; queries: number; sha256: string };
}

export interface SearchEvalRun<Row extends SearchEvalRow = SearchEvalRow> {
  meta: SearchEvalMeta | null;
  rows: Row[];
}

/** `--scope` degeri: `bootstrap` | `all` | `merchants:1,2,3`. Gecersizse null. */
export function parseSearchEvalScope(value: string | undefined): SearchEvalScope | null {
  if (value === undefined || value === "bootstrap") return { kind: "bootstrap" };
  if (value === "all") return { kind: "all_active" };
  const match = /^merchants:(\d+(?:,\d+)*)$/.exec(value);
  if (!match?.[1]) return null;
  const ids = [...new Set(match[1].split(",").map(Number))].sort((a, b) => a - b);
  return { kind: "merchants", merchantIds: ids };
}

/** `--engine` degeri; verilmezse `legacy` (eski davranis). Gecersizse null. */
export function parseSearchEvalEngine(value: string | undefined): SearchEvalEngine | null {
  if (value === undefined || value === "legacy") return "legacy";
  if (value === "fallback") return "fallback";
  return null;
}

/** Katalog parmak izi: ayni kapsam + ayni sayilar = ayni deger. */
export function catalogFingerprint(
  catalog: Omit<SearchEvalCatalog, "fingerprint">,
  hash: (text: string) => string,
): string {
  const canonical = JSON.stringify([
    [...catalog.merchantIds].sort((a, b) => a - b),
    catalog.products,
    catalog.activeOffers,
    catalog.maxProductId,
    catalog.maxOfferId,
  ]);
  return hash(canonical).slice(0, 16);
}

/**
 * `--json` dosyasini okur. v1 (satir dizisi) ve v2 (zarf) kabul edilir; v1'de
 * `meta` null'dir ve kimlik karsilastirmasi yapilamaz.
 */
export function parseSearchEvalFile(data: unknown): SearchEvalRun {
  if (Array.isArray(data)) return { meta: null, rows: data as SearchEvalRow[] };
  if (
    data !== null &&
    typeof data === "object" &&
    (data as { meta?: { format?: unknown } }).meta?.format === SEARCH_EVAL_FORMAT &&
    Array.isArray((data as { rows?: unknown }).rows)
  ) {
    return data as SearchEvalRun;
  }
  throw new Error("tanınmayan arama değerlendirme dosyası (v1 dizi ya da v2 zarf bekleniyor)");
}

/** Iki kosunun ayni katalog, kapsam ve veri setiyle uretilip uretilmedigi. */
export function comparabilityIssues(
  base: SearchEvalMeta | null,
  current: SearchEvalMeta | null,
): string[] {
  if (base === null || current === null) return ["v1 çıktısı: katalog metadata'sı yok"];
  const issues: string[] = [];
  if (base.catalog.fingerprint !== current.catalog.fingerprint) {
    issues.push(
      `katalog parmak izi farklı (${base.catalog.fingerprint} → ${current.catalog.fingerprint})`,
    );
  }
  if (base.dataset.sha256 !== current.dataset.sha256) issues.push("sorgu seti farklı");
  if (JSON.stringify(base.scope) !== JSON.stringify(current.scope))
    issues.push("mağaza kapsamı farklı");
  return issues;
}

export interface QueryIdDiff {
  q: string;
  identical: boolean;
  /** Iki ilk-10 listesinde ortak urun sayisi. */
  overlap: number;
  added: number[];
  removed: number[];
  baseStage: string | null;
  currentStage: string | null;
}

export interface IdComparison {
  /** Iki kosuda da kimligi olan sorgular. */
  compared: number;
  identical: number;
  /** Ortak urun / uzun listenin boyu, sorgu ortalamasi (iki liste de bossa 1). */
  meanOverlapAt10: number;
  /** Yalnizca bir kosuda olan ya da kimligi olmayan sorgular. */
  unmatched: string[];
  diffs: QueryIdDiff[];
}

/**
 * Ilk 10 urun kimligi uzerinden sorgu bazinda karsilastirma. Sira degisikligi
 * de "ayni degil" sayilir; ortak urun sayisi sirayi yok sayar.
 */
export function compareRunIds(
  base: readonly SearchEvalRow[],
  current: readonly SearchEvalRow[],
): IdComparison {
  const byQuery = new Map(current.map((row) => [row.q, row]));
  const seen = new Set<string>();
  const diffs: QueryIdDiff[] = [];
  const unmatched: string[] = [];
  for (const b of base) {
    const c = byQuery.get(b.q);
    seen.add(b.q);
    if (!c || !b.topIds || !c.topIds) {
      unmatched.push(b.q);
      continue;
    }
    const baseSet = new Set(b.topIds);
    const currentSet = new Set(c.topIds);
    diffs.push({
      q: b.q,
      identical:
        b.topIds.length === c.topIds.length && b.topIds.every((id, i) => c.topIds?.[i] === id),
      overlap: c.topIds.filter((id) => baseSet.has(id)).length,
      added: c.topIds.filter((id) => !baseSet.has(id)),
      removed: b.topIds.filter((id) => !currentSet.has(id)),
      baseStage: b.stage ?? null,
      currentStage: c.stage ?? null,
    });
  }
  for (const c of current) if (!seen.has(c.q)) unmatched.push(c.q);
  return {
    compared: diffs.length,
    identical: diffs.filter((d) => d.identical).length,
    meanOverlapAt10: mean(
      diffs.map((d) => {
        const size = d.overlap + Math.max(d.added.length, d.removed.length);
        return size === 0 ? 1 : d.overlap / size;
      }),
    ),
    unmatched,
    diffs,
  };
}
