/**
 * Sorgu servisi kanaryasi (karar 0196): kendi calistirdigimiz sorgu servisinin (TEI) ayni model,
 * revizyon, havuzlama ve normalizasyonla calistigini, resmi referansin ALTIN vektorleriyle dogrular
 * (Python `enrich.canary` ile ayni esik ve ayni vektorler; parite testi dosyalari esitler).
 *
 * Neden: BGE-M3'un yogun vektoru CLS havuzlamadir; yanlis havuzlama (ornek ortalama) NORM kapisindan
 * gecer ama vektor uzayi baska olur ve siralama sessizce bozulur (karar 0182). Yalniz boyut/norm
 * denetimi yetmez.
 *
 * Calisma:
 * - Kapi surec geneli, model basina. Ilk kullanimda kanarya ARKA PLANDA baslar; kapi `passed` olana
 *   kadar sorgu embedding'i `null` doner (arama metin sonucuyla devam eder) — istek beklemez.
 * - Basarili kanarya `passTtlMs` sonra arka planda YENIDEN dogrulanir (sunucu/imaj degisimini yakalar;
 *   dogrulama sirasinda kapi acik kalir, basarisiz olursa kapanir). Basarisiz kanarya `failBackoffMs`
 *   sonra yeniden denenir; arada hicbir gercek sorgu vektoru kullanilmaz.
 * - Kanarya cagrilari onbelleksizdir (onbellek, kaymayi gizlerdi) ve `api_usage`'a yazilmaz: gercek
 *   kullanici sorgusu degildir; sayilari `canaryStatus` ile izlenir.
 */
import type { QueryEmbedder, QueryEmbedResult } from "./query-embedder.ts";

export interface QueryCanaryData {
  model_id: string;
  min_cosine: number;
  dimensions: number;
  cases: { text: string; vector: number[] }[];
}

export type CanaryState = "unknown" | "running" | "passed" | "failed";

export interface CanaryResult {
  ok: boolean;
  /** En dusuk kosinus (olculebildiyse). */
  minCosine: number | null;
  reason: "ok" | "no_vector" | "below_threshold" | "dimension_mismatch";
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  return dot / Math.sqrt(na * nb);
}

/** Altin metinleri servise gonderir, vektorleri referansla karsilastirir. Hicbir zaman firlatmaz. */
export async function runQueryCanary(
  embedder: Pick<QueryEmbedder, "embedQuery">,
  data: QueryCanaryData,
): Promise<CanaryResult> {
  let lowest = 1;
  for (const c of data.cases) {
    let got: QueryEmbedResult | null = null;
    try {
      got = await embedder.embedQuery(c.text);
    } catch {
      got = null;
    }
    if (!got) return { ok: false, minCosine: null, reason: "no_vector" };
    if (got.vector.length !== c.vector.length || c.vector.length !== data.dimensions) {
      return { ok: false, minCosine: null, reason: "dimension_mismatch" };
    }
    lowest = Math.min(lowest, cosine(got.vector, c.vector));
  }
  if (!(lowest >= data.min_cosine)) {
    return { ok: false, minCosine: lowest, reason: "below_threshold" };
  }
  return { ok: true, minCosine: lowest, reason: "ok" };
}

export interface CanaryGateOptions {
  run: () => Promise<CanaryResult>;
  now?: () => number;
  passTtlMs?: number;
  failBackoffMs?: number;
}

export interface CanaryGate {
  state(): CanaryState;
  /** Gecerli bir basari yoksa arka planda kanaryayi baslatir (tek ucus); BEKLEMEZ. */
  kick(): void;
  /** Son sonuc (izleme). */
  last(): { result: CanaryResult; at: number } | null;
  runs(): number;
}

export function createCanaryGate(options: CanaryGateOptions): CanaryGate {
  const now = options.now ?? Date.now;
  const passTtlMs = options.passTtlMs ?? 6 * 3_600_000;
  const failBackoffMs = options.failBackoffMs ?? 5 * 60_000;
  let result: { result: CanaryResult; at: number } | null = null;
  let inflight = false;
  let runs = 0;

  // Basari, TTL dolsa bile yeniden dogrulanirken gecerli sayilir (kisa kesinti olmaz); yeniden
  // dogrulama basarisiz olursa kapi `failed` olur ve gercek vektor kullanilmaz.
  const state = (): CanaryState => {
    if (result === null) return inflight ? "running" : "unknown";
    return result.result.ok ? "passed" : "failed";
  };
  const stale = (): boolean =>
    result === null || now() - result.at >= (result.result.ok ? passTtlMs : failBackoffMs);

  return {
    state,
    last: () => result,
    runs: () => runs,
    kick(): void {
      if (inflight || !stale()) return;
      inflight = true;
      runs += 1;
      void options
        .run()
        .catch((): CanaryResult => ({ ok: false, minCosine: null, reason: "no_vector" }))
        .then((r) => {
          result = { result: r, at: now() };
        })
        .finally(() => {
          inflight = false;
        });
    },
  };
}

/**
 * Kapi `passed` degilken `embedQuery` HEMEN `null` doner (ve kanaryayi baslatir). Kapi acikken gercek
 * embedder'a gecer.
 */
export function withCanaryGate(embedder: QueryEmbedder, gate: CanaryGate): QueryEmbedder {
  return {
    modelVersion: embedder.modelVersion,
    async embedQuery(text: string): Promise<QueryEmbedResult | null> {
      gate.kick(); // gecerli ve taze ise bir sey yapmaz
      if (gate.state() !== "passed") return null;
      return embedder.embedQuery(text);
    },
  };
}

/** Surec geneli kapilar (model basina): istek basina yeni embedder kurulsa da sonuc korunur. */
const gates = new Map<string, CanaryGate>();

export function canaryGateFor(modelVersion: string, make: () => CanaryGate): CanaryGate {
  const existing = gates.get(modelVersion);
  if (existing) return existing;
  const created = make();
  gates.set(modelVersion, created);
  return created;
}

/** Testler icin. */
export function resetCanaryGates(): void {
  gates.clear();
}

export function canaryStatus(): Record<
  string,
  { state: CanaryState; runs: number; minCosine: number | null }
> {
  return Object.fromEntries(
    [...gates].map(([model, gate]) => [
      model,
      { state: gate.state(), runs: gate.runs(), minCosine: gate.last()?.result.minCosine ?? null },
    ]),
  );
}
