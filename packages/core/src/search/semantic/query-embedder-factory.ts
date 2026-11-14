/**
 * Aktif indeksin sorgu embedder'ini kurar (karar 0196). Sunum (`serving.ts`) ve golge olcum
 * (`shadow.ts`) AYNI fabrikayi kullanir; model/saglayici eslesmesi tek yerde.
 *
 * - `jina`: `JINA_API_KEY` yoksa `null` (`no_api_key`).
 * - `remote_http`: adres `index.endpoint.urlEnv` ortam degiskeninden; gecersizse ya da yoksa `null`
 *   (`no_endpoint`). Servis, kanarya kapisindan GECENE kadar sorgu vektoru uretmez
 *   (`query-canary.ts`): havuzlama/revizyon uyumsuzlugu sessizce siralamayi bozmaz.
 * - Her gercek cagri `api_usage`'a yazilir (kural 9). Kendi servisimiz: maliyet 0.
 */
import { apiUsage, type Database } from "@arilla/db";
import { costMicrosPerThousandTokens } from "../../embedding/embed-uploaded-image.ts";
import type { SemanticIndex } from "./active-index.ts";
import { SEMANTIC_QUERY_OPERATION } from "./config.ts";
import canaryJson from "./golden/bge-m3-5617a9f6-query-canary.json" with { type: "json" };
import type { ProviderHealth } from "./provider-health.ts";
import {
  canaryGateFor,
  createCanaryGate,
  type QueryCanaryData,
  runQueryCanary,
  withCanaryGate,
} from "./query-canary.ts";
import {
  createJinaQueryEmbedder,
  type QueryEmbedder,
  type QueryEmbedUsage,
} from "./query-embedder.ts";
import { createRemoteQueryEmbedder, endpointProblem } from "./remote-query-embedder.ts";

type Env = Readonly<Record<string, string | undefined>>;

export type EmbedderUnavailable = "no_api_key" | "no_endpoint" | "no_canary";

export interface EmbedderChoice {
  embedder: QueryEmbedder | null;
  /** `embedder === null` iken neden (sabit kucuk sozluk). */
  reason: EmbedderUnavailable | null;
}

/** Modele ozel altin sorgular (yalniz kanarya kaydi olan modeller `remote_http` ile sunulabilir). */
const CANARY_DATA: Readonly<Record<string, QueryCanaryData>> = {
  "bge-m3-5617a9f6": canaryJson as unknown as QueryCanaryData,
};

const CANARY_TIMEOUT_MS = 8_000;

function recordUsage(db: Database, env: Env, costFree: boolean) {
  return async (usage: QueryEmbedUsage): Promise<void> => {
    await db.insert(apiUsage).values({
      sessionId: null,
      userId: null,
      operation: SEMANTIC_QUERY_OPERATION,
      modelVersion: usage.modelVersion,
      units: usage.tokens,
      costMicros: costFree
        ? 0
        : Math.round((usage.tokens * costMicrosPerThousandTokens(env)) / 1000),
      cacheHit: usage.cacheHit,
    });
  };
}

export function createQueryEmbedderForIndex(
  db: Database,
  env: Env,
  index: SemanticIndex,
  health?: ProviderHealth,
): EmbedderChoice {
  const hooks = health
    ? {
        onFailure: (failure: Parameters<ProviderHealth["failure"]>[0]) => health.failure(failure),
        onSuccess: () => health.success(),
      }
    : {};

  if ((index.provider ?? "jina") === "jina") {
    const apiKey = env.JINA_API_KEY?.trim();
    if (!apiKey) return { embedder: null, reason: "no_api_key" };
    return {
      embedder: createJinaQueryEmbedder(apiKey, index.modelVersion, {
        dimensions: index.dimensions,
        task: index.queryTask,
        ...hooks,
        onUsage: recordUsage(db, env, false),
      }),
      reason: null,
    };
  }

  const endpoint = index.endpoint;
  const baseUrl = endpoint ? env[endpoint.urlEnv]?.trim() : undefined;
  if (!endpoint || endpointProblem(baseUrl) !== null || !baseUrl) {
    return { embedder: null, reason: "no_endpoint" };
  }
  const canary = CANARY_DATA[index.modelVersion];
  if (!canary || canary.dimensions !== index.dimensions) {
    return { embedder: null, reason: "no_canary" };
  }
  const token = env[endpoint.tokenEnv]?.trim() || undefined;
  const config = { baseUrl, servedModel: endpoint.servedModel, ...(token ? { token } : {}) };
  const real = createRemoteQueryEmbedder(config, index.modelVersion, index.dimensions, {
    ...hooks,
    onUsage: recordUsage(db, env, true),
  });
  // Kanarya: onbelleksiz, kendi (daha uzun) zaman asimi, saglik sayacini ve api_usage'i etkilemez.
  const gate = canaryGateFor(index.modelVersion, () =>
    createCanaryGate({
      run: () =>
        runQueryCanary(
          createRemoteQueryEmbedder(config, index.modelVersion, index.dimensions, {
            cache: new Map(),
            timeoutMs: CANARY_TIMEOUT_MS,
          }),
          canary,
        ),
    }),
  );
  return { embedder: withCanaryGate(real, gate), reason: null };
}
