import type { Ga4Transport } from "@arilla/core";
import { getVercelOidcToken } from "@vercel/oidc";

/**
 * Karar 0088: GA4 Data API için çalışma ortamı kimliği. YALNIZCA sunucu
 * (yalnızca yönetim server component'leri içe aktarır).
 *
 * Çekirdek (`packages/core`) sağlayıcıyı tanımaz; federe kipte OIDC belirtecini
 * bu taşıyıcının `subjectToken` sağlayıcısından ister. Belirteç Vercel'in
 * resmi `getVercelOidcToken()` API'siyle alınır: önce Vercel'in istek
 * bağlamındaki (`@vercel/request-context`) `x-vercel-oidc-token`, yoksa
 * `VERCEL_OIDC_TOKEN`. İstek bağlamı Next'in işlediği başlıklardan bağımsızdır;
 * `proxy.ts`'in `/yonetim/*` için başlıkları yeniden yazması belirteci düşürmez.
 *
 * - Yalnızca Vercel üzerinde (`VERCEL=1`) çağrılır. Başka ortamda kütüphanenin
 *   yenileme yolu yerel CLI kimlik bilgilerini okuyup belirteci `process.env`
 *   ve disk önbelleğine yazabilir; bu yüzden orada hiç çalıştırılmaz ve federe
 *   kip `identity_unavailable` döner. Production dışı belirteçleri Google'ın
 *   `sub` koşulu zaten reddeder.
 * - Belirteç saklanmaz, loglanmaz, istemciye hiçbir yoldan dönmez; hata
 *   mesajı yutulur (kütüphane mesajı yol ya da proje bilgisi taşıyabilir).
 *   Her çağrıda yeniden okunur (Vercel: "dönen belirteci önbelleğe almayın").
 */
type Env = Readonly<Record<string, string | undefined>>;
type TokenReader = () => Promise<string>;

export async function vercelOidcToken(
  env: Env = process.env,
  read: TokenReader = getVercelOidcToken,
): Promise<string | null> {
  if (env.VERCEL !== "1") return null;
  try {
    return (await read()).trim() || null;
  } catch {
    return null;
  }
}

/** `/yonetim/trafik` ve genel bakış için GA4 taşıyıcısı. */
export function ga4ServerTransport(): Ga4Transport {
  return {
    fetch: globalThis.fetch.bind(globalThis),
    now: () => Date.now(),
    subjectToken: () => vercelOidcToken(),
  };
}
