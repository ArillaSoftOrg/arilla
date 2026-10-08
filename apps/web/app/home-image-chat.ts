import type { NewTabChatResult } from "./sohbet/actions.ts";

/**
 * Sohbet mesajina gorsel eklemenin saf parcalari (karar 0078, 0079). Gorsel ayri bir
 * akis degil, normal mesajin ekidir; bu dosya yalnizca secim dogrulamasi, arayuz
 * metinleri ve sunucu sonucunun kullaniciya ne olacagini tarif eder.
 * Tarayici/React'a bagimli degildir; birim testlidir.
 */

/** `sohbet/actions.ts`, `packages/core` (`CHAT_UPLOAD_MAX_BYTES`) ve `next.config.ts` ile ayni sinir. */
export const IMAGE_CHAT_MAX_BYTES = 4 * 1024 * 1024;
export const IMAGE_CHAT_MIME_TYPES: readonly string[] = ["image/jpeg", "image/png", "image/webp"];

export const IMAGE_CHAT_COPY = {
  /** docs/copy.md `action.upload_photo`. */
  uploadLabel: "Fotoğraf yükle",
  replaceLabel: "Fotoğrafı değiştir",
  removeLabel: "Fotoğrafı kaldır",
  previewAlt: "Seçtiğin fotoğraf",
  /** Metin gonderimindeki "sohbet aciliyor" ile ayni metin (ayni gecis). */
  sending: "Sohbet açılıyor",
} as const;

export type ImageChatErrorKind =
  | "invalid_type"
  | "too_large"
  | "unprocessable"
  | "rate_limited"
  | "unavailable"
  | "invalid_input"
  | "image_limit"
  | "error";

export const IMAGE_CHAT_ERROR_COPY: Record<ImageChatErrorKind, string> = {
  invalid_type:
    "Bu dosya türünü kullanamıyoruz. jpg, png ya da webp uzantılı bir fotoğraf dener misin?",
  too_large: "Fotoğraf çok büyük. 4 MB'tan küçük bir dosya dener misin?",
  unprocessable: "Bu görseli işleyemedik. Başka bir fotoğrafla yeniden dener misin?",
  rate_limited: "Kısa sürede çok fazla mesaj gönderdin. Biraz sonra tekrar dener misin?",
  unavailable: "Fotoğrafla sohbet şu an kullanılamıyor. Biraz sonra tekrar dener misin?",
  invalid_input: "Fotoğraf gönderilemedi. Tekrar dener misin?",
  image_limit: "Bu sohbete daha fazla fotoğraf ekleyemezsin. Yeni bir sohbet başlatabilirsin.",
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

/**
 * Yeni sohbet sonucu -> kullaniciya ne olacagi (ana sayfa ayni-sekme yolu ve `/sohbet/yeni`
 * kabugu ortak kullanir). Sonuc mesaj metni tasimaz. Gorselli mesajda ASLA `/ara`ya dusulmez:
 * `fallback` yalniz metin mesajinda uretilir.
 */
export type NewChatOutcome =
  | { kind: "navigate"; href: string }
  /** Yalniz metin: sohbet kapali/tavan, yapay zekasiz `/ara` yolu (eski davranis). */
  | { kind: "fallback"; href: string }
  | { kind: "login" }
  /** `retry`: ayni mesaj ayni anahtarla yeniden gonderilebilir; degilse kullanici duzeltmeli. */
  | { kind: "error"; message: string; retry: boolean };

export function outcomeForNewChat(result: NewTabChatResult): NewChatOutcome {
  switch (result.status) {
    case "created":
      return { kind: "navigate", href: result.href };
    case "fallback":
      return { kind: "fallback", href: result.href };
    case "login_required":
      return { kind: "login" };
    case "image_rejected":
      return { kind: "error", message: IMAGE_CHAT_ERROR_COPY[result.reason], retry: false };
    case "rate_limited":
      return { kind: "error", message: IMAGE_CHAT_ERROR_COPY.rate_limited, retry: true };
    case "unavailable":
      return { kind: "error", message: IMAGE_CHAT_ERROR_COPY.unavailable, retry: false };
    default:
      return { kind: "error", message: IMAGE_CHAT_ERROR_COPY.error, retry: true };
  }
}
