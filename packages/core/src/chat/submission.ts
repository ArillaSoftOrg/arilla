/**
 * Sohbet gonderimi: metin, gorsel ya da metin+gorsel tek mesajdir (karar 0091).
 *
 * Bu modul, ana sayfa ve sohbet ici composer'in ortak sunucu tarafi giris
 * denetimidir: metin temizligi ve gorsel dogrulama + on isleme (`preprocessImage`:
 * decode, <=512 px, EXIF'siz). Sohbeti/mesaji yazan `createConversation` ve
 * `submitUserMessage` (`service.ts`) gorseli ayni `ChatAttachmentInput` ile alir.
 * `apps/web` eylemleri yalnizca oturum/bayrak denetimi ve yanit sekli ekler
 * (CLAUDE.md kural 6). Hicbir yerde mesaj metni ya da hata ayrintisi dondurulmez,
 * yalnizca sabit durum kodlari.
 */
import { ImageRejectedError, preprocessImage } from "../embedding/preprocess-image.ts";
import { USER_MESSAGE_MAX } from "./config.ts";
import type { ChatAttachmentInput } from "./service.ts";

/** `next.config.ts` (serverActions.bodySizeLimit) ve `ara/gorsel/actions.ts` ile ayni sinir. */
export const CHAT_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
export const CHAT_UPLOAD_MIME_TYPES: readonly string[] = ["image/jpeg", "image/png", "image/webp"];

export type ChatImageRejection = "invalid_input" | "invalid_type" | "too_large" | "unprocessable";

/** `File` bu sekle uyar; testte sade bir nesne verilebilir. */
export interface ChatUpload {
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type PreparedChatImage =
  | { ok: true; attachment: ChatAttachmentInput }
  | { ok: false; status: ChatImageRejection | "error" };

/** Kutudaki metin: kirpilir ve sinirlanir (modele gitmeden once `cleanText` yine uygulanir). */
export function cleanSubmissionText(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().slice(0, USER_MESSAGE_MAX) : "";
}

/**
 * Sunucu tarafi dosya denetimi + on isleme. Ham dosya saklanmaz (kural 10): yalnizca
 * `preprocessImage` ciktisi doner. Gecersiz/bozuk dosya model cagrisi ya da kota
 * harcamadan reddedilir.
 */
export async function prepareChatImage(file: unknown): Promise<PreparedChatImage> {
  const upload = file as Partial<ChatUpload> | null;
  if (
    !upload ||
    typeof upload.arrayBuffer !== "function" ||
    typeof upload.size !== "number" ||
    typeof upload.type !== "string" ||
    upload.size <= 0
  ) {
    return { ok: false, status: "invalid_input" };
  }
  if (!CHAT_UPLOAD_MIME_TYPES.includes(upload.type)) return { ok: false, status: "invalid_type" };
  if (upload.size > CHAT_UPLOAD_MAX_BYTES) return { ok: false, status: "too_large" };
  try {
    const prepared = await preprocessImage(Buffer.from(await upload.arrayBuffer()));
    return {
      ok: true,
      attachment: {
        bytes: prepared.bytes,
        mimeType: prepared.mimeType,
        width: prepared.width,
        height: prepared.height,
      },
    };
  } catch (error) {
    if (error instanceof ImageRejectedError) return { ok: false, status: "unprocessable" };
    return { ok: false, status: "error" };
  }
}
