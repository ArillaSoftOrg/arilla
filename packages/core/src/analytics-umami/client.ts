/**
 * Umami okuma istemcisi (docs/decisions/0116). YALNIZCA sunucu.
 *
 * - Yalnızca `GET`, yalnızca yapılandırılmış kökene, Bearer anahtarıyla.
 * - Her istek zaman aşımı ve yanıt boyutu tavanı ile sınırlı; yönlendirme izlenmez.
 * - Hata türleri kapalı bir küme: ileti anahtar, adres, yanıt gövdesi İÇERMEZ.
 * - Çağıran (`reports.ts`) hatayı yutup eski veriye düşebilir; bu istemci
 *   hiçbir yerde site ya da yönlendirme yolundan çağrılmaz.
 */
import type { UmamiApiConfig } from "./config.ts";

export type UmamiErrorKind =
  | "timeout"
  | "network"
  | "unauthorized"
  | "not_found"
  | "rate_limited"
  | "http"
  | "too_large"
  | "invalid_response";

export class UmamiError extends Error {
  readonly kind: UmamiErrorKind;
  readonly status?: number;
  constructor(kind: UmamiErrorKind, status?: number) {
    super(`umami: ${kind}${status ? ` (${status})` : ""}`);
    this.name = "UmamiError";
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

export const UMAMI_TIMEOUT_MS = 4_000;
export const UMAMI_MAX_BYTES = 1_000_000;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface UmamiRequestOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxBytes?: number;
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new UmamiError("too_large");
  const body = response.body;
  if (!body) return await response.text();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new UmamiError("too_large");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** `GET {base}/api/websites/{id}{path}?{query}` → doğrulanmamış JSON. */
export async function umamiGet(
  config: UmamiApiConfig,
  path: string,
  query: Readonly<Record<string, string | number | undefined>>,
  options: UmamiRequestOptions = {},
): Promise<unknown> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const qs = params.toString();
  const url = `${config.baseUrl}/api/websites/${config.websiteId}${path}${qs ? `?${qs}` : ""}`;
  const fetchImpl: FetchLike = options.fetchImpl ?? ((u, init) => fetch(u, init));
  const timeoutMs = options.timeoutMs ?? UMAMI_TIMEOUT_MS;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: "application/json",
        "User-Agent": "arilla-admin/1",
      },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    throw new UmamiError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network");
  }

  if (response.status === 401 || response.status === 403) throw new UmamiError("unauthorized");
  if (response.status === 404) throw new UmamiError("not_found", 404);
  if (response.status === 429) throw new UmamiError("rate_limited", 429);
  if (!response.ok) throw new UmamiError("http", response.status);

  let text: string;
  try {
    text = await readCapped(response, options.maxBytes ?? UMAMI_MAX_BYTES);
  } catch (error) {
    if (error instanceof UmamiError) throw error;
    const name = error instanceof Error ? error.name : "";
    throw new UmamiError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new UmamiError("invalid_response");
  }
}
