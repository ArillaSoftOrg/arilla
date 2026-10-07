/**
 * Yapay zekasiz arama fallback'inin sozlesmesi (docs/decisions/0066).
 *
 * UI -> `searchWithFallback` -> `SearchProvider` -> siralanmis sonuc. Bu dosya
 * saglayicidan bagimsizdir: PostgreSQL'e ozgu hicbir sey (SQL, GUC, trigram
 * esigi) burada gecmez. Bugun saglayici `postgres-provider.ts`; ileride bir
 * OpenSearch saglayicisi ayni `SearchProvider`i uygular, pipeline ve UI
 * degismez.
 */
import type { SearchResultItem } from "../result-types.ts";
import type { QueryFilters, SortMode } from "../types.ts";

/**
 * Saglayicinin anlamasi gereken sorgu. `slots` metin kapisidir: her slot bir
 * alternatif listesi (es anlamlilar/takma adlar), SON slot bas isimdir.
 */
export interface SearchQuery {
  /** Ham sorgu metni; yalnizca tam-metin motorlari icin ipucu. */
  text: string;
  slots: string[][];
  filters: QueryFilters;
  sort: SortMode;
  limit: number;
  offset: number;
  /** Yazim hatasina tolerans: saglayici kendi bulanik eslesme mekanizmasini kullanir. */
  fuzzy: boolean;
}

export interface ProviderPage {
  items: SearchResultItem[];
  /** Saglayicinin bildirdigi toplam (sayfalamadan once). */
  total: number;
}

export interface SearchProvider {
  readonly name: string;
  search(query: SearchQuery): Promise<ProviderPage>;
}

/** Fallback adimlari; `trace.stage` bunlardan biridir. */
export type SearchStageId =
  | "exact"
  | "alias"
  | "fuzzy"
  | "variant_relaxed"
  | "family"
  | "head_only"
  | "constraint_relaxed"
  | "related";

/** Gevsetilen kisit; yalnizca dahili (kullaniciya soylenmez). */
export type Relaxation = `token:${string}` | "color" | "size" | "category" | "typo" | "alias";

export type MatchTier = "exact" | "close" | "related";

export interface MatchInfo {
  tier: MatchTier;
  /** 0..1; sonuc ne kadar yakin. */
  score: number;
  stage: SearchStageId;
  relaxed: Relaxation[];
  /** Sorguda olup urunde bulunmayan tokenlar. */
  missing: string[];
}

export interface RankedSearchItem extends SearchResultItem {
  match: MatchInfo;
}

/**
 * - `results`: gercek eslesme(ler) var; arayuz "Sonuclar" der.
 * - `fallback`: gercek eslesme yok, guvenilir yakin sonuclar var.
 * - `empty`: esigi gecen hicbir sey yok; alakasiz urun gostermeyiz.
 */
export type SearchOutcomeMode = "results" | "fallback" | "empty";

export type FallbackReason = "no_exact_match" | "no_candidates";

/**
 * Gozlemlenebilirlik. `queryNorm` sorgu metnidir: kisisel veri icerebilir, bu
 * yuzden bu nesne loglanmaz; log icin `formatTraceForLog` yalnizca sayi ve
 * sabit kodlari yazar.
 */
export interface SearchTrace {
  queryNorm: string;
  provider: string;
  stage: SearchStageId;
  stagesTried: SearchStageId[];
  mode: SearchOutcomeMode;
  resultCount: number;
  fallbackReason: FallbackReason | null;
  relaxed: Relaxation[];
  latencyMs: number;
  /** Sure butcesi doldu: kalan gevsetme adimlari denenmedi. */
  truncated: boolean;
}

export interface FallbackSearchOutcome {
  mode: SearchOutcomeMode;
  items: RankedSearchItem[];
  /** `results` modunda sayfalama toplami; digerlerinde `items.length`. */
  total: number;
  sort: SortMode;
  trace: SearchTrace;
}
