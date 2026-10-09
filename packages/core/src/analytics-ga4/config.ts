/**
 * GA4 Data API yapılandırması (karar 0087, 0088). YALNIZCA sunucu.
 *
 * En az yetki: servis hesabı GA4 mülkünde "Görüntüleyici", OAuth kapsamı
 * `analytics.readonly`. İki kimlik kipi vardır, aynı anda yalnızca biri:
 *
 * - `federated` (önerilen, karar 0088): `GA4_WIF_AUDIENCE` tanımlı. Çalışma
 *   ortamının OIDC belirteci Google STS'de federe belirtece, o da servis
 *   hesabına bürünülerek erişim belirtecine çevrilir. Kalıcı anahtar yok.
 * - `key` (taşınabilirlik yedeği): `GA4_PRIVATE_KEY` tanımlı. Anahtar yalnızca
 *   bellekte KeyObject olarak tutulur.
 *
 * İkisi birden tanımlıysa yapılandırma geçersizdir. Hiçbir hata ya da sonuç
 * değeri anahtar, e-posta veya kimlik DEĞERİ taşımaz, yalnızca ortam
 * değişkeninin ADINI söyler.
 */
import { createPrivateKey, type KeyObject } from "node:crypto";

type Env = Readonly<Record<string, string | undefined>>;

export const GA4_ENV = {
  propertyId: "GA4_PROPERTY_ID",
  clientEmail: "GA4_CLIENT_EMAIL",
  privateKey: "GA4_PRIVATE_KEY",
  /** Federe kip: Workload Identity Federation sağlayıcısının tam kaynak adı. Sır değil. */
  wifAudience: "GA4_WIF_AUDIENCE",
  /** Yalnızca yerel testler: sahte Data API/OAuth sunucusu. Yalnızca localhost kabul edilir. */
  testApiBaseUrl: "GA4_TEST_API_BASE_URL",
} as const;

export const GA4_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
export const GA4_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GA4_DATA_API_BASE = "https://analyticsdata.googleapis.com/v1beta";
export const GA4_STS_URL = "https://sts.googleapis.com/v1/token";
export const GA4_IAM_CREDENTIALS_BASE = "https://iamcredentials.googleapis.com/v1";

export type Ga4AuthConfig =
  | { mode: "key"; privateKey: KeyObject; tokenUrl: string }
  | { mode: "federated"; audience: string; stsUrl: string; iamCredentialsBase: string };

export type Ga4AuthMode = Ga4AuthConfig["mode"];

export interface Ga4ApiConfig {
  propertyId: string;
  /** Anahtar kipinde JWT `iss`; federe kipte bürünülen servis hesabı. */
  clientEmail: string;
  auth: Ga4AuthConfig;
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
/** `//iam.googleapis.com/projects/<numara>/locations/global/workloadIdentityPools/<havuz>/providers/<sağlayıcı>` */
const WIF_AUDIENCE =
  /^\/\/iam\.googleapis\.com\/projects\/[0-9]{6,20}\/locations\/global\/workloadIdentityPools\/[a-z0-9-]{4,32}\/providers\/[a-z0-9-]{4,32}$/;

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
  const audience = value(env, GA4_ENV.wifAudience);
  const credential = privateKeyRaw !== undefined || audience !== undefined;
  // Kimlik bilgisi yoksa önerilen kipin değişkeni adlandırılır.
  const missing = [
    propertyId ? null : (GA4_ENV.propertyId as string),
    clientEmail ? null : GA4_ENV.clientEmail,
    credential ? null : GA4_ENV.wifAudience,
  ].filter((name): name is string => name !== null);
  if (missing.length === 3) return { status: "not_configured", missing };

  const problems: string[] = [...missing];
  if (propertyId && !PROPERTY_ID.test(propertyId)) problems.push(GA4_ENV.propertyId);
  if (clientEmail && !SERVICE_ACCOUNT.test(clientEmail)) problems.push(GA4_ENV.clientEmail);
  // Çakışma: hangi kimliğin kullanılacağı tahmin edilmez, ikisi de reddedilir.
  const conflict = privateKeyRaw !== undefined && audience !== undefined;
  if (conflict) problems.push(GA4_ENV.privateKey, GA4_ENV.wifAudience);
  const privateKey = privateKeyRaw && !conflict ? parsePrivateKey(privateKeyRaw) : null;
  if (privateKeyRaw && !conflict && !privateKey) problems.push(GA4_ENV.privateKey);
  if (audience && !conflict && !WIF_AUDIENCE.test(audience)) problems.push(GA4_ENV.wifAudience);
  const rawTest = value(env, GA4_ENV.testApiBaseUrl);
  const testBase = localTestBase(rawTest);
  if (rawTest && !testBase) problems.push(GA4_ENV.testApiBaseUrl);
  if (problems.length > 0 || !propertyId || !clientEmail || (!privateKey && !audience)) {
    return { status: "invalid", problems };
  }
  const auth: Ga4AuthConfig = privateKey
    ? { mode: "key", privateKey, tokenUrl: testBase ? `${testBase}/token` : GA4_TOKEN_URL }
    : {
        mode: "federated",
        audience: audience as string,
        stsUrl: testBase ? `${testBase}/sts/v1/token` : GA4_STS_URL,
        iamCredentialsBase: testBase ? `${testBase}/iamcredentials/v1` : GA4_IAM_CREDENTIALS_BASE,
      };
  return {
    status: "ready",
    config: {
      propertyId,
      clientEmail,
      auth,
      dataApiBase: testBase ? `${testBase}/v1beta` : GA4_DATA_API_BASE,
      testEndpoint: testBase !== null,
    },
  };
}
