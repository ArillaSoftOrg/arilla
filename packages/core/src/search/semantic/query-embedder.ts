/**
 * Sorgu metni embedding istemcisi (Jina, `retrieval.query`). Istek yolundaki model cagrisi:
 * CLAUDE.md kural 1 istisnasi (karar 0178); `SEMANTIC_SEARCH_MODE=off` iken hic kurulmaz.
 *
 * Kurallar: tek deneme, kisa zaman asimi, surec geneli LRU onbellek (ayni sorgu iki kez
 * odenmez), hata -> `null` (sahte vektor uretilmez, firlatmaz). Her cagri `onUsage` ile
 * bildirilir (`api_usage`, kural 9; onbellek isabeti `units = 0`). Sorgu metni loga girmez.
 */
import { createHash } from "node:crypto";
import { SEMANTIC_QUERY_TIMEOUT_MS } from "./config.ts";

/** `product_text_embedding.embedding halfvec(768)`. */
export const QUERY_EMBEDDING_DIMENSIONS = 768;

const API_URL = "https://api.jina.ai/v1/embeddings";
const CACHE_LIMIT = 2_000;

/** Surec geneli: istek basina yeni istemci kurulsa da ayni sorgu iki kez odenmez. */
const sharedCache = new Map<string, number[]>();

export interface QueryEmbedUsage {
  modelVersion: string;
  tokens: number;
  cacheHit: boolean;
  latencyMs: number;
}

export interface QueryEmbedResult {
  vector: number[];
  cacheHit: boolean;
  latencyMs: number;
}

export interface QueryEmbedder {
  readonly modelVersion: string;
  /** Hata/zaman asimi/bos sorgu: `null` (asla firlatmaz). */
  embedQuery(text: string): Promise<QueryEmbedResult | null>;
}

export interface JinaQueryEmbedderOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  onUsage?: (usage: QueryEmbedUsage) => void | Promise<void>;
  now?: () => number;
  /** Testler kendi onbellegini verir; varsayilan surec geneli. */
  cache?: Map<string, number[]>;
  /** Aktif indeksin boyutu ve sorgu gorevi (karar 0181); varsayilan 768 / `retrieval.query`. */
  dimensions?: number;
  task?: string;
}

/** Onbellek anahtari: model + kucuk harf, tek bosluk. Metnin kendisi saklanmaz. */
export function queryCacheKey(modelVersion: string, text: string): string | null {
  const normalized = text.trim().toLocaleLowerCase("tr").replace(/\s+/g, " ");
  if (normalized === "") return null;
  return createHash("sha256").update(`${modelVersion}\n${normalized}`).digest("hex");
}

export function createJinaQueryEmbedder(
  apiKey: string,
  modelVersion: string,
  options: JinaQueryEmbedderOptions = {},
): QueryEmbedder {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? SEMANTIC_QUERY_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const cache = options.cache ?? sharedCache;
  const dimensions = options.dimensions ?? QUERY_EMBEDDING_DIMENSIONS;
  const task = options.task ?? "retrieval.query";

  const report = async (usage: QueryEmbedUsage): Promise<void> => {
    try {
      await options.onUsage?.(usage);
    } catch {
      // Olcum kaydi aramayi bozmaz.
    }
  };

  return {
    modelVersion,
    async embedQuery(text: string): Promise<QueryEmbedResult | null> {
      const key = queryCacheKey(modelVersion, text);
      if (key === null) return null;
      const started = now();
      const hit = cache.get(key);
      if (hit) {
        cache.delete(key);
        cache.set(key, hit);
        const latencyMs = now() - started;
        await report({ modelVersion, tokens: 0, cacheHit: true, latencyMs });
        return { vector: hit, cacheHit: true, latencyMs };
      }
      try {
        const response = await fetchImpl(API_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: modelVersion,
            task,
            dimensions,
            normalized: true,
            embedding_type: "float",
            input: [text.trim().replace(/\s+/g, " ")],
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          return null;
        }
        const payload = (await response.json()) as {
          data?: { embedding?: unknown }[];
          usage?: { total_tokens?: number };
        };
        const raw = payload.data?.[0]?.embedding;
        if (!Array.isArray(raw) || raw.length !== dimensions) return null;
        const vector = raw.map(Number);
        if (!vector.every(Number.isFinite)) return null;
        if (cache.size >= CACHE_LIMIT) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(key, vector);
        const latencyMs = now() - started;
        await report({
          modelVersion,
          tokens: payload.usage?.total_tokens ?? 0,
          cacheHit: false,
          latencyMs,
        });
        return { vector, cacheHit: false, latencyMs };
      } catch {
        return null;
      }
    },
  };
}
