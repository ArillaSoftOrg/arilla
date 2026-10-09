/**
 * GA4 Data API istemcisi (karar 0087, 0088). YALNIZCA sunucu; SDK yok.
 *
 * Erişim belirteci iki kipten biriyle alınır (bkz. `config.ts`):
 * - `key`: OAuth JWT-bearer (RFC 7523), servis hesabı anahtarıyla imzalı.
 * - `federated`: çalışma ortamının OIDC belirteci (`Ga4Transport.subjectToken`,
 *   uygulama katmanı verir; çekirdek sağlayıcıyı tanımaz) → Google STS
 *   belirteç değişimi (RFC 8693) → `generateAccessToken` ile servis hesabına
 *   bürünme, kapsam yalnızca `analytics.readonly`.
 * Sonra `properties/{id}:batchRunReports`.
 *
 * - Erişim belirteci yalnızca bellekte, süresinden 60 sn önce yenilenir.
 *   OIDC ve federe ara belirteç hiç saklanmaz.
 * - Her HTTP isteği zaman aşımlıdır (varsayılan 8 sn).
 * - Hatalar sabit kodlara indirgenir; mesajda yanıt gövdesi, belirteç,
 *   anahtar ya da mülk kimliği yoktur (yalnızca HTTP durumu ve Google'ın
 *   büyük harfli durum kodu, ör. PERMISSION_DENIED).
 */
import { createSign } from "node:crypto";
import { GA4_SCOPE, GA4_TOKEN_URL, type Ga4ApiConfig } from "./config.ts";

export type Ga4ErrorCode =
  | "auth"
  /** Federe kip: çalışma ortamı OIDC belirteci sağlamadı. */
  | "identity_unavailable"
  /** Federe kip: STS kimliği reddetti (audience, öznitelik koşulu, süresi geçmiş belirteç). */
  | "federation_rejected"
  /** Federe kip: federe kimliğin servis hesabına bürünme izni yok. */
  | "impersonation_denied"
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
  /**
   * Federe kip: istek anında çalışma ortamının OIDC belirtecini verir (ör.
   * Vercel). Yoksa ya da boş dönerse `identity_unavailable`. Belirteç
   * saklanmaz; her yenilemede yeniden istenir.
   */
  subjectToken?: () => Promise<string | null | undefined>;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const TOKEN_LIFETIME_S = 3_600;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const STS_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const STS_SUBJECT_TYPE = "urn:ietf:params:oauth:token-type:jwt";
const STS_REQUESTED_TYPE = "urn:ietf:params:oauth:token-type:access_token";
/** STS federe belirteci yalnızca IAM Credentials'a erişmek için: geniş kapsam zorunlu. */
const STS_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

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
  if (config.auth.mode !== "key") throw new Ga4ApiError("auth");
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
  return `${header}.${claims}.${signer.sign(config.auth.privateKey).toString("base64url")}`;
}

function providerStatusOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error === "string") return /^[a-z_]{3,40}$/.test(error) ? error.toUpperCase() : null;
  if (typeof error !== "object" || error === null) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "string" && /^[A-Z_]{3,40}$/.test(status) ? status : null;
}

type Phase = "token" | "sts" | "impersonate" | "api";

function mapStatus(status: number, providerStatus: string | null, phase: Phase): Ga4ErrorCode {
  if (status === 429 || providerStatus === "RESOURCE_EXHAUSTED") return "quota";
  if (phase === "sts" && status >= 400 && status < 500) return "federation_rejected";
  if (phase === "impersonate" && (status === 401 || status === 403)) {
    return "impersonation_denied";
  }
  if (status === 401 || (phase === "token" && status === 400)) return "auth";
  if (status === 403) return "permission";
  if (status >= 500) return "upstream";
  return "bad_request";
}

async function request(
  transport: Ga4Transport,
  url: string,
  init: RequestInit,
  phase: Phase,
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

function cacheEntry(
  transport: Ga4Transport,
  token: unknown,
  lifetimeMs: number | null,
): { token: string; expiresAt: number } {
  if (typeof token !== "string" || token.length < 10) throw new Ga4ApiError("invalid_response");
  const ms = lifetimeMs !== null && lifetimeMs > 0 ? lifetimeMs : TOKEN_LIFETIME_S * 1000;
  return { token, expiresAt: transport.now() + ms };
}

async function keyAccessToken(config: Ga4ApiConfig, transport: Ga4Transport, tokenUrl: string) {
  const body = await request(
    transport,
    tokenUrl,
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
  const expiresIn = (body as { expires_in?: unknown })?.expires_in;
  return cacheEntry(
    transport,
    (body as { access_token?: unknown })?.access_token,
    typeof expiresIn === "number" ? expiresIn * 1000 : null,
  );
}

/** OIDC → STS federe belirteç → servis hesabına bürünme (yalnızca `analytics.readonly`). */
async function federatedAccessToken(
  config: Ga4ApiConfig,
  transport: Ga4Transport,
  auth: Extract<Ga4ApiConfig["auth"], { mode: "federated" }>,
) {
  let subject: string | null | undefined;
  try {
    subject = await transport.subjectToken?.();
  } catch {
    subject = null;
  }
  if (typeof subject !== "string" || subject.trim().length < 10) {
    throw new Ga4ApiError("identity_unavailable");
  }
  const sts = await request(
    transport,
    auth.stsUrl,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: STS_GRANT,
        audience: auth.audience,
        scope: STS_SCOPE,
        requested_token_type: STS_REQUESTED_TYPE,
        subject_token_type: STS_SUBJECT_TYPE,
        subject_token: subject.trim(),
      }).toString(),
    },
    "sts",
  );
  const federated = (sts as { access_token?: unknown })?.access_token;
  if (typeof federated !== "string" || federated.length < 10) {
    throw new Ga4ApiError("invalid_response");
  }
  const impersonated = await request(
    transport,
    `${auth.iamCredentialsBase}/projects/-/serviceAccounts/${encodeURIComponent(config.clientEmail)}:generateAccessToken`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${federated}`, "content-type": "application/json" },
      body: JSON.stringify({ scope: [GA4_SCOPE], lifetime: `${TOKEN_LIFETIME_S}s` }),
    },
    "impersonate",
  );
  const expireTime = (impersonated as { expireTime?: unknown })?.expireTime;
  const expiresAt = typeof expireTime === "string" ? Date.parse(expireTime) : Number.NaN;
  return cacheEntry(
    transport,
    (impersonated as { accessToken?: unknown })?.accessToken,
    Number.isFinite(expiresAt) ? expiresAt - transport.now() : null,
  );
}

async function accessToken(config: Ga4ApiConfig, transport: Ga4Transport): Promise<string> {
  const { auth } = config;
  const cacheKey =
    auth.mode === "key"
      ? `key|${auth.tokenUrl}|${config.clientEmail}`
      : `federated|${auth.stsUrl}|${auth.audience}|${config.clientEmail}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > transport.now()) return cached.token;
  const entry =
    auth.mode === "key"
      ? await keyAccessToken(config, transport, auth.tokenUrl)
      : await federatedAccessToken(config, transport, auth);
  tokenCache.set(cacheKey, entry);
  return entry.token;
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
