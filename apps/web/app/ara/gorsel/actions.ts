"use server";

import { randomUUID } from "node:crypto";
import {
  EmbeddingProviderError,
  embedUploadedImage,
  recordImageSearchAndCheckLimit,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { cookies } from "next/headers";
import { verifySession } from "../../lib/dal.ts";

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export type UploadImageResult =
  | { status: "ok"; imageUploadId: number }
  | { status: "too_large" | "invalid_type" | "daily_limit" | "error" };

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

  const sessionId = await ensureSessionId();
  const user = await verifySession();

  // Gunluk limit, sagladigi/harcadigi maliyet nedeniyle embed cagrisindan
  // ONCE kontrol edilir (docs/decisions/0015 - gercek para maliyeti).
  const limit = await recordImageSearchAndCheckLimit({
    userId: user?.id ?? null,
    sessionId,
  });
  if (!limit.allowed) {
    return { status: "daily_limit" };
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  try {
    const result = await embedUploadedImage(getDatabase(), {
      bytes,
      mimeType: file.type,
      sessionId,
      userId: user?.id ?? null,
    });
    return { status: "ok", imageUploadId: result.imageUploadId };
  } catch (error) {
    if (error instanceof EmbeddingProviderError) {
      return { status: "error" };
    }
    throw error;
  }
}
