"use server";

import { randomUUID } from "node:crypto";
import {
  type EmbeddingClient,
  EmbeddingProviderError,
  EmbeddingUnavailableError,
  embedUploadedImage,
  getEmbeddingClient,
  ImageRejectedError,
  isRedisUnavailableError,
  type PreparedImage,
  preprocessImage,
  recordImageSearchAndCheckLimit,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { cookies } from "next/headers";
import { verifySession } from "../../lib/dal.ts";

// Vercel Functions istek govdesini 4.5 MB ile sinirlar; next.config.ts'teki
// serverActions.bodySizeLimit "4.5mb" (4 MB dosya + multipart payi) ile hizali. photo-search-client.tsx ayni
// siniri istemci tarafinda da uygular.
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export type UploadImageResult =
  | { status: "ok"; imageUploadId: number }
  | {
      status:
        | "too_large"
        | "invalid_type"
        | "unprocessable"
        | "daily_limit"
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
  const existing = store.get("session_id")?.value;
  if (existing) return existing;

  const sessionId = randomUUID();
  store.set("session_id", sessionId, {
    path: "/",
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
    sameSite: "lax",
  });
  return sessionId;
}

export async function uploadImageForSearch(formData: FormData): Promise<UploadImageResult> {
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
  // gunluk hak harcanmadan ve hicbir satir yazilmadan durulur. Sahte sonuc
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

  // Gorsel gunluk hak harcanmadan ONCE dogrulanir ve on islenir (0030):
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
  const user = await verifySession();

  // Gunluk limit, sagladigi/harcadigi maliyet nedeniyle embed cagrisindan
  // ONCE kontrol edilir (docs/decisions/0015 - gercek para maliyeti).
  // Limit kontrol edilemiyorsa (Redis erisilemez) kapali kalinir: ucretli
  // embedding cagrisi limitsiz yapilmaz.
  let limit: Awaited<ReturnType<typeof recordImageSearchAndCheckLimit>>;
  try {
    limit = await recordImageSearchAndCheckLimit({
      userId: user?.id ?? null,
      sessionId,
    });
  } catch (error) {
    if (!isRedisUnavailableError(error)) throw error;
    console.error("visual search unavailable: limit store unavailable");
    return { status: "unavailable" };
  }
  if (!limit.allowed) {
    return { status: "daily_limit" };
  }

  try {
    const result = await embedUploadedImage(
      getDatabase(),
      {
        bytes: prepared.bytes,
        prepared,
        mimeType: prepared.mimeType,
        sessionId,
        userId: user?.id ?? null,
      },
      client,
    );
    return { status: "ok", imageUploadId: result.imageUploadId };
  } catch (error) {
    if (error instanceof EmbeddingUnavailableError) {
      return { status: "unavailable" };
    }
    if (error instanceof EmbeddingProviderError) {
      // Saglayici hatasi (ag, 4xx/5xx, bozuk yanit): sahte sonuca dusulmez.
      console.error("visual search provider failure");
      return { status: "unavailable" };
    }
    throw error;
  }
}
