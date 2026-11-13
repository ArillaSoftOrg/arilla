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

/**
 * Basarisizligin sinifi (karar 0190; saglayici sagligi icin). Yanit govdesi, anahtar ve sorgu
 * metni TASINMAZ.
 */
export type QueryEmbedFailure =
  | "auth"
  | "quota"
  | "rate_limited"
  | "server"
  | "client"
  | "timeout"
  | "network"
  | "bad_payload";

export function classifyHttpFailure(status: number): QueryEmbedFailure {
  if (status === 401) return "auth";
  // Jina bakiye bitince 402/403 doner ("Insufficient balance"); ikisi de odeme/kota.
  if (status === 402 || status === 403) return "quota";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server";
  return "client";
}

export interface JinaQueryEmbedderOptions {
  fetch?: typeof fetch;
  /** Basarisiz cagri sinifi (onbellek isabeti ve bos sorgu cagrilmaz). Firlatirsa yutulur. */
  onFailure?: (failure: QueryEmbedFailure) => void;
  /** Basarili gercek cagri (saglayici sagligini sifirlar). */
  onSuccess?: () => void;
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

  const fail = (failure: QueryEmbedFailure): null => {
    try {
      options.onFailure?.(failure);
    } catch {
      // Saglik kaydi aramayi bozmaz.
    }
    return null;
  };

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
          return fail(classifyHttpFailure(response.status));
        }
        const payload = (await response.json()) as {
          data?: { embedding?: unknown }[];
          usage?: { total_tokens?: number };
        };
        const raw = payload.data?.[0]?.embedding;
        if (!Array.isArray(raw) || raw.length !== dimensions) return fail("bad_payload");
        const vector = raw.map(Number);
        if (!vector.every(Number.isFinite)) return fail("bad_payload");
        try {
          options.onSuccess?.();
        } catch {
          // Saglik kaydi aramayi bozmaz.
        }
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
      } catch (error) {
        const name = (error as { name?: string } | null)?.name;
        if (name === "TimeoutError" || name === "AbortError") return fail("timeout");
        return fail(name === "SyntaxError" ? "bad_payload" : "network");
      }
    },
  };
}
