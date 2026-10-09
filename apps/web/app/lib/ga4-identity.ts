import type { Ga4Transport } from "@arilla/core";
import { headers } from "next/headers";

/**
 * Karar 0088: GA4 Data API için çalışma ortamı kimliği. YALNIZCA sunucu.
 *
 * Çekirdek (`packages/core`) sağlayıcıyı tanımaz; federe kipte OIDC belirtecini
 * bu taşıyıcının `subjectToken` sağlayıcısından ister. Vercel belirteci her
 * fonksiyon çağrısına `x-vercel-oidc-token` başlığıyla verir; yerel
 * geliştirmede ve derlemede `VERCEL_OIDC_TOKEN` ortam değişkeni olabilir.
 *
 * - Başlık yalnızca Vercel üzerinde (`VERCEL=1`) okunur: başka bir ortamda
 *   istemcinin gönderdiği başlık kimlik olarak kullanılmaz.
 * - Belirteç saklanmaz, loglanmaz, istemciye hiçbir yoldan dönmez; yalnızca
 *   Google STS'ye sunucudan gönderilir. Google imzayı, issuer'ı, audience'ı
 *   ve `sub` koşulunu (yalnızca bu projenin production ortamı) doğrular.
 */
const OIDC_HEADER = "x-vercel-oidc-token";

export async function vercelOidcToken(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string | null> {
  if (env.VERCEL === "1") {
    try {
      const fromRequest = (await headers()).get(OIDC_HEADER)?.trim();
      if (fromRequest) return fromRequest;
    } catch {
      // İstek bağlamı dışında (ör. derleme): ortam değişkenine düşülür.
    }
  }
  return env.VERCEL_OIDC_TOKEN?.trim() || null;
}

/** `/yonetim/trafik` ve genel bakış için GA4 taşıyıcısı. */
export function ga4ServerTransport(): Ga4Transport {
  return {
    fetch: globalThis.fetch.bind(globalThis),
    now: () => Date.now(),
    subjectToken: () => vercelOidcToken(),
  };
}
