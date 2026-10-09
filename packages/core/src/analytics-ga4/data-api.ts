/**
 * GA4 Data API istemcisi (karar 0087). YALNIZCA sunucu; SDK yok, iki uç nokta:
 * OAuth JWT-bearer belirteci ve `properties/{id}:batchRunReports`.
 *
 * - Erişim belirteci yalnızca bellekte, süresinden 60 sn önce yenilenir.
 * - Her HTTP isteği zaman aşımlıdır (varsayılan 8 sn).
 * - Hatalar sabit kodlara indirgenir; mesajda yanıt gövdesi, belirteç,
 *   anahtar ya da mülk kimliği yoktur (yalnızca HTTP durumu ve Google'ın
 *   büyük harfli durum kodu, ör. PERMISSION_DENIED).
 */
import { createSign } from "node:crypto";
import { GA4_SCOPE, GA4_TOKEN_URL, type Ga4ApiConfig } from "./config.ts";

export type Ga4ErrorCode =
  | "auth"
  | "permission"
  | "quota"
  | "timeout"
  | "network"
  | "upstream"
  | "bad_request"
  | "invalid_response";

export class Ga4ApiError extends Error {
  constructor(
    readonly code: Ga4ErrorCode,
    readonly httpStatus: number | null = null,
    readonly providerStatus: string | null = null,
  ) {
    super(
      `GA4 Data API: ${code}${httpStatus ? ` (HTTP ${httpStatus}${providerStatus ? ` ${providerStatus}` : ""})` : ""}`,
    );
    this.name = "Ga4ApiError";
  }
}

export interface Ga4Transport {
  fetch: typeof fetch;
  now: () => number;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const TOKEN_LIFETIME_S = 3_600;
const TOKEN_REFRESH_MARGIN_MS = 60_000;

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/** Testler için: bellekteki erişim belirteçlerini unutur. */
export function clearGa4TokenCache(): void {
  tokenCache.clear();
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/** RFC 7523 JWT-bearer iddiası (RS256). `aud` her zaman Google'ın belirteç adresidir. */
export function signGa4Assertion(config: Ga4ApiConfig, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: config.clientEmail,
      scope: GA4_SCOPE,
      aud: GA4_TOKEN_URL,
      iat,
      exp: iat + TOKEN_LIFETIME_S,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${signer.sign(config.privateKey).toString("base64url")}`;
}

function providerStatusOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error === "string") return /^[a-z_]{3,40}$/.test(error) ? error.toUpperCase() : null;
  if (typeof error !== "object" || error === null) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "string" && /^[A-Z_]{3,40}$/.test(status) ? status : null;
}

function mapStatus(status: number, providerStatus: string | null, phase: "token" | "api") {
  if (status === 429 || providerStatus === "RESOURCE_EXHAUSTED") return "quota" as const;
  if (status === 401 || (phase === "token" && status === 400)) return "auth" as const;
  if (status === 403) return "permission" as const;
  if (status >= 500) return "upstream" as const;
  return "bad_request" as const;
}

async function request(
  transport: Ga4Transport,
  url: string,
  init: RequestInit,
  phase: "token" | "api",
): Promise<unknown> {
  let response: Response;
  try {
    response = await transport.fetch(url, {
      ...init,
      signal: AbortSignal.timeout(transport.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    const name = (error as { name?: string })?.name;
    throw new Ga4ApiError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network");
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    if (response.ok) throw new Ga4ApiError("invalid_response", response.status);
  }
  if (!response.ok) {
    const providerStatus = providerStatusOf(body);
    throw new Ga4ApiError(
      mapStatus(response.status, providerStatus, phase),
      response.status,
      providerStatus,
    );
  }
  return body;
}

async function accessToken(config: Ga4ApiConfig, transport: Ga4Transport): Promise<string> {
  const cacheKey = `${config.tokenUrl}|${config.clientEmail}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > transport.now()) return cached.token;
  const body = await request(
    transport,
    config.tokenUrl,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: signGa4Assertion(config, transport.now()),
      }).toString(),
    },
    "token",
  );
  const token = (body as { access_token?: unknown })?.access_token;
  const expiresIn = (body as { expires_in?: unknown })?.expires_in;
  if (typeof token !== "string" || token.length < 10) throw new Ga4ApiError("invalid_response");
  const seconds = typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : TOKEN_LIFETIME_S;
  tokenCache.set(cacheKey, { token, expiresAt: transport.now() + seconds * 1000 });
  return token;
}

/* ---- Yanıt şekli (yalnızca kullandığımız alanlar) ---- */

export interface Ga4Row {
  dimensionValues?: { value?: string }[];
  metricValues?: { value?: string }[];
}

export interface Ga4Report {
  rows?: Ga4Row[];
  rowCount?: number;
  propertyQuota?: Ga4PropertyQuota;
}

interface QuotaStatus {
  consumed?: number;
  remaining?: number;
}

export interface Ga4PropertyQuota {
  tokensPerDay?: QuotaStatus;
  tokensPerHour?: QuotaStatus;
  tokensPerProjectPerHour?: QuotaStatus;
}

export interface Ga4QuotaSnapshot {
  /** En düşük kalan; bilinmiyorsa null. */
  dayRemaining: number | null;
  hourRemaining: number | null;
  projectHourRemaining: number | null;
}

function minRemaining(values: (number | undefined)[]): number | null {
  const known = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return known.length > 0 ? Math.min(...known) : null;
}

export function quotaSnapshot(reports: readonly Ga4Report[]): Ga4QuotaSnapshot {
  return {
    dayRemaining: minRemaining(reports.map((r) => r.propertyQuota?.tokensPerDay?.remaining)),
    hourRemaining: minRemaining(reports.map((r) => r.propertyQuota?.tokensPerHour?.remaining)),
    projectHourRemaining: minRemaining(
      reports.map((r) => r.propertyQuota?.tokensPerProjectPerHour?.remaining),
    ),
  };
}

/** Bir toplu istek en çok 5 rapor taşır (Data API sınırı). */
export const GA4_BATCH_MAX = 5;

/**
 * `batchRunReports`. Her rapor isteğine `returnPropertyQuota` eklenir.
 * Dönen rapor sayısı istek sayısına eşit değilse geçersiz yanıt sayılır.
 */
export async function batchRunReports(
  config: Ga4ApiConfig,
  transport: Ga4Transport,
  requests: readonly Record<string, unknown>[],
): Promise<Ga4Report[]> {
  if (requests.length === 0 || requests.length > GA4_BATCH_MAX) {
    throw new Ga4ApiError("bad_request");
  }
  const token = await accessToken(config, transport);
  const body = await request(
    transport,
    `${config.dataApiBase}/properties/${config.propertyId}:batchRunReports`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        requests: requests.map((item) => ({ ...item, returnPropertyQuota: true })),
      }),
    },
    "api",
  );
  const reports = (body as { reports?: unknown })?.reports;
  if (!Array.isArray(reports) || reports.length !== requests.length) {
    throw new Ga4ApiError("invalid_response");
  }
  return reports as Ga4Report[];
}
