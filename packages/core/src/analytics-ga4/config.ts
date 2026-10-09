/**
 * GA4 Data API yapılandırması (karar 0087). YALNIZCA sunucu.
 *
 * En az yetki: servis hesabı GA4 mülkünde "Görüntüleyici", OAuth kapsamı
 * `analytics.readonly`. Anahtar yalnızca bellekte KeyObject olarak tutulur;
 * hiçbir hata ya da sonuç değeri anahtar, e-posta veya kimlik DEĞERİ taşımaz,
 * yalnızca ortam değişkeninin ADINI söyler.
 */
import { createPrivateKey, type KeyObject } from "node:crypto";

type Env = Readonly<Record<string, string | undefined>>;

export const GA4_ENV = {
  propertyId: "GA4_PROPERTY_ID",
  clientEmail: "GA4_CLIENT_EMAIL",
  privateKey: "GA4_PRIVATE_KEY",
  /** Yalnızca yerel testler: sahte Data API/OAuth sunucusu. Yalnızca localhost kabul edilir. */
  testApiBaseUrl: "GA4_TEST_API_BASE_URL",
} as const;

export const GA4_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
export const GA4_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GA4_DATA_API_BASE = "https://analyticsdata.googleapis.com/v1beta";

export interface Ga4ApiConfig {
  propertyId: string;
  clientEmail: string;
  privateKey: KeyObject;
  tokenUrl: string;
  dataApiBase: string;
  /** Sahte yerel uç noktaya mı bağlanıyor (yalnızca test). */
  testEndpoint: boolean;
}

export type Ga4ApiConfigResult =
  | { status: "ready"; config: Ga4ApiConfig }
  | { status: "not_configured"; missing: string[] }
  | { status: "invalid"; problems: string[] };

const PROPERTY_ID = /^[0-9]{6,15}$/;
const SERVICE_ACCOUNT = /^[a-z0-9][a-z0-9-]{4,62}@[a-z0-9-]{4,62}\.iam\.gserviceaccount\.com$/;

function value(env: Env, key: string): string | undefined {
  const raw = env[key]?.trim();
  return raw ? raw : undefined;
}

/** Vercel ortam değişkeninde satır sonları çoğunlukla `\n` kaçışıyla gelir. */
function parsePrivateKey(raw: string): KeyObject | null {
  try {
    const key = createPrivateKey(raw.replace(/\\n/g, "\n"));
    return key.asymmetricKeyType === "rsa" ? key : null;
  } catch {
    return null;
  }
}

/** Sahte uç nokta yalnızca yerel adres olabilir: gerçek bir üçüncü tarafa yönlendirilemez. */
function localTestBase(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return local && url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

export function ga4ApiConfigFromEnv(env: Env = process.env): Ga4ApiConfigResult {
  const propertyId = value(env, GA4_ENV.propertyId);
  const clientEmail = value(env, GA4_ENV.clientEmail);
  const privateKeyRaw = value(env, GA4_ENV.privateKey);
  const missing = [
    propertyId ? null : (GA4_ENV.propertyId as string),
    clientEmail ? null : GA4_ENV.clientEmail,
    privateKeyRaw ? null : GA4_ENV.privateKey,
  ].filter((name): name is string => name !== null);
  if (missing.length === 3) return { status: "not_configured", missing };

  const problems: string[] = [...missing];
  if (propertyId && !PROPERTY_ID.test(propertyId)) problems.push(GA4_ENV.propertyId);
  if (clientEmail && !SERVICE_ACCOUNT.test(clientEmail)) problems.push(GA4_ENV.clientEmail);
  const privateKey = privateKeyRaw ? parsePrivateKey(privateKeyRaw) : null;
  if (privateKeyRaw && !privateKey) problems.push(GA4_ENV.privateKey);
  const rawTest = value(env, GA4_ENV.testApiBaseUrl);
  const testBase = localTestBase(rawTest);
  if (rawTest && !testBase) problems.push(GA4_ENV.testApiBaseUrl);
  if (problems.length > 0 || !propertyId || !clientEmail || !privateKey) {
    return { status: "invalid", problems };
  }
  return {
    status: "ready",
    config: {
      propertyId,
      clientEmail,
      privateKey,
      tokenUrl: testBase ? `${testBase}/token` : GA4_TOKEN_URL,
      dataApiBase: testBase ? `${testBase}/v1beta` : GA4_DATA_API_BASE,
      testEndpoint: testBase !== null,
    },
  };
}
