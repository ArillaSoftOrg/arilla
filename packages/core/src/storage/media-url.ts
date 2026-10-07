/**
 * Public medya URL'i uretimi. Yalnizca `R2_PUBLIC_BASE_URL` (secret degil)
 * okunur; SDK ve kimlik bilgisi bu dosyaya girmez, bu yuzden sunucu
 * bilesenlerinden guvenle cagrilir. Baz URL ozel alan adi olmalidir
 * (orn. https://media.alan-adi.com); `*.r2.dev` uretimde reddedilir.
 */
import { isValidMediaKey } from "./media-keys.ts";

export function normalizePublicBaseUrl(
  raw: string | undefined,
  options: { production: boolean },
): string | undefined {
  const trimmed = raw?.trim().replace(/^["']|["']$/g, "");
  if (!trimmed) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("R2_PUBLIC_BASE_URL gecerli bir URL degil.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("R2_PUBLIC_BASE_URL http veya https olmali.");
  }
  if (options.production) {
    if (url.protocol !== "https:") throw new Error("R2_PUBLIC_BASE_URL uretimde https olmali.");
    if (url.hostname === "r2.dev" || url.hostname.endsWith(".r2.dev")) {
      throw new Error("R2_PUBLIC_BASE_URL uretimde r2.dev olamaz; ozel alan adi kullanin.");
    }
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function isProduction(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === "production" || env.VERCEL_ENV === "production";
}

export function readPublicBaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return normalizePublicBaseUrl(env.R2_PUBLIC_BASE_URL, { production: isProduction(env) });
}

export function mediaUrl(baseUrl: string, key: string): string {
  if (!isValidMediaKey(key)) throw new Error(`gecersiz medya anahtari: ${key}`);
  return `${baseUrl}/${key}`;
}

/**
 * Baz URL tanimli degilse `fallback` doner (yerel gelistirme, R2 henuz
 * kurulmamis ortam). Tanimliysa anahtarin public URL'i.
 */
export function mediaUrlOr(
  key: string,
  fallback: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const baseUrl = readPublicBaseUrl(env);
  return baseUrl === undefined ? fallback : mediaUrl(baseUrl, key);
}
