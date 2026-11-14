/**
 * Sorgu metni embedding istemcisi, kendi cikarim servisi (`remote_http`; TEI/Infinity/vLLM; karar 0182,
 * 0196). Istek yolundaki model cagrisi: CLAUDE.md kural 1 istisnasi (karar 0178); `SEMANTIC_SEARCH_MODE`
 * `off` iken hic kurulmaz.
 *
 * Sozlesme (Python `RemoteHttpTextProvider` ile ayni uzay korumasi):
 * - OpenAI uyumlu `POST {url}/v1/embeddings`; sorgu metni ONEKSIZ gonderilir (BGE-M3 yogun vektoru
 *   sorgu/pasaj icin ayni, resmi onek yok) ve yalniz bosluklari sadelestirilir.
 * - Yanittaki `model` alani servisin bildirdigi (`served_model`) ile AYNI olmali; boyut sabit, tum
 *   degerler sonlu ve norm ~1 olmali. Biri tutmazsa vektor KULLANILMAZ (`bad_payload`): yanlis havuzlama
 *   ya da yanlis model sessizce siralamayi bozmasin.
 * - Tek deneme, kisa zaman asimi, surec geneli LRU onbellek (model + sorgu), hata -> `null` (sahte
 *   vektor uretilmez, firlatmaz). Her cagri `onUsage` ile bildirilir (`api_usage`, kural 9; kendi
 *   servisimiz: maliyet 0).
 * - Adres: HTTPS ya da yerel/ozel ag (loopback, RFC1918, tek etiketli Docker servis adi). Kimlik
 *   bilgisi, sorgu, parca yok. Anahtar (`Authorization`), adres ve sorgu metni hicbir hata/log
 *   ciktisina GIRMEZ.
 */
import { SEMANTIC_QUERY_TIMEOUT_MS } from "./config.ts";
import {
  classifyHttpFailure,
  type QueryEmbedder,
  type QueryEmbedFailure,
  type QueryEmbedResult,
  type QueryEmbedUsage,
  queryCacheKey,
} from "./query-embedder.ts";

const CACHE_LIMIT = 2_000;
/** Birim norm toleransi: yanlis havuzlama/normalizasyon bu esigi asar (ham BGE-M3 CLS normu ~1 degildir). */
export const NORM_TOLERANCE = 0.02;

/** Surec geneli: istek basina yeni istemci kurulsa da ayni sorgu iki kez gomulmez. */
const sharedCache = new Map<string, number[]>();

export interface RemoteEndpointConfig {
  /** Servis kok adresi (`http://embed-query:8080`). */
  baseUrl: string;
  /** Servisin bildirdigi model adi (TEI `--served-model-name`); yanitta ayni olmali. */
  servedModel: string;
  /** Opsiyonel taşıyıcı anahtar; yalniz `Authorization` basligina gider. */
  token?: string;
}

export type EndpointProblem =
  | "empty"
  | "invalid_url"
  | "credentials_in_url"
  | "query_or_fragment"
  | "path_not_root"
  | "plain_http_public_host";

/** RFC1918, loopback ya da tek etiketli ad (Docker servis adi) mi? */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return !host.includes(".") && /^[a-z0-9-]+$/.test(host);
}

/** Adres kurallari; geçerliyse `null`, degilse sabit bir neden (adresin kendisi ASLA donmez). */
export function endpointProblem(raw: string | undefined): EndpointProblem | null {
  const value = raw?.trim() ?? "";
  if (value === "") return "empty";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "invalid_url";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "invalid_url";
  if (url.username !== "" || url.password !== "") return "credentials_in_url";
  if (url.search !== "" || url.hash !== "") return "query_or_fragment";
  if (url.pathname !== "/" && url.pathname !== "") return "path_not_root";
  if (url.protocol === "http:" && !isPrivateHost(url.hostname)) return "plain_http_public_host";
  return null;
}

export interface RemoteQueryEmbedderOptions {
  fetch?: typeof fetch;
  onFailure?: (failure: QueryEmbedFailure) => void;
  onSuccess?: () => void;
  timeoutMs?: number;
  onUsage?: (usage: QueryEmbedUsage) => void | Promise<void>;
  now?: () => number;
  /** Testler kendi onbellegini verir; varsayilan surec geneli. `new Map()` onbellegi devre disi birakir. */
  cache?: Map<string, number[]>;
}

function norm(vector: readonly number[]): number {
  let sum = 0;
  for (const v of vector) sum += v * v;
  return Math.sqrt(sum);
}

/** Servis yaniti vektor uzayi kapisindan gecer mi? Gecerse vektor, degilse `null`. */
export function acceptVector(
  payload: unknown,
  servedModel: string,
  dimensions: number,
): { vector: number[]; tokens: number } | null {
  const p = payload as {
    model?: unknown;
    data?: { embedding?: unknown }[];
    usage?: { total_tokens?: unknown; prompt_tokens?: unknown };
  } | null;
  if (!p || typeof p !== "object") return null;
  if (p.model !== servedModel) return null;
  const raw = p.data?.[0]?.embedding;
  if (!Array.isArray(raw) || raw.length !== dimensions) return null;
  const vector = raw.map(Number);
  if (!vector.every(Number.isFinite)) return null;
  if (Math.abs(norm(vector) - 1) > NORM_TOLERANCE) return null;
  const tokens = Number(p.usage?.total_tokens ?? p.usage?.prompt_tokens ?? 0);
  return { vector, tokens: Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : 0 };
}

export function createRemoteQueryEmbedder(
  endpoint: RemoteEndpointConfig,
  modelVersion: string,
  dimensions: number,
  options: RemoteQueryEmbedderOptions = {},
): QueryEmbedder {
  if (endpointProblem(endpoint.baseUrl) !== null) {
    throw new Error("gecersiz sorgu servisi adresi");
  }
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? SEMANTIC_QUERY_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const cache = options.cache ?? sharedCache;
  const url = `${new URL(endpoint.baseUrl).origin}/v1/embeddings`;

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
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (endpoint.token) headers.Authorization = `Bearer ${endpoint.token}`;
        const response = await fetchImpl(url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: endpoint.servedModel,
            input: [text.trim().replace(/\s+/g, " ")],
            encoding_format: "float",
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          return fail(classifyHttpFailure(response.status));
        }
        const accepted = acceptVector(await response.json(), endpoint.servedModel, dimensions);
        if (!accepted) return fail("bad_payload");
        try {
          options.onSuccess?.();
        } catch {
          // Saglik kaydi aramayi bozmaz.
        }
        if (cache.size >= CACHE_LIMIT) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(key, accepted.vector);
        const latencyMs = now() - started;
        await report({ modelVersion, tokens: accepted.tokens, cacheHit: false, latencyMs });
        return { vector: accepted.vector, cacheHit: false, latencyMs };
      } catch (error) {
        const name = (error as { name?: string } | null)?.name;
        if (name === "TimeoutError" || name === "AbortError") return fail("timeout");
        return fail(name === "SyntaxError" ? "bad_payload" : "network");
      }
    },
  };
}

/** `GET /health` (TEI): 200 ise saglikli. Ag/zaman asimi/diger -> false. Adres ve govde dondurulmez. */
export async function probeServiceHealth(
  baseUrl: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<boolean> {
  if (endpointProblem(baseUrl) !== null) return false;
  try {
    const response = await (options.fetch ?? fetch)(`${new URL(baseUrl).origin}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(options.timeoutMs ?? 2_000),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  }
}
