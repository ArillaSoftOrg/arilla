/**
 * Anlamsal (vektor) arama ayarlari (karar 0178; olcumler 0170, altyapi 0177).
 *
 * `SEMANTIC_SEARCH_MODE`:
 * - `off` (varsayilan; tanimsiz ya da baska her deger): hicbir model cagrisi, hicbir ek sorgu.
 * - `shadow`: kullaniciya donen sonuc DEGISMEZ; arama bittikten sonra arka planda sorgu vektoru
 *   uretilir, anlamsal adaylar metin sonucuyla karsilastirilir ve yalnizca sayisal olculer
 *   `semantic_shadow_event`'e yazilir.
 * - `on` (karar 0190): anlamsal adaylar metin sonucuyla siralamaya karisir. Yalniz saglayici
 *   saglikli, model uyumlu ve HAZIR bir indeks varken; aksi her durumda ve her hatada sonuc metin
 *   aramasinin birebir aynisidir. Geri alma: bu degiskeni `shadow`/`off` yapmak (tek bayrak).
 */

export type SemanticSearchMode = "off" | "shadow" | "on";

type Env = Readonly<Record<string, string | undefined>>;

export function semanticSearchMode(env: Env = process.env): SemanticSearchMode {
  const value = env.SEMANTIC_SEARCH_MODE?.trim().toLowerCase();
  return value === "shadow" ? "shadow" : value === "on" ? "on" : "off";
}

/** `product_text_embedding.model_version`; sorgu ve urun vektoru AYNI modelden olmak zorundadir. */
export const DEFAULT_SEMANTIC_MODEL = "jina-embeddings-v3";

const MODEL_VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function semanticModelVersion(env: Env = process.env): string {
  const value = env.SEMANTIC_EMBEDDING_MODEL?.trim();
  return value && MODEL_VERSION_PATTERN.test(value) ? value : DEFAULT_SEMANTIC_MODEL;
}

export function isValidModelVersion(value: string): boolean {
  return MODEL_VERSION_PATTERN.test(value);
}

/** `api_usage.operation` (kural 9): golge olcum ve sunumun sorgu embedding cagrilari. */
export const SEMANTIC_QUERY_OPERATION = "semantic_query_embedding";

/** Sorgu embedding'i: kisa zaman asimi, tek deneme, hata -> olcu "no_vector". */
export const SEMANTIC_QUERY_TIMEOUT_MS = 1_500;

/** Aday sorgusunun ust siniri (HNSW yokken tam tarama buyuyen tabloda bununla sinirlanir). */
export const SEMANTIC_CANDIDATE_TIMEOUT_MS = 1_500;

/** En yakin komsu penceresi (suzgecten once). */
export const SEMANTIC_KNN_LIMIT = 400;

/** Suzgec ve baslik korumasindan sonra donen en fazla aday. */
export const SEMANTIC_MAX_CANDIDATES = 120;

/** Gunluk gercek sorgu embedding cagrisi tavani (gölge mod). `api_usage` sayimindan okunur. */
export const DEFAULT_SHADOW_DAILY_CAP = 2_000;

/** Ayni anda en fazla gölge olcum (baglanti havuzunu aramadan almasin). */
export const SHADOW_MAX_IN_FLIGHT = 2;

function boundedInt(raw: string | undefined, fallback: number, max: number): number {
  const value = raw?.trim() ?? "";
  if (!/^[0-9]+$/.test(value)) return fallback;
  return Math.min(Number(value), max);
}

export function shadowDailyCap(env: Env = process.env): number {
  return boundedInt(env.SEMANTIC_SHADOW_DAILY_CAP, DEFAULT_SHADOW_DAILY_CAP, 1_000_000);
}

/** 0-100 arasi yuzde; varsayilan 100 (tavan zaten maliyeti sinirlar). */
export function shadowSamplePercent(env: Env = process.env): number {
  return boundedInt(env.SEMANTIC_SHADOW_SAMPLE_PERCENT, 100, 100);
}

/**
 * Anlamsal-yalniz adayin kabul esikleri. Pilotta jina-embeddings-v3 ile olculerek secildi
 * (karar 0170); mutlak benzerlik modele ozgudur, model degisince yeniden kalibre edilir.
 */
export interface SemanticGate {
  /** Mutlak kosinus benzerligi tabani. */
  minSimilarity: number;
  /** En iyi anlamsal adaydan en fazla bu kadar dusuk benzerlik kabul edilir. */
  maxGapFromBest: number;
  /** Metinde bulunmayan (yalniz anlamsal) en fazla bu kadar urun eklenir. */
  maxSemanticOnly: number;
}

export const DEFAULT_SEMANTIC_GATE: SemanticGate = {
  minSimilarity: 0.3,
  maxGapFromBest: 0.12,
  maxSemanticOnly: 48,
};

/** Reciprocal Rank Fusion sabiti (standart 60). */
export const RRF_K = 60;

/**
 * Sunumda (karar 0190) beklenen HNSW indeks surumu. Indeks adinin `_v<N>` sonekinden okunur;
 * surumsuz ya da farkli surumdeki indeks kullanilmaz (m/ef_construction/opclass degisince artar).
 */
export const SEMANTIC_HNSW_INDEX_VERSION = "1";

export function semanticIndexVersion(env: Env = process.env): string {
  const value = env.SEMANTIC_INDEX_VERSION?.trim() ?? "";
  return /^[0-9]{1,4}$/.test(value) ? value : SEMANTIC_HNSW_INDEX_VERSION;
}

/** Sunumda aday sorgusunun ust siniri (istek yolunda; golgeden kisa). */
export const SEMANTIC_SERVING_SQL_TIMEOUT_MS = 400;

/** Sunumda varsayilan KNN penceresi (secici ef_search vermezse). */
export const SEMANTIC_SERVING_KNN_LIMIT = 150;

/** Kategori istatistigi (sinirli sayim) sorgusunun ust siniri. */
export const SEMANTIC_STATS_TIMEOUT_MS = 250;

/** Bir sayfaya en fazla bu kadar yalniz-anlamsal urun eklenir (metin sonucu hic dusmez). */
export const SEMANTIC_SERVING_MAX_ADDED = 8;

/** Sunumun gunluk gercek sorgu embedding cagrisi tavani (golgeyle ayni sayac, ayri tavan). */
export const DEFAULT_SERVING_DAILY_CAP = 5_000;

export function servingDailyCap(env: Env = process.env): number {
  return boundedInt(env.SEMANTIC_SERVING_DAILY_CAP, DEFAULT_SERVING_DAILY_CAP, 1_000_000);
}
