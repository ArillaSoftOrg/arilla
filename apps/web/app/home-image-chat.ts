import type { ImageChatResult } from "./sohbet/actions.ts";

/**
 * Ana sayfa kutusunda fotograf + metin akisinin saf parcalari (karar 0078).
 * Tarayici/React'a bagimli degildir; birim testlidir.
 */

/** `sohbet/actions.ts` ve `ara/gorsel/actions.ts` ile ayni sinir. */
export const IMAGE_CHAT_MAX_BYTES = 4 * 1024 * 1024;
export const IMAGE_CHAT_MIME_TYPES: readonly string[] = ["image/jpeg", "image/png", "image/webp"];

export const IMAGE_CHAT_COPY = {
  replaceLabel: "Fotoğrafı değiştir",
  removeLabel: "Fotoğrafı kaldır",
  previewAlt: "Seçtiğin fotoğraf",
  sending: "Fotoğrafın sohbete gönderiliyor",
} as const;

export type ImageChatErrorKind = Exclude<ImageChatResult["status"], "created" | "login_required">;

export const IMAGE_CHAT_ERROR_COPY: Record<ImageChatErrorKind, string> = {
  invalid_type: "Bu dosya türünü kullanamıyoruz. JPEG, PNG ya da WebP bir fotoğraf dener misin?",
  too_large: "Fotoğraf çok büyük. 4 MB'tan küçük bir dosya dener misin?",
  unprocessable: "Bu görseli işleyemedik. Başka bir fotoğrafla yeniden dener misin?",
  rate_limited: "Kısa sürede çok fazla mesaj gönderdin. Biraz sonra tekrar dener misin?",
  unavailable: "Fotoğrafla sohbet şu an kullanılamıyor. Biraz sonra tekrar dener misin?",
  invalid_input: "Fotoğraf gönderilemedi. Tekrar dener misin?",
  error: "Bir şeyler ters gitti. Tekrar dener misin?",
};

/** Seçilen dosya sunucuya gitmeden önce yakalanır; `null` = uygun. */
export function validateAttachmentFile(file: {
  type: string;
  size: number;
}): ImageChatErrorKind | null {
  if (!IMAGE_CHAT_MIME_TYPES.includes(file.type)) return "invalid_type";
  if (file.size <= 0) return "invalid_type";
  if (file.size > IMAGE_CHAT_MAX_BYTES) return "too_large";
  return null;
}

/** Gonderim sonucu -> kullaniciya ne olacagi. Sonuc mesaj metni tasimaz. */
export type ImageChatOutcome =
  | { kind: "navigate"; href: string }
  | { kind: "login" }
  | { kind: "error"; message: string };

export function outcomeForResult(result: ImageChatResult): ImageChatOutcome {
  if (result.status === "created") return { kind: "navigate", href: result.href };
  if (result.status === "login_required") return { kind: "login" };
  return { kind: "error", message: IMAGE_CHAT_ERROR_COPY[result.status] };
}
