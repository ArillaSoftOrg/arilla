"use server";

import {
  type EmbeddingClient,
  EmbeddingProviderError,
  EmbeddingUnavailableError,
  getEmbeddingClient,
  ImageRejectedError,
  isRedisUnavailableError,
  isValidRequestKey,
  type PreparedImage,
  preprocessImage,
  runChargedVisualSearch,
} from "@arilla/core";
import {
  ANONYMOUS_SESSION_COOKIE,
  anonymousSessionCookieOptions,
  newAnonymousSessionId,
  validAnonymousSessionId,
} from "@arilla/core/anonymous-session";
import type { QuotaWindow } from "@arilla/core/quota-policy";
import { getDatabase } from "@arilla/db";
import { cookies } from "next/headers";
import { requireProductAccess } from "../../lib/dal.ts";

// Vercel Functions istek govdesini 4.5 MB ile sinirlar; next.config.ts'teki
// serverActions.bodySizeLimit "4.5mb" (4 MB dosya + multipart payi) ile hizali. photo-search-client.tsx ayni
// siniri istemci tarafinda da uygular.
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
export type UploadImageResult =
  | { status: "ok"; imageUploadId: number; chargedFromBonus: boolean }
  /** Hak yok; `window` dolan pencere (saat/gun/hafta/ay, `quota/policy.ts`). */
  | { status: "no_rights"; window: QuotaWindow }
  | {
      status:
        | "too_large"
        | "invalid_type"
        | "unprocessable"
        /** Fotografla arama hesap ister (0047); istemci giris modalini acar. */
        | "login_required"
        | "rate_limited"
        | "busy"
        | "retry"
        | "unavailable"
        | "error";
    };

/**
 * `/ara`'nın aksine bu sayfa `proxy.ts`'in `session_id` çerezine bağımlı
 * değil - fotoğraf yükleme ana sayfada da çalışır (`docs/pages.md` "/") ve
 * proxy'nin matcher'ı kökü kapsamıyor. Server Action çerez YAZABİLİR
 * (Server Component render'ının aksine), o yüzden eksikse burada üretilir.
 */
async function ensureSessionId(): Promise<string> {
  const store = await cookies();
  // Kanonik UUID olmayan değer (istemci elle yazmış olabilir) yok sayılır.
  const existing = validAnonymousSessionId(store.get(ANONYMOUS_SESSION_COOKIE)?.value);
  if (existing) return existing;

  const sessionId = newAnonymousSessionId();
  store.set(ANONYMOUS_SESSION_COOKIE, sessionId, anonymousSessionCookieOptions());
  return sessionId;
}

export async function uploadImageForSearch(formData: FormData): Promise<UploadImageResult> {
  // Ürün kapısı her şeyden önce: kapalıyken dosya okunmaz, model çağrılmaz.
  const user = await requireProductAccess();
  // 0047: fotoğrafla arama hesap ister; hak kullanıcıya bağlıdır.
  if (!user) return { status: "login_required" };
  const requestKey = formData.get("requestKey");
  if (!isValidRequestKey(requestKey)) return { status: "error" };
  const file = formData.get("photo");
  if (!(file instanceof File) || file.size === 0) {
    return { status: "invalid_type" };
  }
  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    return { status: "invalid_type" };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { status: "too_large" };
  }

  // Saglayici yapilandirilmamissa (anahtar yok / production'da sahte bayrak)
  // hak harcanmadan ve hicbir satir yazilmadan durulur. Sahte sonuc
  // uretilmez; kullaniciya "su an kullanilamiyor" gosterilir.
  let client: EmbeddingClient;
  try {
    client = getEmbeddingClient();
  } catch (error) {
    if (error instanceof EmbeddingUnavailableError) {
      // Yalnizca sebep kodu - kisisel veri veya gizli deger yok.
      console.error(`visual search unavailable: ${error.reason}`);
      return { status: "unavailable" };
    }
    throw error;
  }

  // Gorsel hak harcanmadan ONCE dogrulanir ve on islenir (0034):
  // decode edilemeyen ya da sozlesme disi gorsel hakki yakmaz, saglayiciya
  // gitmez. Bellekte kalir; diske yazilmaz.
  let prepared: PreparedImage;
  try {
    prepared = await preprocessImage(Buffer.from(await file.arrayBuffer()));
  } catch (error) {
    if (error instanceof ImageRejectedError) {
      console.error(`visual search image rejected: ${error.reason}`);
      return { status: "unprocessable" };
    }
    throw error;
  }

  const sessionId = await ensureSessionId();

  // Oran siniri, hak ayirma, embedding, kesinlestirme/iade core'da (0047).
  // Oran siniri dogrulanamiyorsa (Redis erisilemez) kapali kalinir: ucretli
  // embedding cagrisi sinirsiz yapilmaz.
  try {
    const result = await runChargedVisualSearch(
      getDatabase(),
      { userId: user.id, sessionId, requestKey, prepared },
      client,
    );
    return result;
  } catch (error) {
    if (isRedisUnavailableError(error)) {
      console.error("visual search unavailable: limit store unavailable");
      return { status: "unavailable" };
    }
    if (error instanceof EmbeddingUnavailableError) {
      return { status: "unavailable" };
    }
    if (error instanceof EmbeddingProviderError) {
      // Saglayici hatasi (ag, 4xx/5xx, bozuk yanit): sahte sonuca dusulmez,
      // ayrilan hak iade edildi.
      console.error("visual search provider failure");
      return { status: "unavailable" };
    }
    throw error;
  }
}
