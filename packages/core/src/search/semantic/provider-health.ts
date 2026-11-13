/**
 * Sorgu embedding saglayicisinin sagligi (karar 0190): anahtarin TANIMLI olmasi servisin
 * KULLANILABILIR oldugu anlamina gelmez. Surec ici devre kesici; veritabani ya da ag okumaz.
 *
 * - `auth` / `quota` (401/402/403, ornek Jina "Insufficient balance"): devre uzun sure acilir;
 *   bu surede hicbir ucretli cagri denenmez. Otomatik bakiye yukleme YOKTUR.
 * - `rate_limited` (429): kisa bekleme.
 * - `server` / `timeout` / `network` / `bad_payload`: art arda `failureThreshold` hatada kisa bekleme.
 * - `client` (diger 4xx): istek bicimi hatasi; devreyi acmaz ama sayilir.
 * Bekleme bitince tek bir deneme (yari acik) yapilir; basarisizsa devre yeniden acilir.
 */
import type { QueryEmbedFailure } from "./query-embedder.ts";

export interface ProviderHealthConfig {
  authOpenMs: number;
  rateLimitOpenMs: number;
  transientOpenMs: number;
  failureThreshold: number;
}

export const DEFAULT_PROVIDER_HEALTH: Readonly<ProviderHealthConfig> = Object.freeze({
  authOpenMs: 15 * 60_000,
  rateLimitOpenMs: 60_000,
  transientOpenMs: 30_000,
  failureThreshold: 3,
});

const PROBE_TIMEOUT_MS = 10_000;

export type ProviderState = "closed" | "open" | "half_open";

export interface ProviderHealthSnapshot {
  state: ProviderState;
  lastFailure: QueryEmbedFailure | null;
  consecutiveFailures: number;
  openUntil: number | null;
}

export interface ProviderHealth {
  /** Bu an bir gercek cagri denenebilir mi? (yari acikta yalniz bir deneme) */
  allow(): boolean;
  success(): void;
  failure(kind: QueryEmbedFailure): void;
  snapshot(): ProviderHealthSnapshot;
}

export function createProviderHealth(
  config: Partial<ProviderHealthConfig> = {},
  now: () => number = Date.now,
): ProviderHealth {
  const c = { ...DEFAULT_PROVIDER_HEALTH, ...config };
  let openUntil: number | null = null;
  /** Yari acik denemenin basladigi an; deneme hic sonuclanmazsa (onbellek isabeti) 10 sn sonra serbest. */
  let probingSince: number | null = null;
  let consecutive = 0;
  let lastFailure: QueryEmbedFailure | null = null;

  const state = (): ProviderState => {
    if (openUntil === null) return "closed";
    return now() < openUntil ? "open" : "half_open";
  };

  return {
    allow() {
      const s = state();
      if (s === "closed") return true;
      if (s === "open") return false;
      const t = now();
      if (probingSince !== null && t - probingSince < PROBE_TIMEOUT_MS) return false;
      probingSince = t;
      return true;
    },
    success() {
      openUntil = null;
      probingSince = null;
      consecutive = 0;
      lastFailure = null;
    },
    failure(kind) {
      lastFailure = kind;
      consecutive += 1;
      probingSince = null;
      const t = now();
      if (kind === "auth" || kind === "quota") openUntil = t + c.authOpenMs;
      else if (kind === "rate_limited") openUntil = t + c.rateLimitOpenMs;
      else if (kind === "client") {
        if (state() === "half_open") openUntil = t + c.transientOpenMs;
      } else if (consecutive >= c.failureThreshold || state() === "half_open") {
        openUntil = t + c.transientOpenMs;
      }
    },
    snapshot() {
      return { state: state(), lastFailure, consecutiveFailures: consecutive, openUntil };
    },
  };
}

/** Surec geneli saglik (model basina). */
const shared = new Map<string, ProviderHealth>();

export function providerHealthFor(modelVersion: string): ProviderHealth {
  let health = shared.get(modelVersion);
  if (!health) {
    health = createProviderHealth();
    shared.set(modelVersion, health);
  }
  return health;
}

/** Testler icin. */
export function resetProviderHealth(): void {
  shared.clear();
}
